/*
 * 斜杠菜单的触发状态（ProseMirror 插件，不是 React 状态）。
 *
 * 为什么放插件里：光靠 React 盯 `editor.on('update')` 分不清"用户刚敲了个 /"
 * 和"打开文档时正文里本来就有个 /"；也分不清"斜杠是在输入法合成期间塞进来的"。
 * 插件能看到每一个 transaction，这两件事都能判准。
 *
 * 三条硬规矩：
 *   ① 只有**刚敲下 `/` 那一下**才开菜单（打开旧文档不会自己弹）；
 *   ② 中文输入法合成期间一律返回关闭 —— 合成里出现的 `/` 是候选词的字符，不是命令；
 *   ③ `/` 前面必须是行首或空白 —— 否则 `2026/10` 这种日期会误触发。
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'

export type SlashState =
  | { open: false }
  | { open: true; from: number; to: number; query: string; blockStart: number }

export const slashClosed: SlashState = { open: false }
export const slashKey = new PluginKey<SlashState>('ddSlash')

/** 输入法合成中（由 FlowNote 的 DOM 事件维护） */
export const composing = { current: false }

function typedSlash(steps: readonly unknown[]): boolean {
  for (const s of steps) {
    if (!(s instanceof ReplaceStep)) continue
    if (s.from !== s.to) continue
    if (s.slice.content.size !== 1) continue
    if (s.slice.content.textBetween(0, 1, '\ufffc') === '/') return true
  }
  return false
}

function compute(tr: { steps: readonly unknown[] }, prev: SlashState, next: EditorState): SlashState {
  if (composing.current) return slashClosed

  const { $from, empty } = next.selection
  if (!empty) return slashClosed
  if ($from.parent.type.spec.code) return slashClosed
  if (!$from.parent.isTextblock) return slashClosed

  const blockStart = $from.start()

  if (prev.open) {
    if (blockStart !== prev.blockStart) return slashClosed
    const fromOffset = prev.from - blockStart
    if (fromOffset < 0 || $from.parentOffset < fromOffset) return slashClosed

    const text = $from.parent.textBetween(fromOffset, $from.parentOffset, undefined, '\ufffc')
    if (!text.startsWith('/')) return slashClosed
    const query = text.slice(1)
    if (query.length > 24 || /\s/.test(query)) return slashClosed
    return { open: true, from: prev.from, to: $from.pos, query, blockStart }
  }

  if (!typedSlash(tr.steps)) return slashClosed

  const offset = $from.parentOffset
  if (offset === 0) return slashClosed
  const before = $from.parent.textBetween(0, offset, undefined, '\ufffc')
  if (!before.endsWith('/')) return slashClosed

  const prevChar = before.slice(-2, -1)
  if (prevChar && !/\s/.test(prevChar)) return slashClosed

  return { open: true, from: $from.pos - 1, to: $from.pos, query: '', blockStart }
}

export const SlashTrigger = Extension.create({
  name: 'ddSlash',
  addProseMirrorPlugins() {
    return [
      new Plugin<SlashState>({
        key: slashKey,
        state: {
          init: () => slashClosed,
          apply(tr, prev, _old, next) {
            const meta = tr.getMeta(slashKey) as { close?: boolean } | undefined
            if (meta?.close) return slashClosed
            return compute(tr, prev, next)
          },
        },
      }),
    ]
  },
})

export function slashStateOf(state: EditorState): SlashState {
  return slashKey.getState(state) ?? slashClosed
}

export function closeSlash(view: EditorView): void {
  if (!slashStateOf(view.state).open) return
  view.dispatch(view.state.tr.setMeta(slashKey, { close: true }))
}
