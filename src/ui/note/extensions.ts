/*
 * TipTap 扩展：把 ProseMirror 的基础节点改造成"我们的块"。
 *
 * 三件事：
 *   1. 给每个顶层节点挂 `id`（块 id，落盘时当文件名用）和 `width`（整行/半宽）
 *   2. 用 node view 包成卡片（工具条、拖拽、宽度切换）
 *   3. 回车 = 块内换行（hardBreak），不是开新块
 */
import { Extension, Node, type Editor } from '@tiptap/core'
import { clampPlacement } from '../../core/note/layout'
import Image from '@tiptap/extension-image'
import Heading from '@tiptap/extension-heading'
import Paragraph from '@tiptap/extension-paragraph'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { ColumnsView, ColumnView, ImageBlockView, TextBlockView } from './BlockViews'

const blockAttrs = {
  id: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-block-id'),
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs.id ? { 'data-block-id': attrs.id as string } : {},
  },
  /** 自由排版位置 { x%, y px, w% }。null = 还没摆过，按顺序往下堆 */
  layout: {
    default: null,
    parseHTML: (el: HTMLElement) => {
      const raw = el.getAttribute('data-layout')
      if (!raw) return null
      try {
        const l = JSON.parse(raw) as { x?: number; y?: number; w?: number }
        if (typeof l.x !== 'number' || typeof l.y !== 'number' || typeof l.w !== 'number') return null
        return clampPlacement({ x: l.x, y: l.y, w: l.w })
      } catch {
        return null
      }
    },
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs.layout ? { 'data-layout': JSON.stringify(attrs.layout) } : {},
  },
}

/** 回车 = 换行（块内），不是新块 */
const enterIsBreak = {
  Enter: ({ editor }: { editor: Editor }) =>
    editor.commands.insertContent({ type: 'hardBreak' }),
}

export const BlockParagraph = Paragraph.extend({
  addAttributes: () => blockAttrs,
  addKeyboardShortcuts: () => enterIsBreak,
  addNodeView() {
    return ReactNodeViewRenderer(TextBlockView)
  },
})

export const BlockHeading = Heading.extend({
  addAttributes: () => ({
    ...blockAttrs,
    level: {
      default: 1,
      parseHTML: (el: HTMLElement) => Number(el.tagName.slice(1)) || 1,
      renderHTML: () => ({}),
    },
  }),
  addKeyboardShortcuts: () => enterIsBreak,
  addNodeView() {
    return ReactNodeViewRenderer(TextBlockView)
  },
})

export const BlockImage = Image.extend({
  addAttributes: () => ({
    ...blockAttrs,
    src: {
      default: '',
      parseHTML: (el: HTMLElement) => el.getAttribute('src'),
      renderHTML: (attrs: Record<string, unknown>) => ({ src: attrs.src as string }),
    },
    alt: {
      default: '',
      parseHTML: (el: HTMLElement) => el.getAttribute('alt'),
      renderHTML: (attrs: Record<string, unknown>) => ({ alt: attrs.alt as string }),
    },
  }),
  addNodeView() {
    return ReactNodeViewRenderer(ImageBlockView)
  },
})

/**
 * 保证每个顶层节点都有唯一 id。
 * 没有 id 的节点进不了 `.note` 的块文件，所以这里兜底补上，别指望调用方记得。
 */
export const BlockIds = Extension.create({
  name: 'blockIds',
  addProseMirrorPlugins() {
    const key = new PluginKey('blockIds')
    return [
      new Plugin({
        key,
        appendTransaction: (_trs, _old, state) => {
          const used = new Set<string>()
          let max = 0
          let missing = 0

          state.doc.forEach((node) => {
            const id = String(node.attrs.id ?? '')
            if (id) {
              used.add(id)
              const m = /^b(\d+)$/.exec(id)
              if (m) max = Math.max(max, Number(m[1]))
            } else {
              missing += 1
            }
          })

          if (missing === 0) return null

          const tr = state.tr
          state.doc.forEach((node, offset) => {
            if (node.attrs.id) return
            let next = max + 1
            while (used.has(`b${next}`)) next += 1
            max = next
            used.add(`b${next}`)
            tr.setNodeAttribute(offset, 'id', `b${next}`)
          })
          return tr
        },
      }),
    ]
  },
})

/**
 * 分栏容器。
 *
 *   columns
 *     ├─ column (width: 34)
 *     │    ├─ paragraph
 *     │    └─ image      ← 一列里可以堆多块
 *     ├─ column (width: 27)
 *     └─ column (width: 39)
 *
 * 这是"真正的分栏"：每列可以有自己的多块内容，不是"两个半宽块碰巧并排"。
 */
export const BlockColumns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column+',
  defining: true,
  isolating: true,
  addAttributes: () => blockAttrs,
  parseHTML: () => [{ tag: 'div[data-columns]' }],
  renderHTML: () => ['div', { 'data-columns': '' }, 0],
  addNodeView() {
    return ReactNodeViewRenderer(ColumnsView)
  },
})

export const BlockColumn = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  addAttributes: () => ({
    width: {
      default: 50,
      parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-col-w')) || 50,
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-col-w': String(attrs.width ?? 50) }),
    },
  }),
  parseHTML: () => [{ tag: 'div[data-column]' }],
  renderHTML: () => ['div', { 'data-column': '' }, 0],
  addNodeView() {
    return ReactNodeViewRenderer(ColumnView)
  },
})