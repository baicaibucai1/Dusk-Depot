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

/**
 * 一条引用最后指向哪一篇。解析不到返回 null（那篇可能还没建）。
 *
 * `from` 是"从哪一篇出发" —— 有了它，`../开始这里.md` 和 `开始这里.md`
 * 才会被认成同一篇。少了它，子目录里的反向链接会整片消失（这个坑踩过）。
 */
export function refTarget(files: FileMap, ref: Ref, from?: string): string | null {
  return ref.kind === 'wiki'
    ? resolveWiki(files, ref.value)
    : resolvePath(files, ref.value, from)
}

/** 这条引用是不是指向 target */
export function refHits(files: FileMap, ref: Ref, target: string, from?: string): boolean {
  // `.note` 是目录即文档：按路径或目录名都算
  if (target.toLowerCase().endsWith('.note')) {
    const norm = ref.value.replace(/^\.\//, '')
    const stem = target.split('/').pop()?.replace(/\.note$/i, '') ?? ''
    return norm === target || norm === `${target}.md` || norm === stem || (ref.kind === 'wiki' && ref.value === stem)
  }

  // 先按真解析比：这一步才认 `../`、`./`、`/a/b.md` 和省略后缀
  const hit = refTarget(files, ref, from)
  if (hit) return hit === target

  // 解析不到时退回字面比对（那篇还没建，但还是要知道它想指谁）
  if (ref.kind === 'wiki') {
    const known = new Set([stemOf(target), titleOf(files, target)])
    return known.has(ref.value)
  }
  const asMd = /\.md$/i.test(ref.value) ? ref.value : `${ref.value}.md`
  return asMd === target || ref.value === target
}

/** 把相对路径归一：处理 `.` 与 `..`，返回从仓库根算的路径 */
export function normalizeRel(base: string, rel: string): string {
  const segs = (base ? base.split('/') : []).filter(Boolean)
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') segs.pop()
    else segs.push(part)
  }
  return segs.join('/')
}

/** 把标准链接里的相对路径解析成仓库里的文件（不认就返回 null） */
export function resolvePath(files: FileMap, href: string, from?: string): string | null {
  const raw = href.split('#')[0]?.trim() ?? ''
  if (!raw) return null

  /*
   * 相对路径按"从哪一篇出发"归一 —— `[回到开始](../开始这里.md)` 在子目录里是常事，
   * 只去掉 `./` 是不够的。绝对写法（`/a/b.md`）也认。
   * 两种候选都试：先按出发目录算，再按仓库根算（兼容老写法）。
   */
  const candidates: string[] = []
  if (raw.startsWith('/')) candidates.push(raw.slice(1))
  else {
    const dir = from && from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
    if (from) candidates.push(normalizeRel(dir, raw))
    candidates.push(raw.replace(/^\.\//, ''))
  }

  for (const clean of candidates) {
    // ⚠️ 不能用 `if (files[clean])` —— 空笔记（0 字节）的值是 ''，那是假值，
    //    会被当成"这篇不存在"。刚新建还没写的笔记正好是这种。
    if (Object.hasOwn(files, clean)) return clean
    if (Object.hasOwn(files, `${clean}.md`)) return `${clean}.md`
  }
  return null
}

export type Backlink = { path: string; quote: string }

/** 谁引用了这一篇。带上引用它的那一行，点回去才有落点 */
export function backlinksOf(files: FileMap, target: string): Backlink[] {
  const out: Backlink[] = []

  for (const [p, text] of Object.entries(files)) {
    if (p === target) continue
    // 出发路径必须传：不然 `../这篇.md` 一律认不出来
    const hit = outgoingRefs(text).find((r) => refHits(files, r, target, p))
    if (!hit) continue
    const needle = hit.kind === 'wiki' ? `[[${hit.value}` : `](${hit.value}`
    const line = text.split('\n').find((l) => l.includes(needle)) ?? ''
    out.push({ path: p, quote: line.trim().slice(0, 90) })
  }

  return out.sort((a, b) => a.path.localeCompare(b.path, 'zh'))
}

/** 这一篇指向谁（出链）。解析不到的那条 target 是 null，界面标成"还没建" */
export type OutLink = {
  /** 文里原样的写法 */
  href: string
  /** 落到哪一篇；null = 库里没有 */
  target: string | null
}

export function outgoingLinksOf(files: FileMap, path: string): OutLink[] {
  const out: OutLink[] = []
  const seen = new Set<string>()

  for (const r of outgoingRefs(files[path] ?? '')) {
    const key = `${r.kind}\u0000${r.value}`
    if (seen.has(key)) continue // 同一篇里引用两次只列一条
    seen.add(key)
    out.push({ href: r.value, target: refTarget(files, r, path) })
  }

  return out
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
    } else if (!resolvePath(files, r.value, target)) {
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
  // 用 hasOwn 而不是取真值：空笔记（0 字节）的内容是 ""，会被当成不存在
  if (Object.hasOwn(files, asPath)) return asPath
  if (Object.hasOwn(files, `${asPath}.md`)) return `${asPath}.md`

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