/*
 * 块卡片的 node view。
 *
 * 每张卡片 = ProseMirror 的一个顶层节点 + 我们的外壳（工具条 / 宽度 / 拖拽）。
 * 真正的可编辑内容交给 `<NodeViewContent />`，选区、输入法、撤销都由 ProseMirror 管 ——
 * 这正是不再用 contentEditable 手糊的原因。
 */
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { resizeTo } from '../../core/note/layout'
import { resolveImage } from '../markdown/imageStore'

/** 拖拽期间共享的状态（只在这一个文档里用） */
const drag = {
  from: -1,
  active: false,
  overPos: -1,
  side: 'before' as 'before' | 'after' | 'left' | 'right',
}

export function nextBlockId(editor: NodeViewProps['editor']): string {
  let max = 0
  editor.state.doc.forEach((n) => {
    const m = /^b(\d+)$/.exec(String(n.attrs.id ?? ''))
    if (m) max = Math.max(max, Number(m[1]))
  })
  return `b${max + 1}`
}

/** 拖拽落点：上方/下方 = 上下堆叠；左/右 = 并排成两栏 */
type DropSide = 'before' | 'after' | 'left' | 'right'

function captureRects(view: NodeViewProps['editor']['view']): Map<string, DOMRect> {
  const m = new Map<string, DOMRect>()
  view.dom.querySelectorAll<HTMLElement>('[data-block-id]').forEach((el) => {
    m.set(el.dataset.blockId ?? '', el.getBoundingClientRect())
  })
  return m
}

/** 重排之后做 FLIP，其他块平滑让位 */
function flip(view: NodeViewProps['editor']['view'], before: Map<string, DOMRect>): void {
  requestAnimationFrame(() => {
    view.dom.querySelectorAll<HTMLElement>('[data-block-id]').forEach((el) => {
      const b = before.get(el.dataset.blockId ?? '')
      if (!b) return
      const a = el.getBoundingClientRect()
      const dx = b.left - a.left
      const dy = b.top - a.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0,0)' }],
        { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' },
      )
    })
  })
}

/**
 * 移动块。
 * `side` 是左/右时，被拖的块和目标块**都变成半宽** —— 这就是"拖到右边就左右分栏"，
 * 不需要手动点宽度按钮。
 */
/**
 * 移动块。
 * `side` 是左/右时，被拖的块和目标块**都变成半宽** —— 这就是"拖到旁边就并排"，
 * 不需要手动设宽度。
 */
function moveBlock(
  editor: NodeViewProps['editor'],
  fromPos: number,
  toPos: number,
  side: DropSide,
): void {
  const { state, view } = editor
  const node = state.doc.nodeAt(fromPos)
  const target = state.doc.nodeAt(toPos)
  if (!node || !target) return

  /*
   * 拖到自己身上 = 什么都不做。
   * ⚠️ 边界要写 **<** 而不是 <=：toPos 正好等于 fromPos + nodeSize 时，
   *    那是"紧挨着的下一个块"，是合法的落点，不能当成"自己内部"挡掉。
   */
  if (toPos > fromPos && toPos < fromPos + node.nodeSize) return

  const before = captureRects(view)
  const split = side === 'left' || side === 'right'

  /*
   * 三步，全部位置自己算，不靠 mapping 猜：
   *   1. 先算出"删掉自己之后"目标块和插入点各自在哪
   *   2. 插入被拖的块（拖到侧边就用新 span 重建）
   *   3. 按插入是否在目标之前，给目标块的 span 也改成半宽
   */
  const insertBefore = side === 'before' || side === 'left'
  const insertAt = insertBefore ? toPos : toPos + target.nodeSize

  const tr = state.tr
  tr.delete(fromPos, fromPos + node.nodeSize)

  const shiftAfterDelete = (pos: number) => (fromPos < pos ? pos - node.nodeSize : pos)
  const at = shiftAfterDelete(insertAt)

  const moved = node

  tr.insert(at, moved)

  /*
   * 拖到侧边 = 想并排。
   * 自由排版下不再有"半宽 / 整行"这种档位，直接把两块各摆到左半和右半，
   * 同一水平线上。这是最贴近直觉的结果：你往旁边拖，它就真的站在旁边。
   */
  if (split) {
    const canvasBox = view.dom.getBoundingClientRect()
    const targetEl = view.dom.querySelector<HTMLElement>(
      '[data-block-id="' + String(target.attrs.id ?? '') + '"]',
    )
    const baseY = targetEl
      ? Math.max(0, Math.round(targetEl.getBoundingClientRect().top - canvasBox.top + view.dom.scrollTop))
      : 0
    const leftIsTarget = side === 'left'
    const leftId = leftIsTarget ? String(target.attrs.id ?? '') : String(moved.attrs.id ?? '')
    const rightId = leftIsTarget ? String(moved.attrs.id ?? '') : String(target.attrs.id ?? '')

    const place = (id: string, x: number) => {
      let pos = -1
      view.state.doc.descendants((n, at2) => {
        if (String(n.attrs.id ?? '') === id) {
          pos = at2
          return false
        }
        return true
      })
      if (pos >= 0) tr.setNodeAttribute(pos, 'layout', { x, y: baseY, w: 49 })
    }
    place(leftId, 0)
    place(rightId, 51)
  }

  view.dispatch(tr)

  flip(view, before)
}

type ShellProps = {
  props: NodeViewProps
  kind: 'text' | 'image'
  children: React.ReactNode
}

/** 卡片外壳：工具条 + 拖拽落点 */
function CardShell({ props, kind, children }: ShellProps) {
  const { node, editor, getPos, deleteNode, updateAttributes } = props
  const id = String(node.attrs.id ?? '')
  const layout = node.attrs.layout as { x: number; y: number; w: number } | null
  const ref = useRef<HTMLDivElement | null>(null)



  /*
   * "选中"不能靠 :focus-within —— 整个文档只有 ProseMirror 根是 contenteditable，
   * 焦点永远在根上，不会落到某张卡片里。所以自己盯选区：
   * 选区落在这一块的范围里，就算选中，给它一层淡淡的边。
   */
  const [selected, setSelected] = useState(false)

  /*
   * 工具条的显隐由 JS 管，不靠纯 CSS :hover。
   * 纯 CSS 的死循环：按钮在块的上方 → 鼠标移过去时不在块里 → :hover 结束 → 按钮 opacity 0、
   * pointer-events:none → 此时又点不到 → 按钮"消失"。加 260ms 宽限 + 按钮自己也能维持打开状态。
   */
  const [toolsOpen, setToolsOpen] = useState(false)
  const closeTimer = useRef(0)
  const openTools = () => {
    window.clearTimeout(closeTimer.current)
    setToolsOpen(true)
  }
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setToolsOpen(false), 260)
  }
  useEffect(() => {
    const sync = () => {
      const p = typeof getPos === 'function' ? (getPos() ?? -1) : -1
      if (p < 0) return
      const { from, to } = editor.state.selection
      setSelected(from >= p && to <= p + node.nodeSize)
    }
    sync()
    editor.on('selectionUpdate', sync)
    editor.on('focus', sync)
    editor.on('blur', sync)
    return () => {
      editor.off('selectionUpdate', sync)
      editor.off('focus', sync)
      editor.off('blur', sync)
    }
  }, [editor, getPos, node])

  const pos = () => (typeof getPos === 'function' ? (getPos() ?? -1) : -1)
  /** 嵌在分栏里的块：不显示浮动工具条（它会飘到列外面） */
  const nested = (() => {
    const p = pos()
    if (p < 0) return false
    try {
      return editor.state.doc.resolve(p).depth > 1
    } catch {
      return false
    }
  })()

  /*
   * 实际显示占几列 = 由**文档模型**算出来，不去量 DOM。
   *
   * 为什么不能量 DOM：量出来"我独占一行"→ 我把 basis 拉满 → 真的独占一行 →
   * 又量出"独占一行"，自己强化自己，永远回不到并排。
   *
   * 算法（纯函数，见 core/note/layout.ts）：
   *   取出所有顶层块的意图 span → packRows 打成行 → rebalance 每行铺满 → 取我自己那个值
   */
  const onDragStart = (e: React.DragEvent) => {
    const p = pos()
    if (p < 0) return
    drag.from = p
    drag.active = true
    drag.overPos = -1
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    ref.current?.classList.add('is-dragging')
  }

  const onDragEnd = () => {
    drag.active = false
    drag.from = -1
    drag.overPos = -1
    ref.current?.classList.remove('is-dragging')
    document.querySelectorAll('[data-drop]').forEach((el) => el.removeAttribute('data-drop'))
  }

  const onDragOver = (e: React.DragEvent) => {
    if (!drag.active) return
    e.preventDefault()
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    const relY = (e.clientY - r.top) / Math.max(1, r.height)
    const relX = (e.clientX - r.left) / Math.max(1, r.width)

    /*
     * 落点判定：**上/下边缘细带**= 堆叠，其余面积= 并排（按左右半边）。
     *
     * 为什么不是各占 28%：块一高，中间"并排区"就只剩一条缝，用户想并排反而要瞄得很准。
     * 现在只有贴边 60px 才算堆叠（且不超过高度的 1/4），大大片面积都是"并排"。
     */
    const edge = Math.min(60, r.height * 0.25)
    let side: DropSide
    if (relY * r.height < edge) side = 'before'
    else if ((1 - relY) * r.height < edge) side = 'after'
    else side = relX < 0.5 ? 'left' : 'right'

    document.querySelectorAll('[data-drop]').forEach((el) => el.removeAttribute('data-drop'))
    e.currentTarget.setAttribute('data-drop', side)
    drag.overPos = pos()
    drag.side = side
    document.body.dataset.dragSide = side + '|' + Math.round(relY * 100) + '|' + Math.round(relX * 100)
  }

  const onDrop = (e: React.DragEvent) => {
    if (!drag.active) return
    e.preventDefault()
    e.stopPropagation()
    const from = drag.from
    const target = drag.overPos
    const side = drag.side
    onDragEnd()
    if (from >= 0 && target >= 0) moveBlock(editor, from, target, side)
  }



  const insertBelow = () => {
    const p = pos()
    if (p < 0) return
    const at = p + node.nodeSize
    editor
      .chain()
      .insertContentAt(at, {
        type: 'paragraph',
        attrs: { id: nextBlockId(editor) },
      })
      .focus(at + 1)
      .run()
  }

  return (
    <NodeViewWrapper
      as="div"
      ref={ref as never}
      data-block-id={id}
      data-type={node.type.name}
      data-layout-json={layout ? JSON.stringify(layout) : ''}
      data-selected={selected || props.selected ? '' : undefined}
      className={['dd-note-card', kind === 'image' ? 'is-image' : ''].join(' ')}
      style={freeStyle(layout, nested)}
      data-has-layout={layout ? 'yes' : 'no'}

      onDragOver={onDragOver}
      onDrop={onDrop}
      onMouseEnter={openTools}
      onMouseLeave={scheduleClose}
    >
      {/*
        工具条全在**左侧装订线**里，绝不压在正文上。
        之前右边那两个按钮浮在正文右上角 —— 点正文右端会误触「删除」，
        测试里整块笔记就是这么被删掉的，真实使用同样会踩。
      */}
      {nested ? null : (
      <div
        className={['dd-note-tools', toolsOpen ? 'is-open' : ''].join(' ')}
        contentEditable={false}
        onMouseEnter={openTools}
        onMouseLeave={scheduleClose}
      >
        <button
          type="button"
          draggable
          aria-label="拖动这一块"
          title="拖动排序"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className="dd-note-btn"
        >
          ⠿
        </button>
        <button
          type="button"
          aria-label="在下面插入一块"
          title="在下面插入一块"
          onClick={insertBelow}
          className="dd-note-btn"
        >
          ＋
        </button>
        <button
          type="button"
          aria-label="删除这一块"
          title="删除这一块"
          onClick={() => deleteNode()}
          className="dd-note-btn"
        >
          ✕
        </button>
      </div>
      )}

      {/* 右边缘：拖宽度（富文本编辑器该有的手感，不是只能整行/半宽二选一） */}
      <div
        className="dd-note-resize"
        contentEditable={false}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整块宽"
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const card = ref.current
          const canvas = card?.closest('.dd-note-canvas') as HTMLElement | null
          if (!card || !canvas) return
          const box = canvas.getBoundingClientRect()
          const startW = layout?.w ?? 100
          const startX = layout?.x ?? 0
          const startY = layout?.y ?? 0
          const move = (ev: PointerEvent) => {
            // 拖到画布宽度的几成就是多宽（自由排版：没有档位）
            const ratio = ((ev.clientX - box.left) / box.width) * 100 - startX
            updateAttributes({ layout: resizeTo({ x: startX, y: startY, w: startW }, ratio) })
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            document.body.style.cursor = ''
          }
          document.body.style.cursor = 'col-resize'
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }}
      />

      <div className="dd-note-body">{children}</div>
    </NodeViewWrapper>
  )
}

/**
 * 宽度 → flex 样式。
 *   'half'  → 半宽，**可增长**（右边没邻居时自动长满）
 *   数字     → 手动拖出来的百分比，**不增长**（拖了就是拖了）
 *   null     → 整行
 */
/**
 * span → flex 样式。
 *
 * 关键：`flex-grow` 用 **span 本身**当权重，而不是写死宽度。
 * 这样一行里没占满时，剩下的空间会按 span 的比例自动分掉（白板自适应），
 * 不需要 JS 逐块算；删掉邻居，旁边那块自然变宽。
 */
/**
 * 自由定位。
 *
 * 摆过的块：absolute 落在画布上的 (x%, y px)，宽度 w%。
 * 没摆过的：留在文档流里（static），由外层的 layoutBlocks 决定它堆在哪。
 * 分栏里的块：永远占满整列（列内不做自由排版）。
 */
function freeStyle(
  layout: { x: number; y: number; w: number } | null,
  nested: boolean,
): React.CSSProperties {
  if (nested) return { width: '100%' }
  /*
   * 没摆过的块先按流内排（position: relative）。
   * 如果这里也 absolute 且 top 缺席，所有块会全部叠在画布左上角 ——
   * 上一版就是这样，11 个块全挤在同一个 (407,166)。
   */
  if (!layout) return { position: 'relative', width: '100%' }
  return {
    position: 'absolute',
    left: `${layout.x}%`,
    top: layout.y,
    width: `${layout.w}%`,
  }
}
/** 正文块 / 标题块：可编辑内容 */
export function TextBlockView(props: NodeViewProps) {
  const heading = props.node.type.name === 'heading'
  const empty = props.node.content.size === 0
  return (
    <CardShell props={props} kind="text">
      <NodeViewContent
        className={['dd-note-content', heading ? 'is-heading' : '', empty ? 'is-empty' : ''].join(' ')}
        data-placeholder={heading ? '标题' : '写点什么，回车换行'}
        as="div"
      />
    </CardShell>
  )
}

/** 图片块：图片来自仓库图床，运行时读字节转 Blob URL */
export function ImageBlockView(props: NodeViewProps) {
  const { node, editor, getPos, updateAttributes } = props
  const src = String(node.attrs.src ?? '')
  const url = resolveImage(src)
  const [over, setOver] = useState(false)

  const accept = (file: File) => {
    const p = typeof getPos === 'function' ? (getPos() ?? -1) : -1
    if (p < 0) return
    ;(editor as unknown as { emit: (n: string, p: unknown) => void }).emit('dd:image-drop', {
      pos: p,
      file,
    })
  }

  return (
    <CardShell props={props} kind="image">
      <div
        className={['dd-note-image', over ? 'is-over' : ''].join(' ')}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          e.stopPropagation()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          const f = e.dataTransfer.files?.[0]
          if (f && f.type.startsWith('image/')) {
            e.preventDefault()
            e.stopPropagation()
            accept(f)
          }
          setOver(false)
        }}
      >
        {url ? (
          <img
            src={url}
            alt={String(node.attrs.alt ?? '')}
            draggable={false}
            onLoad={(e) => {
              // 自动宽度：小图自动半宽（两张小图并排），大图整行。
              // 有位置了就别动（用户拖过），没摆过的按图片原始尺寸给个合适的宽度
              if (node.attrs.layout) return
              const w = e.currentTarget.naturalWidth
              if (w > 0 && w <= 520) updateAttributes({ layout: { x: 0, y: 0, w: 48 } })
            }}
          />
        ) : (
          <label className="dd-note-image-empty">
            <span>▧</span>
            拖入图片，或点这里选一张
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) accept(f)
              }}
            />
          </label>
        )}
      </div>
      {src ? (
        <button
          type="button"
          className="dd-note-btn dd-note-clear"
          contentEditable={false}
          aria-label="换成另一张图"
          onClick={() => updateAttributes({ src: '', alt: '' })}
        >
          换图
        </button>
      ) : null}
    </CardShell>
  )
}

/* ───────────────────────── 分栏 ───────────────────────── */

/** 分栏容器：横向排几列，每列自己竖着堆块 */
export function ColumnsView(props: NodeViewProps) {
  const { node, editor, getPos, deleteNode, updateAttributes } = props

  const addColumn = () => {
    const p = typeof getPos === 'function' ? (getPos() ?? -1) : -1
    if (p < 0) return
    const count = node.childCount + 1
    const width = Math.max(15, Math.round(100 / count))
    // 新列插到末尾，前面几列宽度平均一下
    const tr = editor.state.tr
    const colPositions: number[] = []
    node.forEach((_c, offset) => {
      colPositions.push(p + 1 + offset)
    })
    const para = editor.state.schema.nodes.paragraph
    const newColumn = editor.state.schema.nodes.column?.create({ width }, para?.create({ id: nextBlockId(editor) }))
    if (!newColumn) return
    const end = p + node.nodeSize - 1
    tr.insert(end, newColumn)
    for (const cp of colPositions) tr.setNodeAttribute(cp, 'width', width)
    editor.view.dispatch(tr)
    updateAttributes({})
  }

  return (
    <NodeViewWrapper
      as="div"
      data-block-id={String(node.attrs.id ?? '')}
      data-type="columns"
      className="dd-note-columns-wrap"
      style={{ flexBasis: '100%', flexGrow: 0 }}
    >
      {/*
        ⚠️ 分栏的操作条**常显**，不能复用卡片那套"hover 才出现"的工具条 ——
        分栏本身就是靠这个条才能操作（加列 / 删分栏），藏起来等于没有功能。
      */}
      <div className="dd-note-columns-bar" contentEditable={false}>
        <span className="dd-note-columns-title">分栏 · {node.childCount} 列</span>
        <span className="dd-note-columns-hint">拖列右边缘改宽度</span>
        <button
          type="button"
          aria-label="加一列"
          title="加一列"
          onClick={addColumn}
          className="dd-note-columns-act"
        >
          ＋ 加一列
        </button>
        <button
          type="button"
          aria-label="删除这个分栏"
          title="删除这个分栏"
          onClick={() => deleteNode()}
          className="dd-note-columns-act is-danger"
        >
          删除分栏
        </button>
      </div>
      <NodeViewContent className="dd-note-columns" />
    </NodeViewWrapper>
  )
}

/** 一列：宽度百分比 + 可编辑内容 + 右边缘拖宽 */
export function ColumnView(props: NodeViewProps) {
  const { node, editor, getPos } = props
  const width = typeof node.attrs.width === 'number' ? (node.attrs.width as number) : 50

  /*
   * 找这一列在文档里的位置：优先用 getPos()，
   * 拿不到就按节点 identity 在 doc 里搜 —— 嵌套 node view 的 getPos 有时给不到。
   */
  const findPos = (): number => {
    const direct = typeof getPos === 'function' ? (getPos() ?? -1) : -1
    if (direct >= 0) return direct
    let found = -1
    editor.state.doc.descendants((n, pos) => {
      if (n === node) {
        found = pos
        return false
      }
      return true
    })
    return found
  }

  const onResize = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const p = findPos()
    document.body.dataset.colResize = String(p)
    if (p < 0) return
    const box = (e.currentTarget as HTMLElement).closest('.dd-note-columns') as HTMLElement | null
    const canvas = (e.currentTarget as HTMLElement).closest('.dd-note-canvas') as HTMLElement | null
    if (!box || !canvas) return

    const total = canvas.getBoundingClientRect().width
    const startX = e.clientX
    const startW = width

    const move = (ev: PointerEvent) => {
      const delta = ((ev.clientX - startX) / total) * 100
      const next = Math.min(80, Math.max(15, Math.round(startW + delta)))
      document.body.dataset.colNext = `${startW}|${Math.round(delta)}|${next}|${Math.round(total)}`
      editor.view.dispatch(editor.state.tr.setNodeAttribute(p, 'width', next))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <NodeViewWrapper
      as="div"
      className="dd-note-column"
      data-col-pos={String(findPos())}
      style={{ flexBasis: `calc(${width}% - 8px)`, flexGrow: 0, flexShrink: 1 }}
    >
      <div className="dd-note-column-head" contentEditable={false}>
        <span className="dd-note-column-label">列 · {Math.round(width)}%</span>
      </div>
      <NodeViewContent className="dd-note-column-body" />
      <button
        type="button"
        contentEditable={false}
        aria-label="在这一列再加一块"
        title="在这一列再加一块"
        onClick={() => {
          const p = typeof getPos === 'function' ? (getPos() ?? -1) : -1
          if (p < 0) return
          const para = editor.state.schema.nodes.paragraph
          if (!para) return
          const end = p + node.nodeSize - 1
          const id = `b${Math.random().toString(36).slice(2, 8)}`
          editor.view.dispatch(editor.state.tr.insert(end, para.create({ id })))
          editor.commands.focus(end + 1)
        }}
        className="dd-note-col-add"
      >
        ＋ 加一块
      </button>
      <div
        className="dd-note-col-resize"
        contentEditable={false}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整列宽"
        onPointerDown={onResize}
      />
    </NodeViewWrapper>
  )
}
