/*
 * 文档流的两个 node view：图片、分栏。
 *
 * 其余块类型（段落/标题/引用/代码/列表/待办/分隔线）**都用 ProseMirror 默认渲染**。
 * 这是故意的：块编辑器的坑大多在"自己接管渲染"上（选区、输入法、拖拽、粘贴），
 * 少接管一个就少一类 bug。只有图片（要把仓库字节换成 Blob URL）和分栏（要多列布局）
 * 非接管不可。
 */
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { useState } from 'react'
import { resolveImage } from '../markdown/imageStore'

export function FlowImageView(props: NodeViewProps) {
  const { node, editor, getPos, selected } = props
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
    <NodeViewWrapper
      as="div"
      className={['dd-flow-image', over ? 'is-over' : '', selected ? 'is-selected' : ''].join(' ')}
      data-block-id={String(node.attrs.id ?? '')}
      data-type="image"
      onDragOver={(e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: React.DragEvent) => {
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
        <img src={url} alt={String(node.attrs.alt ?? '')} draggable={false} />
      ) : (
        <label className="dd-flow-image-empty" contentEditable={false}>
          <span className="dd-flow-image-glyph">▧</span>
          <span>{src ? `图没找到：${src}` : '拖入图片，或点这里选一张'}</span>
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
    </NodeViewWrapper>
  )
}

export function FlowUnknownView(props: NodeViewProps) {
  const { node } = props
  const label = String(node.attrs.label ?? '未知块')
  return (
    <NodeViewWrapper
      as="div"
      className="dd-flow-unknown"
      data-block-id={String(node.attrs.id ?? '')}
      data-type="unknown"
      title="这个块来自更新版本的 Dusk Depot；它的数据被原样保留，保存时不会改动"
    >
      <span className="dd-flow-unknown-badge">未识别</span>
      <span className="dd-flow-unknown-label">{label}</span>
      <span className="dd-flow-unknown-hint">数据已保留，这里只显示占位</span>
    </NodeViewWrapper>
  )
}

export function FlowColumnsView(props: NodeViewProps) {
  const { node, editor, getPos } = props

  const addColumn = () => {
    const p = typeof getPos === 'function' ? (getPos() ?? -1) : -1
    if (p < 0) return
    const schema = editor.state.schema
    const column = schema.nodes.column
    const para = schema.nodes.paragraph
    if (!column || !para) return

    const width = Math.max(15, Math.round(100 / (node.childCount + 1)))
    const tr = editor.state.tr
    node.forEach((_c, offset) => tr.setNodeAttribute(p + 1 + offset, 'width', width))
    tr.insert(p + node.nodeSize - 1, column.create({ width }, para.create()))
    editor.view.dispatch(tr)
  }

  return (
    <NodeViewWrapper as="div" className="dd-flow-columns-wrap" data-block-id={String(node.attrs.id ?? '')} data-type="columns">
      <NodeViewContent className="dd-flow-columns" />
      <div className="dd-flow-columns-bar" contentEditable={false}>
        <span className="dd-flow-columns-count">分栏 · {node.childCount} 列</span>
        <button type="button" onClick={addColumn} className="dd-flow-mini" aria-label="加一列">
          ＋ 列
        </button>
      </div>
    </NodeViewWrapper>
  )
}

export function FlowColumnView(props: NodeViewProps) {
  const { node, updateAttributes } = props
  const width = typeof node.attrs.width === 'number' ? (node.attrs.width as number) : 50

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = width
    const total = (e.currentTarget as HTMLElement).closest('.dd-flow-columns')?.getBoundingClientRect().width ?? 600

    const move = (ev: PointerEvent) => {
      const delta = ((ev.clientX - startX) / Math.max(1, total)) * 100
      updateAttributes({ width: Math.min(85, Math.max(15, Math.round(startW + delta))) })
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
      className="dd-flow-column"
      style={{ flexBasis: `${width}%`, flexGrow: 0, flexShrink: 1 }}
    >
      <NodeViewContent className="dd-flow-column-body" />
      <div
        className="dd-flow-column-resize"
        contentEditable={false}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整列宽"
        onPointerDown={startResize}
      />
    </NodeViewWrapper>
  )
}
