/*
 * `[[` 提示的纯逻辑：判断"光标是不是刚打完 `[[`"，以及该列哪些候选。
 *
 * 为什么不用 CodeMirror 自带的 autocompletion：
 * 它的补全源、状态都能跑（startCompletion 返回 true），但 tooltip 在这个
 * webview 里始终不落地 —— 与其跟它的内部渲染较劲，不如自己画一个，
 * 和公式面板共用同一套"贴着光标浮出来"的做法。逻辑在这里，能单测。
 */

/** 一篇可被引用的对象：路径、标题、自己的小节 */
export type LinkTarget = { path: string; title: string; headings: string[] }

/** 光标前是不是一个还没收尾的 `[[` */
export type WikiQuery = {
  /** `[[` 这两个字符的起始位置（替换从这里开始） */
  from: number
  /** `[[` 之后已经打了什么 */
  typed: string
}

/** 一条候选：插进文档的是 `insert`，面板上显示的是 `label` + `detail` */
export type WikiItem = { label: string; detail: string; insert: string }

/**
 * 光标处是不是在输一个双链。
 *
 * 只往回看 200 个字符：双链不会长到哪去，而无上限的回溯在长文档上会卡。
 */
export function wikiQueryAt(text: string, pos: number): WikiQuery | null {
  const from = Math.max(0, pos - 200)
  const before = text.slice(from, pos)
  const m = /\[\[([^\[\]\n]*)$/.exec(before)
  if (!m) return null
  return { from: pos - m[0].length, typed: m[1] ?? '' }
}

/**
 * 该列哪些候选。
 *
 * 两种模式：
 *   ① 还没打 `#` —— 列篇名，按标题/路径过滤
 *   ② 打了 `#`   —— 列那一篇的小节，插出去是 `[[路径#小节]]`
 *
 * 第 ② 种要求前面那段真的能对上一篇；对不上就什么都不列（别拿别篇的小节骗人）。
 */
export function wikiOptions(targets: LinkTarget[], typed: string): WikiItem[] {
  const hashAt = typed.indexOf('#')

  if (hashAt >= 0) {
    const docPart = typed.slice(0, hashAt).trim()
    const hq = typed.slice(hashAt + 1)
    const doc =
      targets.find((t) => t.path === docPart) ??
      targets.find((t) => t.title === docPart) ??
      // 允许只打文件名不带目录：「周计划」对上「项目/周计划.md」
      targets.find((t) => t.path.replace(/\.md$/i, '').endsWith(`/${docPart}`))
    if (!doc) return []
    return doc.headings
      .filter((h) => !hq || h.includes(hq))
      .map((h) => ({
        label: `${doc.title} › ${h}`,
        detail: '跳到这一节',
        insert: `[[${doc.path}#${h}]]`,
      }))
  }

  const q = typed.trim()
  return targets
    .filter((t) => !q || t.title.includes(q) || t.path.includes(q))
    .slice(0, 30)
    .map((t) => ({ label: t.title, detail: t.path, insert: `[[${t.path}]]` }))
}
