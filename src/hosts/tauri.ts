/*
 * 桌面端：走 Rust 那组 `repo_*` 命令，真文件系统，没有同源策略这一说。
 *
 * ⚠️ `read` 要的是字节。Tauri 把 `Vec<u8>` 序列化成 number 数组，这里转回 Uint8Array ——
 *    笔记都是几 KB，这个开销可以接受；将来接附件（几 MB）要换成 base64 或自定义协议。
 */
import type { Entry, Host } from '../core/ports/host'

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const m = await import('@tauri-apps/api/core')
  return (await m.invoke(cmd, args)) as T
}

type RawEntry = { path: string; kind: string; size: number; mtime: number }

export function tauriHost(root: string): Host {
  const label = root.split(/[\\/]/).filter(Boolean).pop() ?? root

  return {
    kind: 'tauri',
    label,
    where: root,
    // watch 还没有接（文件被外部改动这件事暂时发现不了），所以照实写 false
    capabilities: { pickDir: true, watch: false, durable: true, keychain: true, reveal: true },

    async list() {
      const raw = await invoke<RawEntry[]>('repo_list', { root })
      return raw.map<Entry>((e) => ({
        path: e.path,
        kind: e.kind === 'dir' ? 'dir' : 'file',
        size: e.size,
        mtime: e.mtime,
      }))
    },

    read: async (path) => new Uint8Array(await invoke<number[]>('repo_read_bytes', { root, path })),

    write: async (path, bytes) =>
      invoke<void>('repo_write_bytes', { root, path, data: Array.from(bytes) }),

    remove: async (path) => invoke<void>('repo_remove', { root, path }),
    mkdir: async (path) => invoke<void>('repo_mkdir', { root, path }),
    rmdir: async (path) => invoke<void>('repo_rmdir', { root, path }),

    async stat(path) {
      try {
        const st = await invoke<RawEntry>('repo_stat', { root, path })
        return { size: st.size, mtime: st.mtime }
      } catch {
        return null
      }
    },

    async exists(path) {
      try {
        await invoke<RawEntry>('repo_stat', { root, path })
        return true
      } catch {
        return false
      }
    },

    move: async (from, to) => invoke<void>('repo_move', { root, from, to }),

    /*
     * 在资源管理器里定位。绝对路径**不给前端拼**：
     * 传进去的是 root + 相对路径，Rust 那边用同一套 join 做越界检查，
     * 再交给官方 Opener 插件。
     */
    reveal: async (path) => invoke<void>('fs_reveal', { root, path }),
  }
}

/** 弹系统目录选择框。取消返回 null */
export async function pickTauriDir(title = '选一个文件夹当仓库'): Promise<string | null> {
  const m = await import('@tauri-apps/plugin-dialog')
  const picked = await m.open({ directory: true, multiple: false, title })
  return typeof picked === 'string' ? picked : null
}

/** 弹系统文件选择框（多选）。取消返回空数组 */
export async function pickTauriFiles(title: string, filters: { name: string; extensions: string[] }[]): Promise<string[]> {
  const m = await import('@tauri-apps/plugin-dialog')
  const picked = await m.open({ multiple: true, title, filters, directory: false })
  if (!picked) return []
  return Array.isArray(picked) ? picked.filter((p): p is string => typeof p === 'string') : [picked]
}

/** 程序自带的数据目录下的 `repo`。只有桌面端有这个概念 */
export async function tauriDefaultDir(): Promise<string> {
  return invoke<string>('repo_default_dir', {})
}

/** 书架默认目录：应用数据目录下的 `bookshelf`（跟仓库是兄弟，不在仓库里） */
export async function tauriShelfDir(): Promise<string> {
  return invoke<string>('shelf_default_dir', {})
}

export type PathStat = { name: string; size: number; mtime: number }

/** 拖进来的文件先问大小，别一上来就读几 MB 的字节 */
export async function statPath(src: string): Promise<PathStat> {
  return invoke<PathStat>('fs_stat', { src })
}

/** 把外部文件复制进 root 下的 dest（相对路径，不覆盖） */
export async function importPath(src: string, root: string, dest: string): Promise<PathStat> {
  return invoke<PathStat>('fs_import_file', { src, root, dest })
}

/** 书架搬家：整棵目录复制到新位置（不删旧的） */
export async function copyShelfTree(from: string, to: string): Promise<number> {
  return invoke<number>('shelf_copy_tree', { from, to })
}
