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
    capabilities: { pickDir: true, watch: false, durable: true, keychain: true },

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
  }
}

/** 弹系统目录选择框。取消返回 null */
export async function pickTauriDir(): Promise<string | null> {
  const m = await import('@tauri-apps/plugin-dialog')
  const picked = await m.open({ directory: true, multiple: false, title: '选一个文件夹当仓库' })
  return typeof picked === 'string' ? picked : null
}

/** 程序自带的数据目录下的 `repo`。只有桌面端有这个概念 */
export async function tauriDefaultDir(): Promise<string> {
  return invoke<string>('repo_default_dir', {})
}
