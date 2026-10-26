/*
 * 浏览器：File System Access。
 *
 * ⚠️ 只有 Chromium 系有 `showDirectoryPicker`。Safari / Firefox 拿不到目录句柄，
 *    那条路只能退回 memory（见 hosts/memory.ts），界面上必须照实说。
 *
 * ⚠️ 活句柄不能序列化进 localStorage，所以目录句柄放 IndexedDB —— 这是整个应用
 *    唯一需要 IndexedDB 的地方（见 docs/philosophy.md 那条红线）。
 */
import type { Entry, Host } from '../core/ports/host'

type Dir = {
  name: string
  values(): AsyncIterableIterator<{ name: string; kind: 'file' | 'directory' }>
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<Dir>
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>
  queryPermission(o?: { mode: string }): Promise<string>
  requestPermission(o?: { mode: string }): Promise<string>
}

type FileHandle = {
  getFile(): Promise<File>
  createWritable(): Promise<{ write(d: Blob | string | ArrayBuffer): Promise<void>; close(): Promise<void> }>
}

const IDB_NAME = 'dusk.depot'
const IDB_STORE = 'dirs'

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

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb()
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error ?? new Error('写 IndexedDB 失败'))
  })
  db.close()
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await idb()
  const v = await new Promise<T | null>((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).get(key)
    req.onsuccess = () => res((req.result as T) ?? null)
    req.onerror = () => rej(tx.error ?? new Error('读 IndexedDB 失败'))
  })
  db.close()
  return v
}

export function hasFsa(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/** 弹系统目录选择框。**必须在用户手势里调**，取消返回 null、其它失败照抛 */
export async function pickFsaDir(): Promise<Dir | null> {
  const w = window as unknown as { showDirectoryPicker(o?: { mode?: string }): Promise<Dir> }

  let handle: Dir
  try {
    handle = await w.showDirectoryPicker({ mode: 'readwrite' })
  } catch (e) {
    // 只有"用户点了取消"才算安静地什么都不做；别的失败必须往上抛，
    // 否则界面上表现为"选了文件夹却毫无反应"——那种症状最难查。
    if (e instanceof DOMException && e.name === 'AbortError') return null
    throw e
  }

  /*
   * 存句柄只是"下次还能找到它"。存不进去（隐私模式 / 内嵌 webview 禁用 IndexedDB）
   * **不该把已经选好的文件夹作废** —— 本次照样能读写，只是下次要重选。
   * 以前这里一抛就把用户打回选择页，看起来就是"选了没反应"。
   */
  try {
    await idbSet(handle.name, handle)
  } catch (e) {
    console.warn('[dusk] 记不住这个文件夹（IndexedDB 不可用），本次仍可用', e)
  }
  return handle
}

/** 按名字取回上回那个目录句柄（不碰权限） */
export async function fsaHandleByName(name: string): Promise<Dir | null> {
  return idbGet<Dir>(name)
}

/** 当前权限状态：granted / prompt / denied */
export async function fsaPermission(handle: Dir): Promise<string> {
  try {
    return await handle.queryPermission({ mode: 'readwrite' })
  } catch {
    return 'denied'
  }
}

/**
 * 要一次写权限。
 *
 * ⚠️ 刷新之后句柄还在，但权限会退回 `prompt`，而**要权限必须有用户手势** ——
 *    所以这一步不能放在启动流程里偷偷跑，只能由界面上的一次点击带进来。
 */
export async function fsaGrant(handle: Dir): Promise<boolean> {
  const q = await fsaPermission(handle)
  if (q === 'granted') return true
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
}

async function sub(dir: Dir, parts: string[], create: boolean): Promise<Dir> {  let cur = dir
  for (const seg of parts) {
    cur = await cur.getDirectoryHandle(seg, create ? { create: true } : undefined)
  }
  return cur
}

function split(path: string): { parts: string[]; name: string } {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop() ?? path
  return { parts, name }
}

/** 依赖 / 构建 / 系统目录：笔记库里没有意义，走进去就是几千个文件 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'target', 'dist', 'build', '.next', '.nuxt',
  '.cache', '.venv', '__pycache__', '$RECYCLE.BIN', 'System Volume Information',
])

/** 一个仓库的条目上限。到顶就明说，别让人对着"正在读取…"干等 */
const MAX_ENTRIES = 20000

function tooBig(): Error {
  return new Error(
    `这个文件夹太大了（超过 ${MAX_ENTRIES} 项）。请选一个笔记文件夹，不要选整个磁盘或项目根目录。`,
  )
}

export function fsaHost(handle: Dir): Host {
  return {
    kind: 'fsa',
    label: handle.name,
    where: handle.name,
    capabilities: { pickDir: true, watch: false, durable: true, keychain: false },

    async list() {
      const out: Entry[] = []
      async function walk(dir: Dir, prefix: string) {
        for await (const item of dir.values()) {
          const path = prefix ? `${prefix}/${item.name}` : item.name
          if (item.kind === 'directory') {
            // 依赖 / 构建 / 系统目录：笔记库里不会有人要管它们，
            // 走进去就是几千个文件，读半天还只是噪音
            if (SKIP_DIRS.has(item.name)) continue
            out.push({ path, kind: 'dir', size: 0, mtime: 0 })
            if (out.length > MAX_ENTRIES) throw tooBig()
            await walk(await dir.getDirectoryHandle(item.name), path)
          } else {
            /*
             * ⚠️ 这里**不调 getFile()**。
             *    为了拿 size/mtime 给每个文件开一次句柄，在一个几千文件的目录上
             *    会把"选完文件夹"变成几十秒的假死（界面上就是"没反应"）。
             *    体积上限改由读取之后按字节数判断（见 App 的 readRepo）。
             */
            out.push({ path, kind: 'file', size: 0, mtime: 0 })
            if (out.length > MAX_ENTRIES) throw tooBig()
          }
        }
      }
      await walk(handle, '')
      return out.sort((a, b) => a.path.localeCompare(b.path))
    },

    async read(path) {
      const { parts, name } = split(path)
      const dir = await sub(handle, parts, false)
      const fh = await dir.getFileHandle(name)
      return new Uint8Array(await (await fh.getFile()).arrayBuffer())
    },

    async write(path, bytes) {
      const { parts, name } = split(path)
      const dir = await sub(handle, parts, true)
      const fh = await dir.getFileHandle(name, { create: true })
      const w = await fh.createWritable()
      try {
        await w.write(new Blob([bytes as unknown as BlobPart]))
      } finally {
        await w.close()
      }
    },

    async remove(path) {
      const { parts, name } = split(path)
      const dir = await sub(handle, parts, false)
      await dir.removeEntry(name, { recursive: true })
    },

    async mkdir(path) {
      await sub(handle, path.split('/').filter(Boolean), true)
    },

    async rmdir(path) {
      const { parts, name } = split(path)
      const dir = await sub(handle, parts, false)
      await dir.removeEntry(name, { recursive: true })
    },
  }
}
