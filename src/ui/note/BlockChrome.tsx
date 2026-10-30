/*
 * 块的操作外壳：悬停手柄 + 拖动排序 + 块菜单。
 *
 * 为什么不做成 node view：每个块都接管渲染，等于把 ProseMirror 的选区、输入法、
 * 拖拽全部重写一遍（上一版就死在类似的地方）。这里改成**一层浮在外面的控件**：
 * 用 `posAtCoords` 找出鼠标落在哪个顶层块，用 `nodeDOM` 拿到它的矩形，
 * 手柄就贴在块左侧的留白里。块自己还是 ProseMirror 原生渲染。
 */
import type { Editor } from '@tiptap/core'
import { useEffect, useRef, useState } from 'react'
import { flowBlockOf, type FlowTarget } from '../../core/note/flow'
import type { PmNode } from '../../core/note/pm'
import { CONVERT_TARGETS, labelOfKind } from './blocks'
import {
  convertBlockAt,
  deleteBlockAt,
  duplicateBlockAt,
  insertParagraphBelow,
  moveBlockTo,
} from './flowCommands'

type Hover = { pos: number; top: number; left: number; width: number }
type DropLine = { y: number; left: number; width: number }
type MenuState = { pos: number; left: number; top: number }

export function BlockChrome({
  editor,
  scrollRef,
}: {
  editor: Editor
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const [hover, setHover] = useState<Hover | null>(null)
  /** 最近一次悬停的位置。点手柄那一瞬间 `hover` 可能已经被清掉了，菜单还得知道是哪一块 */
  const hoverRef = useRef<Hover | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [drop, setDrop] = useState<DropLine | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ from: number; to: number; after: boolean } | null>(null)
  const hideTimer = useRef(0)

  const clearTimer = () => window.clearTimeout(hideTimer.current)
  const hideSoon = () => {
    clearTimer()
    if (menu) return
    hideTimer.current = window.setTimeout(() => setHover(null), 240)
  }

  /* 悬停：找出鼠标下面是哪个顶层块 */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const onMove = (e: MouseEvent) => {
      if (dragging || menu) return
      const view = editor.view
      const hit = view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (!hit) return hideSoon()

      let $p: ReturnType<typeof view.state.doc.resolve>
      try {
        $p = view.state.doc.resolve(hit.pos)
      } catch {
        return hideSoon()
      }
      if ($p.depth < 1) return hideSoon()

      const pos = $p.before(1)
      const dom = view.nodeDOM(pos)
      if (!(dom instanceof HTMLElement)) return hideSoon()
      const r = dom.getBoundingClientRect()
      if (r.height < 1) return hideSoon()

      clearTimer()
      const next = { pos, top: r.top, left: r.left, width: r.width }
      hoverRef.current = next
      setHover(next)
    }

    const onLeave = () => hideSoon()
    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    return () => {
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', onLeave)
      clearTimer()
    }
  }, [editor, scrollRef, dragging, menu])

  /* 文档真的变了，位置就不能信了：手柄和菜单都收掉。
   * ⚠️ 只看 docChanged —— 点手柄会让编辑器失焦，那也会发 transaction，
   *    要是连那种也收，菜单会在点开的同一瞬间被自己关掉。 */
  useEffect(() => {
    const onTr = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return
      setHover(null)
      setMenu(null)
    }
    editor.on('transaction', onTr)
    return () => {
      editor.off('transaction', onTr)
    }
  }, [editor])

  /* 拖动排序：在整个滚动区上接收 dragover，画一条落点线 */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const onOver = (e: DragEvent) => {
      if (!drag.current || !e.dataTransfer) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'

      const view = editor.view
      const hit = view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (!hit) return
      let target = -1
      try {
        const $p = view.state.doc.resolve(hit.pos)
        if ($p.depth >= 1) target = $p.before(1)
      } catch {
        return
      }
      const dom = view.nodeDOM(target)
      if (!(dom instanceof HTMLElement)) return
      const r = dom.getBoundingClientRect()
      const after = e.clientY > r.top + r.height / 2
      drag.current = { ...drag.current, to: target, after }
      setDrop({ y: after ? r.bottom : r.top, left: r.left, width: r.width })
    }

    const onDrop = (e: DragEvent) => {
      if (!drag.current) return
      e.preventDefault()
      const { from, to, after } = drag.current
      drag.current = null
      setDrop(null)
      setDragging(false)
      if (to < 0) return
      const node = editor.state.doc.nodeAt(to)
      moveBlockTo(editor, from, after ? to + (node?.nodeSize ?? 0) : to)
    }

    const onEnd = () => {
      drag.current = null
      setDrop(null)
      setDragging(false)
    }

    el.addEventListener('dragover', onOver)
    el.addEventListener('drop', onDrop)
    el.addEventListener('dragend', onEnd)
    return () => {
      el.removeEventListener('dragover', onOver)
      el.removeEventListener('drop', onDrop)
      el.removeEventListener('dragend', onEnd)
    }
  }, [editor, scrollRef])

  const handleLeft = hover ? Math.max(4, hover.left - 30) : 0

  const openMenu = () => {
    const h = hoverRef.current ?? hover
    if (!h) return
    const top = Math.min(h.top, Math.max(12, window.innerHeight - 392))
    setMenu({ pos: h.pos, left: Math.max(4, h.left - 30), top })
    // 让选区工具条先让开：两个浮层叠在一起既挡字又抢焦点
    window.dispatchEvent(new CustomEvent('dd:blockmenu-open'))
  }

  return (
    <>
      {hover ? (
        <div
          className="dd-block-tools"
          style={{ top: hover.top + 1, left: handleLeft }}
          contentEditable={false}
          onMouseEnter={clearTimer}
          onMouseLeave={hideSoon}
        >
          <button
            type="button"
            className="dd-block-btn"
            aria-label="在下面插入一块"
            title="在下面插入一块"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              editor.commands.focus()
              insertParagraphBelow(editor)
            }}
          >
            ＋
          </button>
          <button
            type="button"
            className="dd-block-btn is-grip"
            aria-label="拖动或打开块菜单"
            title="拖动排序 / 打开块菜单"
            draggable
            onMouseDown={(e) => e.preventDefault()}
            onDragStart={(e) => {
              const h = hoverRef.current ?? hover
              if (!h) return
              drag.current = { from: h.pos, to: -1, after: false }
              setDragging(true)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', String(hover.pos))
              const ghost = document.createElement('div')
              ghost.className = 'dd-drag-ghost'
              ghost.textContent = '移动块'
              document.body.appendChild(ghost)
              e.dataTransfer.setDragImage(ghost, 10, 10)
              window.setTimeout(() => ghost.remove(), 0)
            }}
            onClick={openMenu}
          >
            ⠿
          </button>
        </div>
      ) : null}

      {drop ? (
        <div
          className="dd-drop-line"
          style={{ top: drop.y - 1, left: drop.left, width: drop.width }}
          aria-hidden
        />
      ) : null}

      {menu ? (
        <BlockMenu
          editor={editor}
          menu={menu}
          onClose={() => {
            setMenu(null)
            editor.commands.focus()
          }}
        />
      ) : null}
    </>
  )
}

/* ───────────────────────── 块菜单 ───────────────────────── */

type Item = { key: string; label: string; run: () => void; danger?: boolean; section?: string }

function BlockMenu({
  editor,
  menu,
  onClose,
}: {
  editor: Editor
  menu: MenuState
  onClose: () => void
}) {
  const [index, setIndex] = useState(0)
  const box = useRef<HTMLDivElement | null>(null)

  const node = editor.state.doc.nodeAt(menu.pos)
  const block = node ? flowBlockOf(node.toJSON() as PmNode) : null
  const kind = block?.type ?? 'paragraph'

  const items: Item[] = []
  if (block && CONVERT_TARGETS.includes(kind as FlowTarget)) {
    for (const t of CONVERT_TARGETS) {
      if (t === kind) continue
      items.push({
        key: `to-${t}`,
        label: labelOfKind(t),
        section: '转换为',
        run: () => convertBlockAt(editor, menu.pos, t),
      })
    }
  }
  items.push({
    key: 'dup',
    label: '复制一块',
    section: '操作',
    run: () => duplicateBlockAt(editor, menu.pos),
  })
  items.push({
    key: 'del',
    label: '删除这一块',
    section: '操作',
    danger: true,
    run: () => deleteBlockAt(editor, menu.pos),
  })

  const runAt = (i: number) => {
    const it = items[i]
    if (!it) return
    it.run()
    onClose()
  }

  useEffect(() => {
    box.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setIndex((i) => (e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        runAt(index)
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  let lastSection = ''

  return (
    <div
      ref={box}
      tabIndex={-1}
      role="menu"
      aria-label="块菜单"
      className="dd-pop dd-block-menu"
      data-dd-block-menu=""
      style={{ left: Math.max(8, menu.left), top: menu.top, width: 216 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="dd-pop-head">
        <span>{labelOfKind(kind)}</span>
        <span className="dd-pop-hint">↑↓ · ↵</span>
      </div>
      <div className="dd-menu-list">
        {items.map((it, i) => {
          const head = it.section && it.section !== lastSection ? it.section : ''
          lastSection = it.section ?? lastSection
          return (
            <div key={it.key}>
              {head ? <div className="dd-menu-group">{head}</div> : null}
              <button
                type="button"
                role="menuitem"
                data-active={i === index ? 'true' : undefined}
                className={['dd-menu-item', it.danger ? 'is-danger' : ''].join(' ')}
                onMouseEnter={() => setIndex(i)}
                onClick={() => runAt(i)}
              >
                {it.label}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
