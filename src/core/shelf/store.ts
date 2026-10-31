/*
 * 书架落在哪儿 —— 设备级配置，跟仓库完全无关。
 *
 * 三种宿主：
 *   tauri  → 应用数据目录下的 `bookshelf`（或用户另选），真磁盘
 *   fsa    → 浏览器里用户授过权的目录句柄（存 IndexedDB）
 *   memory → 没得选时的兜底，**明确标注不落盘**
 *
 * ⚠️ 这份配置存 localStorage（`dusk.shelf.v1`），不进 `.zzq`：
 *    换仓库、搬仓库、重开应用都不该改变书架位置。
 */
import type { Host } from '../ports/host'
import { fsaHost, fsaPermission, hasFsa, pickFsaDir } from '../../hosts/fsa'
import { memoryHost } from '../../hosts/memory'
import { isTauri, pickTauriDir, tauriHost } from '../../hosts/tauri'

export const SHELF_KEY = 'dusk.shelf.v1'

export type ShelfKind = 'tauri' | 'fsa' | 'memory'

export type ShelfConfig =
  | { kind: 'tauri'; dir: string }
  | { kind: 'fsa'; dir: string }
  | { kind: 'memory'; dir: '' }

export type Shelf = {
  kind: ShelfKind
  /** 给人看的位置：桌面端是完整路径，浏览器是目录名 */
  where: string
  /** 内容真的在磁盘上 */
  durable: boolean
  /** 能不能"在资源管理器中查看" */
  canReveal: boolean
  host: Host
}

type DirHandle = NonNullable<Awaited<ReturnType<typeof pickFsaDir>>>

export function loadShelfConfig(): ShelfConfig | null {
  try {
    const raw = localStorage.getItem(SHELF_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<ShelfConfig>
    if (v.kind === 'tauri' && typeof v.dir === 'string' && v.dir) return { kind: 'tauri', dir: v.dir }
    if (v.kind === 'fsa' && typeof v.dir === 'string' && v.dir) return { kind: 'fsa', dir: v.dir }
    if (v.kind === 'memory') return { kind: 'memory', dir: '' }
    return null
  } catch {
    return null
  }
}

export function saveShelfConfig(cfg: ShelfConfig | null): void {
  try {
    if (!cfg) localStorage.removeItem(SHELF_KEY)
    else localStorage.setItem(SHELF_KEY, JSON.stringify(cfg))
  } catch {
    /* 存不了就只在这次会话里生效（界面会照实说） */
  }
}

/* ── 浏览器：目录句柄进 IndexedDB ── */

const IDB_NAME = 'dusk.depot'
const IDB_STORE = 'dirs'
const HANDLE_KEY = 'shelf:handle'

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
    }
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error ?? new Error('打不开 IndexedDB'))
  })
}

/*
 * 同一会话里也留一份。
 * 理由：IndexedDB 在某些环境（隐私模式、配额满）会写失败，但目录句柄**这次**
 * 明明还能用 —— 不该因为存不进去就当场变"权限丢了"。
 */
let memHandle: DirHandle | null = null

async function putHandle(h: DirHandle | null): Promise<void> {
  memHandle = h
  try {
    const db = await idb()
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      if (h) tx.objectStore(IDB_STORE).put(h, HANDLE_KEY)
      else tx.objectStore(IDB_STORE).delete(HANDLE_KEY)
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error ?? new Error('写 IndexedDB 失败'))
    })
    db.close()
  } catch {
    /* 存不进 IndexedDB 也能靠 memHandle 撑过这次会话 */
  }
}

async function getHandle(): Promise<DirHandle | null> {
  if (memHandle) return memHandle
  const db = await idb()
  const v = await new Promise<DirHandle | null>((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(HANDLE_KEY)
    req.onsuccess = () => res((req.result as DirHandle) ?? null)
    req.onerror = () => rej(tx.error ?? new Error('读 IndexedDB 失败'))
  })
  db.close()
  return v
}

/* ── 打开 ── */

export type OpenShelfResult =
  | { ok: true; shelf: Shelf }
  | { ok: false; reason: 'no-config' | 'unsupported' | 'permission' | 'missing'; error: string }

export async function openShelf(cfg: ShelfConfig | null): Promise<OpenShelfResult> {
  if (!cfg) return { ok: false, reason: 'no-config', error: '还没选书架目录' }

  if (cfg.kind === 'memory') {
    return {
      ok: true,
      shelf: {
        kind: 'memory',
        where: '暂存（不落盘）',
        durable: false,
        canReveal: false,
        host: memoryHost(),
      },
    }
  }

  if (cfg.kind === 'tauri') {
    if (!isTauri()) {
      return { ok: false, reason: 'unsupported', error: '这个书架位置是桌面端的，浏览器里打不开' }
    }
    const host = tauriHost(cfg.dir)
    try {
      await host.list()
    } catch (e) {
      return { ok: false, reason: 'missing', error: `书架目录读不了：${String(e)}` }
    }
    return { ok: true, shelf: { kind: 'tauri', where: cfg.dir, durable: true, canReveal: true, host } }
  }

  // fsa
  if (!hasFsa()) {
    return { ok: false, reason: 'unsupported', error: '这个浏览器不支持持久目录授权' }
  }
  const handle = await getHandle().catch(() => null)
  if (!handle) {
    return { ok: false, reason: 'permission', error: '书架目录的授权丢了，需要重新选一次' }
  }
  const perm = await fsaPermission(handle).catch(() => 'denied')
  if (perm !== 'granted') {
    return { ok: false, reason: 'permission', error: '书架目录的读写权限被收回了，点一下重新授权' }
  }
  return {
    ok: true,
    shelf: { kind: 'fsa', where: cfg.dir, durable: true, canReveal: false, host: fsaHost(handle) },
  }
}

/** 首次使用：桌面端直接用应用数据目录；浏览器必须让用户选 */
export async function defaultShelfConfig(): Promise<ShelfConfig | null> {
  if (isTauri()) {
    const { tauriShelfDir } = await import('../../hosts/tauri')
    const dir = await tauriShelfDir()
    return { kind: 'tauri', dir }
  }
  if (hasFsa()) return null
  return { kind: 'memory', dir: '' }
}

/** 让用户挑一个书架目录。返回 null = 取消 */
export async function pickShelfDir(): Promise<ShelfConfig | null> {
  if (isTauri()) {
    const dir = await pickTauriDir('选一个文件夹放书架（不要选当前仓库）')
    if (!dir) return null
    return { kind: 'tauri', dir }
  }
  if (!hasFsa()) return null
  const handle = await pickFsaDir()
  if (!handle) return null
  await putHandle(handle)
  return { kind: 'fsa', dir: handle.name ?? '书架' }
}

export async function rememberFsaShelf(cfg: ShelfConfig): Promise<void> {
  if (cfg.kind !== 'fsa') return
  // 句柄已经在 pickShelfDir 里存过；这里给"重新授权"留个口子
  const handle = await getHandle()
  if (handle) await putHandle(handle)
}
