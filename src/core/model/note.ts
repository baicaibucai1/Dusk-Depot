/*
 * 笔记 / 文件夹的命名规则。纯函数、零依赖。
 *
 * 两条硬规矩：
 *   ① 名字要能在 Windows 上活下来（非法字符、尾部点、超长）
 *   ② **重名绝不覆盖** —— 撞了加 `-2` / `-3`。覆盖一次就是丢一篇。
 */
import { extOf, stemOf } from './path'

/** 单个名字的码点上限。整条路径还要留余量给父目录 */
const MAX_NAME = 60

/** Windows 上不许出现在文件名里的字符 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符正是要挡的那一类
const BAD = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * 把一段用户输入变成安全的文件名（不含目录、不含后缀）。
 * 中文原样保留 —— 这是我们和"英文 slug"路线最不一样的地方。
 */
export function sanitizeName(raw: string): string {
  const s = raw
    .replace(BAD, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows 不允许以点或空格结尾
    .replace(/[. ]+$/, '')

  // 按码点截断，不能把 emoji 劈成两半
  const points = [...s]
  return points.length > MAX_NAME ? points.slice(0, MAX_NAME).join('') : s
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** 新建笔记的目标路径。标题空着就叫「未命名」 */
export function notePath(dir: string, title: string): string {
  const name = sanitizeName(title) || '未命名'
  return joinPath(dir, `${name}.md`)
}

/** 新建文件夹的目标路径 */
export function folderPath(dir: string, name: string): string {
  return joinPath(dir, sanitizeName(name) || '新建文件夹')
}

/**
 * 撞名就加 `-2` / `-3`，**绝不覆盖**。
 * `exists` 交给调用方（它同时看文件表和目录表）。
 */
export function uniquePath(path: string, exists: (p: string) => boolean): string {
  if (!exists(path)) return path

  const ext = extOf(path)
  const stem = ext ? path.slice(0, path.length - ext.length) : path

  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!exists(candidate)) return candidate
  }
  throw new Error(`重名太多，放弃了：${path}`)
}

/** 改名时用：用户只给了个名字，后缀沿用旧的 */
export function withSameExt(rawName: string, oldPath: string): string {
  const name = sanitizeName(rawName)
  if (!name) return ''
  const oldExt = extOf(oldPath)
  return extOf(name) ? name : `${name}${oldExt}`
}

/** 一篇笔记的标题：正文第一个 h1，没有就用文件名 */
export function titleOfText(text: string, path: string): string {
  const m = /^#\s+(.+)$/m.exec(text)
  return (m?.[1] ?? stemOf(path)).trim()
}
