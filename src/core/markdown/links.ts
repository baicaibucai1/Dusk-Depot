/*
 * 双链：`[[某篇]]`。纯函数。
 *
 * 名字怎么解析只有一处规矩：先认正文第一个 `#` 标题，再认文件名（去后缀）。
 * 这条和旧项目一致 —— 文件名是 `2026-10-17-雨天`，但人写链接只会写 `[[雨天]]`，
 * 所以他写的是标题，不是文件名。
 */
import type { FileMap } from '../model/library'
import { stemOf } from '../model/path'

const WIKI = /\[\[([^\]]+)\]\]/g

/** 一篇正文里指向的篇名。`[[名#小节|显示]]` 只取 `名` */
export function linkTargets(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(WIKI)) {
    const raw = m[1] ?? ''
    const name = (raw.split('|')[0] ?? '').split('#')[0]?.trim() ?? ''
    if (name) out.push(name)
  }
  return out
}

/** 这篇对外叫什么：正文第一个 h1 优先，没有就用文件名 */
export function titleOf(files: FileMap, path: string): string {
  const text = files[path] ?? ''
  const m = /^#\s+(.+)$/m.exec(text)
  return (m?.[1] ?? stemOf(path)).trim()
}

/** 一篇里的一条对外引用：双链（按名字）或标准链接（按路径） */
export type Ref = { kind: 'wiki' | 'path'; value: string }

const STD_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g
const EXTERNAL = /^(https?:|mailto:|data:|blob:|file:|#)/i

/**
 * 这篇往外指了哪些东西。
 * 双链 `[[名]]` 按**名字**记；标准链接 `[文字](路径)` 按**路径**记 —— 两种都算引用，
 * 因为写入新链接时用的是标准写法（别的 markdown 工具也认），旧的双链继续只读兼容。
 */
export function outgoingRefs(text: string): Ref[] {
  const out: Ref[] = []

  for (const m of text.matchAll(WIKI)) {
    const raw = m[1] ?? ''
    const name = (raw.split('|')[0] ?? '').split('#')[0]?.trim() ?? ''
    if (name) out.push({ kind: 'wiki', value: name })
  }

  for (const m of text.matchAll(STD_LINK)) {
    // `![](...)` 是图片，不是"引用某篇笔记"
    const at = m.index ?? 0
    if (at > 0 && text[at - 1] === '!') continue
    const href = (m[1] ?? '').trim()
    if (!href || EXTERNAL.test(href)) continue
    out.push({ kind: 'path', value: href.replace(/^\.\//, '') })
  }

  return out
}

/** 这条引用是不是指向 target */
export function refHits(files: FileMap, ref: Ref, target: string): boolean {
  // `.note` 是目录即文档：按路径或目录名都算
  if (target.toLowerCase().endsWith('.note')) {
    const norm = ref.value.replace(/^\.\//, '')
    const stem = target.split('/').pop()?.replace(/\.note$/i, '') ?? ''
    return norm === target || norm === `${target}.md` || norm === stem || (ref.kind === 'wiki' && ref.value === stem)
  }

  if (ref.kind === 'wiki') {
    const known = new Set([stemOf(target), titleOf(files, target)])
    return known.has(ref.value)
  }
  const asMd = /\.md$/i.test(ref.value) ? ref.value : `${ref.value}.md`
  return asMd === target || ref.value === target
}

/** 把标准链接里的相对路径解析成仓库里的文件（不认就返回 null） */
export function resolvePath(files: FileMap, href: string): string | null {
  const clean = href.replace(/^\.\//, '').split('#')[0]?.trim() ?? ''
  if (!clean) return null
  if (files[clean]) return clean
  if (files[`${clean}.md`]) return `${clean}.md`
  return null
}

export type Backlink = { path: string; quote: string }

/** 谁引用了这一篇。带上引用它的那一行，点回去才有落点 */
export function backlinksOf(files: FileMap, target: string): Backlink[] {
  const out: Backlink[] = []

  for (const [p, text] of Object.entries(files)) {
    if (p === target) continue
    const hit = outgoingRefs(text).find((r) => refHits(files, r, target))
    if (!hit) continue
    const needle = hit.kind === 'wiki' ? `[[${hit.value}` : `](${hit.value}`
    const line = text.split('\n').find((l) => l.includes(needle)) ?? ''
    out.push({ path: p, quote: line.trim().slice(0, 90) })
  }

  return out.sort((a, b) => a.path.localeCompare(b.path, 'zh'))
}

/** 这一篇指向了、但库里还没有的篇名 */
export function pendingLinksOf(files: FileMap, target: string): string[] {
  const known = new Set<string>()
  for (const p of Object.keys(files)) {
    known.add(stemOf(p))
    known.add(titleOf(files, p))
  }

  const out = new Set<string>()
  for (const r of outgoingRefs(files[target] ?? '')) {
    if (r.kind === 'wiki') {
      if (!known.has(r.value)) out.add(r.value)
    } else if (!resolvePath(files, r.value)) {
      out.add(r.value)
    }
  }
  return [...out]
}

/**
 * 把 `[[名]]` 解析成仓库里的路径。
 *
 * 认三种写法：直接写路径（`素材/语法速查`）、写文件名（`2026-10-17-雨天`）、
 * 写标题（`雨天`）。都不中就是"还没建的那篇"，返回 null。
 */
export function resolveWiki(files: FileMap, target: string): string | null {
  const name = (target.split('|')[0] ?? '').split('#')[0]?.trim() ?? ''
  if (!name) return null

  const asPath = name.replace(/\\/g, '/')
  if (files[asPath]) return asPath
  if (files[`${asPath}.md`]) return `${asPath}.md`

  for (const p of Object.keys(files)) {
    if (stemOf(p) === name || titleOf(files, p) === name) return p
  }
  return null
}

/** `[[某篇#小节]]` 里的小节名 */
export function wikiSection(target: string): string | null {
  const after = target.split('#')[1]
  return after ? (after.split('|')[0] ?? '').trim() || null : null
}