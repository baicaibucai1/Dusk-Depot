/*
 * 附件（图床）。
 *
 * 图片不是 markdown，得单独存一份：放仓库里的 `附件/` 目录，
 * 正文里只留一条相对引用 `![](附件/xxx.png)` —— 笔记仍然是**普通 markdown**，
 * 别的编辑器打开也能看到这条引用（图片文件跟着走）。
 */
import { normalizePath } from './path'

/** 图床目录（仓库内相对路径） */
export const ATTACH_DIR = '附件'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name)
}

/** 从 MIME 猜扩展名（剪贴板里常常没有文件名） */
export function extOfMime(mime: string): string {
  if (/png/i.test(mime)) return 'png'
  if (/jpe?g/i.test(mime)) return 'jpg'
  if (/gif/i.test(mime)) return 'gif'
  if (/webp/i.test(mime)) return 'webp'
  if (/avif/i.test(mime)) return 'avif'
  if (/bmp/i.test(mime)) return 'bmp'
  if (/svg/i.test(mime)) return 'svg'
  return 'png'
}

/** 把原始文件名洗成安全的：去掉路径分隔符和空白，保留中文 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[\s]+/g, '-').replace(/[^\w.\-\u4e00-\u9fa5]/g, '')
  return cleaned || 'image'
}

/**
 * 生成图床里的文件名。
 * 带时间戳 + 随机后缀：同名粘贴两次不会互相覆盖（覆盖就是丢数据）。
 */
export function attachName(original: string, mime: string, now = new Date()): string {
  const safe = safeFileName(original)
  const hasExt = IMAGE_EXT.test(safe)
  const stem = hasExt ? safe.replace(IMAGE_EXT, '') : safe.replace(/\.[^.]+$/, '')
  const ext = hasExt ? (IMAGE_EXT.exec(safe)?.[0] ?? '.png').slice(1).toLowerCase() : extOfMime(mime)

  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  const rand = Math.random().toString(36).slice(2, 6)

  return `${stem || '图片'}-${stamp}-${rand}.${ext}`
}

/** 图床里的完整相对路径 */
export function attachPath(fileName: string): string {
  return normalizePath(`${ATTACH_DIR}/${fileName}`)
}

/**
 * 从正文里找出引用的图片路径（只挑**仓库内的相对路径**，跳过 http/data/blob）。
 * 用来决定要预加载哪些图。
 */
export function imageRefs(markdown: string): string[] {
  const out = new Set<string>()
  const re = /!\[[^\]]*\]\(([^)\n]+)\)/g
  for (const m of markdown.matchAll(re)) {
    const src = (m[1] ?? '').trim()
    if (!src) continue
    if (/^(https?:|data:|blob:|file:)/i.test(src)) continue
    out.add(src.replace(/^\.\//, ''))
  }
  return [...out]
}
