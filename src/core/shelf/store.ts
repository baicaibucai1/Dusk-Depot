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
 *
 * ## 选目录 = 两阶段
 *
 *   pickShelfTarget()  只把新句柄拿在手里，**不碰 IndexedDB、不碰配置**；
 *   commitShelfTarget() 才是"真的换过去"。
 *
 * 以前是选完立刻 putHandle —— 用户点了取消，真实句柄已经换了，
 * 重启后界面显示旧目录、读写却指向新目录。这是数据安全问题，不是体验问题。
 */
import type { Host } from '../ports/host'
import { fsaGrant, fsaHost, fsaPermission, hasFsa, pickFsaDir } from '../../hosts/fsa'
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
  /** `where` 只是目录名（浏览器拿不到完整路径） */
  nameOnly: boolean
  /** 内容真的在磁盘上 */
  durable: boolean
  /** 能不能"在资源管理器中查看" */
  canReveal: boolean
  host: Host
  /** 浏览器专用：目录句柄。重新授权、同目录判定都要用 */
  handle?: DirHandle
  /** 这份配置的稳定身份（kind + 位置）。切目录后旧任务靠它拒写 */
  identity: string
}

/** 浏览器目录句柄的最小结构。`isSameEntry` / `resolve` 是可选的（Safari 没有） */
export type DirHandle = {
  name: string
  isSameEntry?: (other: DirHandle) => Promise<boolean>
  resolve?: (child: DirHandle) => Promise<string[] | null>
}

/** 用户新挑的位置 —— **还没提交** */
export type ShelfTarget = {
  cfg: ShelfConfig
  /** 浏览器：暂存句柄，此刻 IndexedDB 里还是旧句柄 */
  handle?: DirHandle
  /** 展示名 */
  label: string
  /** 只能显示目录名 */
  nameOnly: boolean
}

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

export function saveShelfConfig(cfg: ShelfConfig | null): boolean {
  try {
    if (!cfg) localStorage.removeItem(SHELF_KEY)
    else localStorage.setItem(SHELF_KEY, JSON.stringify(cfg))
    return true
  } catch {
    /* 存不了就只在这次会话里生效（界面会照实说） */
    return false
  }
}

export function identityOf(cfg: ShelfConfig): string {
  return `${cfg.kind}:${cfg.dir}`
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

/** 写句柄。返回是否真的落进 IndexedDB（false = 只能撑本次会话） */
async function putHandle(h: DirHandle | null): Promise<boolean> {
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
    return true
  } catch {
    /* 存不进 IndexedDB 也能靠 memHandle 撑过这次会话 */
    return false
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
  | {
      ok: false
      reason: 'no-config' | 'unsupported' | 'permission' | 'missing'
      error: string
      /** 能不能由用户点一下"重新授权"救回来（浏览器句柄还在） */
      canRegrant?: boolean
    }

/** 按句柄开书架（不读 IndexedDB）。`handle` 由调用方给 —— 暂存句柄也走这里 */
export async function openShelfWithHandle(cfg: ShelfConfig, handle: DirHandle): Promise<OpenShelfResult> {
  if (!hasFsa()) {
    return { ok: false, reason: 'unsupported', error: '这个浏览器不支持持久目录授权' }
  }
  const perm = await fsaPermission(handle as never).catch(() => 'denied')
  if (perm !== 'granted') {
    return {
      ok: false,
      reason: 'permission',
      error:
        perm === 'prompt'
          ? '浏览器把书架目录的权限收回了，点「重新授权」再试'
          : '书架目录的读写权限被拒绝了，可以重新选一个目录',
      canRegrant: perm === 'prompt',
    }
  }
  return {
    ok: true,
    shelf: {
      kind: 'fsa',
      where: cfg.dir,
      nameOnly: true,
      durable: true,
      canReveal: false,
      host: fsaHost(handle as never),
      handle,
      identity: identityOf(cfg),
    },
  }
}

export async function openShelf(cfg: ShelfConfig | null): Promise<OpenShelfResult> {
  if (!cfg) return { ok: false, reason: 'no-config', error: '还没选书架目录' }

  if (cfg.kind === 'memory') {
    return {
      ok: true,
      shelf: {
        kind: 'memory',
        where: '暂存（不落盘）',
        nameOnly: false,
        durable: false,
        canReveal: false,
        host: memoryHost(),
        identity: identityOf(cfg),
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
    return {
      ok: true,
      shelf: { kind: 'tauri', where: cfg.dir, nameOnly: false, durable: true, canReveal: true, host, identity: identityOf(cfg) },
    }
  }

  // fsa
  if (!hasFsa()) {
    return { ok: false, reason: 'unsupported', error: '这个浏览器不支持持久目录授权' }
  }
  const handle = await getHandle().catch(() => null)
  if (!handle) {
    return { ok: false, reason: 'permission', error: '书架目录的授权丢了，需要重新选一次' }
  }
  return openShelfWithHandle(cfg, handle)
}

/** 打开一个**还没提交**的目标目录：不读也不写 IndexedDB 配置 */
export async function openShelfTarget(t: ShelfTarget): Promise<OpenShelfResult> {
  if (t.cfg.kind === 'fsa') {
    if (!t.handle) return { ok: false, reason: 'permission', error: '没有拿到目录句柄' }
    return openShelfWithHandle(t.cfg, t.handle)
  }
  return openShelf(t.cfg)
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

/**
 * 让用户挑一个书架目录。返回的是**暂存目标** ——
 * 只有调用 `commitShelfTarget` 之后，配置和句柄才真的换过去。
 */
export async function pickShelfTarget(): Promise<ShelfTarget | null> {
  if (isTauri()) {
    const dir = await pickTauriDir('选一个文件夹放书架（不要选当前仓库）')
    if (!dir) return null
    return { cfg: { kind: 'tauri', dir }, label: dir, nameOnly: false }
  }
  if (!hasFsa()) return null
  const handle = (await pickFsaDir()) as DirHandle | null
  if (!handle) return null
  return {
    cfg: { kind: 'fsa', dir: handle.name || '书架' },
    handle,
    label: handle.name || '书架',
    nameOnly: true,
  }
}

/**
 * 提交新位置。**句柄先落库，再写配置**：
 * 反过来的话，配置指到新目录而句柄还是旧的，重启就"界面新、读写旧"。
 */
export async function commitShelfTarget(t: ShelfTarget): Promise<{ configSaved: boolean; handleSaved: boolean }> {
  let handleSaved = true
  let previous: DirHandle | null = null
  if (t.cfg.kind === 'fsa' && t.handle) {
    // 先记下旧句柄：配置写失败时要退回去，不能让"配置指旧目录、句柄指新目录"
    previous = await getHandle().catch(() => null)
    handleSaved = await putHandle(t.handle)
  }
  const configSaved = saveShelfConfig(t.cfg)
  if (!configSaved && t.cfg.kind === 'fsa') await putHandle(previous)
  return { configSaved, handleSaved }
}

/** 重新授权：**必须**由一次用户点击带进来（requestPermission 要用户手势） */
export async function regrantShelf(): Promise<boolean> {
  const handle = await getHandle().catch(() => null)
  if (!handle) return false
  return fsaGrant(handle as never).catch(() => false)
}

/** 当前句柄还在不在（给"重试"用：能读到句柄就说明还有救） */
export async function hasShelfHandle(): Promise<boolean> {
  return Boolean(await getHandle().catch(() => null))
}

export async function rememberFsaShelf(cfg: ShelfConfig): Promise<void> {
  if (cfg.kind !== 'fsa') return
  // 句柄已经在 pickShelfDir 里存过；这里给"重新授权"留个口子
  const handle = await getHandle()
  if (handle) await putHandle(handle)
}
