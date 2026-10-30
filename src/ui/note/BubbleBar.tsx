/*
 * 选中文字后浮出来的格式条。
 *
 * 位置：选区上方；上方放不下就翻到下方 ——
 * 绝不压在选中的文字上（那是"点了按钮才发现自己选的字被盖住"的来源）。
 */
import type { Editor } from '@tiptap/core'
import { useEffect, useRef, useState } from 'react'

type Sel = { from: number; to: number; left: number; top: number; below: boolean }

const W = 246

function selectionBox(editor: Editor): Sel | null {
  const { state, view } = editor
  const { from, to, empty } = state.selection
  if (empty || from === to) return null

  const $from = state.doc.resolve(from)
  if ($from.parent.type.spec.code) return null

  const a = view.coordsAtPos(from)
  const b = view.coordsAtPos(to)

  /*
   * 上下都得让着"编辑区可见范围"：
   * 上面放不下就翻到选区下面，下面也放不下就贴住底边 —— 别让工具条被裁掉半截。
   */
  const scroll = view.dom.closest('[data-dd-flow-scroll]') as HTMLElement | null
  const box = scroll?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
  const selTop = Math.min(a.top, b.top)
  const selBottom = Math.max(a.bottom, b.bottom)

  const H = 34
  const spaceAbove = selTop - box.top
  const spaceBelow = box.bottom - selBottom

  /*
   * 默认放选区上方（跟绝大多数编辑器一致）。
   * 只有当上面**根本放不下**（贴着编辑区顶边、会被裁掉）时才翻到下方。
   * 压住上一行的尾巴是浮层的常态 —— 但不能压住你选中的那些字。
   */
  const above = selTop - H - 10
  const below = spaceAbove < H + 12 && spaceBelow > H + 12

  const raw = below ? selBottom + 8 : above
  const top = Math.min(Math.max(raw, box.top + 4), Math.max(box.top + 4, box.bottom - H - 4))
  const left = Math.min(Math.max(8, Math.min(a.left, b.left)), Math.max(8, window.innerWidth - W - 8))
  return { from, to, left, top, below }
}

export function BubbleBar({
  editor,
  notes,
}: {
  editor: Editor | null
  notes?: { path: string; title: string }[]
}) {
  const [sel, setSel] = useState<Sel | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [href, setHref] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const keep = useRef<Sel | null>(null)

  useEffect(() => {
    if (!editor) return
    const sync = () => {
      if (linkOpen) return
      setSel(selectionBox(editor))
    }
    const onBlur = () => {
      // 点菜单/输入框时编辑器会 blur，别把工具条收了
      window.setTimeout(() => {
        if (!document.activeElement?.closest('[data-dd-bubble]')) setSel(null)
      }, 120)
    }
    const hide = () => setSel(null)
    sync()
    editor.on('selectionUpdate', sync)
    editor.on('transaction', sync)
    editor.on('blur', onBlur)
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    window.addEventListener('dd:blockmenu-open', hide)
    return () => {
      editor.off('selectionUpdate', sync)
      editor.off('transaction', sync)
      editor.off('blur', onBlur)
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
      window.removeEventListener('dd:blockmenu-open', hide)
    }
  }, [editor, linkOpen])

  useEffect(() => {
    if (linkOpen) window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [linkOpen])

  if (!editor || !sel) return null

  const active = (name: string) => editor.isActive(name)

  const run = (fn: () => void) => {
    fn()
    setSel(selectionBox(editor))
  }

  const openLink = () => {
    keep.current = sel
    const current = String(editor.getAttributes('link').href ?? '')
    setHref(current)
    setLinkOpen(true)
  }

  const applyLink = (remove = false) => {
    const range = keep.current ?? sel
    const value = href.trim()
    const chain = editor.chain().focus().setTextSelection({ from: range.from, to: range.to })
    if (remove || !value) chain.extendMarkRange('link').unsetLink().run()
    else chain.extendMarkRange('link').setLink({ href: value }).run()
    setLinkOpen(false)
    setSel(selectionBox(editor))
  }

  return (
    <div
      data-dd-bubble=""
      className="dd-bubble"
      style={{
        left: Math.min(sel.left, Math.max(8, window.innerWidth - (linkOpen ? 344 : W) - 8)),
        top: sel.top,
        width: linkOpen ? 344 : W,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {linkOpen ? (
        <div className="dd-bubble-link">
          <input
            ref={inputRef}
            value={href}
            list="dd-link-notes"
            placeholder="链接地址，或笔记路径（如 项目/周计划.md）"
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyLink()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setLinkOpen(false)
                editor.commands.focus()
              }
            }}
            className="dd-bubble-input"
            aria-label="链接地址"
          />
          <datalist id="dd-link-notes">
            {(notes ?? []).slice(0, 200).map((n) => (
              <option key={n.path} value={n.path}>
                {n.title}
              </option>
            ))}
          </datalist>
          <button type="button" className="dd-bubble-act" onClick={() => applyLink()}>
            应用
          </button>
          <button type="button" className="dd-bubble-act" onClick={() => applyLink(true)} title="移除链接">
            移除
          </button>
        </div>
      ) : (
        <div className="dd-bubble-row">
          <button
            type="button"
            className="dd-bubble-btn is-bold"
            aria-pressed={active('bold')}
            title="加粗（Ctrl+B）"
            onClick={() => run(() => editor.chain().focus().toggleBold().run())}
          >
            B
          </button>
          <button
            type="button"
            className="dd-bubble-btn is-italic"
            aria-pressed={active('italic')}
            title="斜体（Ctrl+I）"
            onClick={() => run(() => editor.chain().focus().toggleItalic().run())}
          >
            I
          </button>
          <button
            type="button"
            className="dd-bubble-btn is-strike"
            aria-pressed={active('strike')}
            title="删除线"
            onClick={() => run(() => editor.chain().focus().toggleStrike().run())}
          >
            S
          </button>
          <button
            type="button"
            className="dd-bubble-btn is-code"
            aria-pressed={active('code')}
            title="行内代码"
            onClick={() => run(() => editor.chain().focus().toggleCode().run())}
          >
            {'</>'}
          </button>
          <span className="dd-bubble-sep" />
          <button
            type="button"
            className="dd-bubble-btn is-link"
            aria-pressed={active('link')}
            title="链接"
            onClick={openLink}
          >
            ↗
          </button>
        </div>
      )}
    </div>
  )
}
