/*
 * 兜底：写进 localStorage。
 *
 * ⚠️ **这不是仓库**。它受配额限制、换浏览器就没了、也不在磁盘上。
 *    界面上必须把「暂存」两个字说在明处（capabilities.durable = false）。
 *
 * 存的是 `{ files, dirs }` 两半 —— 目录也要存，否则新建的空文件夹一刷新就没了，
 * 而"建了又消失"比"建不了"更让人怀疑程序。
 */
import type { Entry, Host } from '../core/ports/host'
import { decodeBytes, encodeText } from '../core/model/text'

const KEY = 'dusk.memory.repo.v2'
const OLD_KEY = 'dusk.memory.repo.v1'

type Blob = { files: Record<string, string>; dirs: string[] }

/** 二进制文件的存储前缀 */
const B64 = '\u0000b64:'

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function read(): Blob {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const v = JSON.parse(raw) as Partial<Blob>
      return {
        files: v.files && typeof v.files === 'object' ? v.files : {},
        dirs: Array.isArray(v.dirs) ? v.dirs : [],
      }
    }
    // 老版本只存了文件表，顺手接过来
    const old = localStorage.getItem(OLD_KEY)
    if (old) {
      const f = JSON.parse(old) as Record<string, string>
      return { files: f && typeof f === 'object' ? f : {}, dirs: [] }
    }
  } catch {
    // 被人手改坏了 —— 当作空仓库，总比整个应用打不开强
  }
  return { files: {}, dirs: [] }
}

function write(blob: Blob): void {
  localStorage.setItem(KEY, JSON.stringify(blob))
}

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`)

export function memoryHost(): Host {
  return {
    kind: 'memory',
    label: '浏览器暂存',
    where: '',
    capabilities: { pickDir: false, watch: false, durable: false, keychain: false },

    async list() {
      const { files, dirs } = read()
      return [
        ...dirs.map<Entry>((path) => ({ path, kind: 'dir', size: 0, mtime: 0 })),
        ...Object.entries(files).map<Entry>(([path, text]) => ({
          path,
          kind: 'file',
          size: encodeText(text).length,
          mtime: 0,
        })),
      ].sort((a, b) => a.path.localeCompare(b.path))
    },

    async read(path) {
      const v = read().files[path] ?? ''
      // 二进制（图片）存成 base64，避免被当成文本解码坏掉
      if (v.startsWith(B64)) return fromBase64(v.slice(B64.length))
      return encodeText(v)
    },

    async write(path, bytes) {
      const blob = read()
      const text = decodeBytes(bytes)
      // 能原样还原成文本就存文本，否则存 base64 —— 图片必须走后者
      const roundTrip = Array.from(encodeText(text))
      const same = roundTrip.length === bytes.length && roundTrip.every((b, i) => b === bytes[i])
      blob.files[path] = same ? text : B64 + toBase64(bytes)
      write(blob)
    },

    async remove(path) {
      const blob = read()
      for (const p of Object.keys(blob.files)) if (under(p, path)) delete blob.files[p]
      blob.dirs = blob.dirs.filter((d) => !under(d, path))
      write(blob)
    },

    async mkdir(path) {
      const blob = read()
      // 连父目录一起补上，否则只建了叶子、树上看不见中间那层
      const parts = path.split('/').filter(Boolean)
      let prefix = ''
      for (const seg of parts) {
        prefix = prefix ? `${prefix}/${seg}` : seg
        if (!blob.dirs.includes(prefix)) blob.dirs.push(prefix)
      }
      write(blob)
    },

    async rmdir(path) {
      const blob = read()
      blob.dirs = blob.dirs.filter((d) => !under(d, path))
      for (const p of Object.keys(blob.files)) if (under(p, path)) delete blob.files[p]
      write(blob)
    },
  }
}

/** 暂存是不是空的 —— 空的话可以塞一点出厂笔记进去 */
export function memoryIsEmpty(): boolean {
  const { files } = read()
  return Object.keys(files).length === 0
}

/**
 * 一次性塞一批进去。
 *
 * ⚠️ 别用循环调 `write`：`write` 是"读整份 → 改一条 → 写回"，
 *    两次并发就会互相覆盖（丢更新）。播种必须是一读一写。
 */
export function memorySeed(files: Record<string, string>): void {
  const blob = read()
  for (const [path, text] of Object.entries(files)) {
    blob.files[path] = text

    // 顺手把父目录补上 —— `.note` 是"目录即文档"，没有目录条目它就不存在
    const parts = path.split('/').slice(0, -1)
    let prefix = ''
    for (const seg of parts) {
      prefix = prefix ? `${prefix}/${seg}` : seg
      if (!blob.dirs.includes(prefix)) blob.dirs.push(prefix)
    }
  }
  write(blob)
}
