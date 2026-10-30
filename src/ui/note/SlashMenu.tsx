/*
 * 斜杠菜单（输入 `/` 弹出的块类型选择器）。
 *
 * 只做三件事：按 query 过滤、上下键选、回车插入。
 * 位置用 `coordsAtPos` 算，所以它跟着光标走；滚动 / 缩放时重算。
 */
import type { Editor } from '@tiptap/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { searchBlocks, type BlockSpec } from './blocks'
import { insertFlowBlock } from './flowCommands'
import { type SlashState, closeSlash, slashClosed, slashStateOf } from './slash'

const W = 292
const H = 336

export function SlashMenu({ editor }: { editor: Editor | null }) {
  const [state, setState] = useState<SlashState>(slashClosed)
  const [index, setIndex] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const items = useMemo(() => searchBlocks(state.open ? state.query : ''), [state])
  const query = state.open ? state.query : ''

  /* 每次 transaction 都同步一次 —— 菜单的开/关/query 全在插件里算 */
  useEffect(() => {
    if (!editor) return
    const sync = () => setState(slashStateOf(editor.state))
    sync()
    editor.on('transaction', sync)
    return () => {
      editor.off('transaction', sync)
    }
  }, [editor])

  useEffect(() => {
    setIndex(0)
  }, [query, state.open])

  /* 位置：光标下方；下面放不下就翻到上面 */
  useEffect(() => {
    if (!editor || !state.open) {
      setPos(null)
      return
    }
    const place = () => {
      if (editor.isDestroyed) return
      const c = editor.view.coordsAtPos(state.from)
      const left = Math.min(Math.max(8, c.left), Math.max(8, window.innerWidth - W - 8))
      const below = c.bottom + 8
      const top = below + H > window.innerHeight ? Math.max(8, c.top - H - 8) : below
      setPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [editor, state])

  const pick = (spec: BlockSpec | undefined) => {
    if (!editor || !state.open || !spec) return
    const range = { from: state.from, to: state.to }
    closeSlash(editor.view)
    insertFlowBlock(editor, spec.kind, range)
  }

  /* 键盘：捕获阶段拦下来，别让 ProseMirror 先吃掉回车 */
  useEffect(() => {
    if (!state.open || !editor) return
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        if (items.length === 0) return
        setIndex((i) => (e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        pick(items[index])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeSlash(editor.view)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!state.open || !pos) return null

  let lastGroup = ''

  return (
    <div
      data-dd-slash=""
      role="listbox"
      aria-label="插入块"
      className="dd-pop dd-slash"
      style={{ left: pos.left, top: pos.top, width: W, maxHeight: H }}
    >
      <div className="dd-pop-head">
        <span>插入块</span>
        <span className="dd-pop-hint">↑↓ 选择 · ↵ 插入 · esc 关闭</span>
      </div>

      <div className="dd-slash-list" ref={listRef}>
        {items.length === 0 ? (
          <p className="dd-slash-empty">没有匹配的块</p>
        ) : (
          items.map((s, i) => {
            const head = s.group !== lastGroup ? s.group : ''
            lastGroup = s.group
            return (
              <div key={s.kind}>
                {head ? <div className="dd-slash-group">{head}</div> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  data-active={i === index ? 'true' : undefined}
                  className="dd-slash-item"
                  onMouseEnter={() => setIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pick(s)
                  }}
                >
                  <span className="dd-slash-glyph">{s.glyph}</span>
                  <span className="dd-slash-label">{s.label}</span>
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
