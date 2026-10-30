/*
 * 文档流编辑器的 TipTap 扩展。
 *
 * 跟 `extensions.ts`（画布）的区别只有三处，别混：
 *   ① 回车 = **拆块**（ProseMirror 默认），不是块内换行；
 *   ② 块没有 `layout`，位置由 `order.json` 决定；
 *   ③ 多了一批块类型：引用、代码、三种列表、待办、分隔线。
 *
 * 每个顶层块都带 `id`（落盘时当文件名）。列表 / 待办 / 分栏容器也带 ——
 * 因为"一块一个文件"这条纪律是按**顶层节点**算的，容器也是块。
 */
import { Extension, Node, type Editor } from '@tiptap/core'
import Blockquote from '@tiptap/extension-blockquote'
import BulletList from '@tiptap/extension-bullet-list'
import CodeBlock from '@tiptap/extension-code-block'
import Heading from '@tiptap/extension-heading'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import Image from '@tiptap/extension-image'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import OrderedList from '@tiptap/extension-ordered-list'
import Paragraph from '@tiptap/extension-paragraph'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { FlowColumnsView, FlowColumnView, FlowImageView, FlowUnknownView } from './FlowNodeViews'

/** 块 id：顶层节点的身份，落盘时就是 `blocks/<id>.json` */
const idAttr = {
  id: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-block-id'),
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs.id ? { 'data-block-id': attrs.id as string } : {},
  },
}

export const FlowParagraph = Paragraph.extend({
  addAttributes() {
    return { ...this.parent?.(), ...idAttr }
  },
})

/**
 * 标题：回车 → 新段落。
 *
 * 这是块编辑器的肌肉记忆：写完标题按回车是要接着写正文，不是再开一个标题。
 * 光标在标题中间时，拆出来的后半段也降级成正文（Notion 同款）。
 */
export const FlowHeading = Heading.extend({
  addAttributes() {
    return { ...this.parent?.(), ...idAttr }
  },
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Enter: ({ editor }) => enterFromHeading(editor),
    }
  },
})

function enterFromHeading(editor: Editor): boolean {
  const { state, view } = editor
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.name !== 'heading') return false

  // 在标题末尾：后面接一个空段落
  if ($from.pos === $from.end()) {
    const para = state.schema.nodes.paragraph
    if (!para) return false
    const at = $from.after()
    const tr = state.tr.insert(at, para.create())
    view.dispatch(tr)
    editor.commands.focus(at + 1)
    return true
  }

  // 在中间：先拆，再把后半段变成正文
  editor.commands.splitBlock()
  editor.commands.setParagraph()
  return true
}

export const FlowQuote = Blockquote.extend({
  addAttributes() {
    return { ...this.parent?.(), ...idAttr }
  },
})

export const FlowCode = CodeBlock.extend({
  addAttributes() {
    return { ...this.parent?.(), ...idAttr }
  },
})

export const FlowBulletList = BulletList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...idAttr }
  },
})

export const FlowOrderedList = OrderedList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...idAttr }
  },
})

export const FlowTaskList = TaskList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...idAttr }
  },
})

export const FlowTaskItem = TaskItem.configure({ nested: true })

export const FlowRule = HorizontalRule.extend({
  addAttributes() {
    return { ...this.parent?.(), ...idAttr }
  },
})

export const FlowImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...idAttr,
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
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(FlowImageView)
  },
})

/**
 * 认不出的块：**只占位，不改数据**。
 *
 * 新版写了这张图存不下的块（比如将来的 table），旧版打开时把它原样收进 raw，
 * 显示成一块灰条。保存时 raw 一字不改地写回去 —— 降级成正文或删掉都是丢数据，
 * 这里宁可"看起来像坏了一块"，也不能让它在磁盘上消失。
 */
export const FlowUnknown = Node.create({
  name: 'flowUnknown',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes: () => ({
    ...idAttr,
    raw: {
      default: '{}',
      parseHTML: (el: HTMLElement) => el.getAttribute('data-raw') ?? '{}',
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-raw': String(attrs.raw ?? '{}') }),
    },
    label: {
      default: '未知块',
      parseHTML: (el: HTMLElement) => el.getAttribute('data-label') ?? '未知块',
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-label': String(attrs.label ?? '未知块') }),
    },
  }),
  parseHTML: () => [{ tag: 'div[data-unknown-block]' }],
  renderHTML: () => ['div', { 'data-unknown-block': '' }],
  addNodeView() {
    return ReactNodeViewRenderer(FlowUnknownView)
  },
})

/** 分栏：容器 + 列。列宽还是百分比，但不再有自由拖放的位置 */
export const FlowColumns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column+',
  defining: true,
  isolating: true,
  addAttributes: () => idAttr,
  parseHTML: () => [{ tag: 'div[data-columns]' }],
  renderHTML: () => ['div', { 'data-columns': '' }, 0],
  addNodeView() {
    return ReactNodeViewRenderer(FlowColumnsView)
  },
})

export const FlowColumn = Node.create({
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
    return ReactNodeViewRenderer(FlowColumnView)
  },
})

/**
 * 文档流的键位补充（ProseMirror 默认已经处理了大部分）：
 *   · 标题行首退格 → 变回正文（而不是跟上一块合并）
 *   · 引用第一段行首退格 → 退出引用
 *   · 待办里的 Tab / Shift-Tab → 缩进 / 缩进回来
 */
export const FlowKeys = Extension.create({
  name: 'ddFlowKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { state } = editor
        const { $from, empty } = state.selection
        if (!empty || $from.parentOffset !== 0) return false

        if ($from.parent.type.name === 'heading') {
          editor.commands.setParagraph()
          return true
        }

        // 引用里的第一段，行首退格 → 从引用里提出来
        const quote = $from.depth >= 2 ? $from.node($from.depth - 1) : null
        if (quote?.type.name === 'blockquote' && $from.index($from.depth - 1) === 0) {
          return editor.commands.lift('blockquote')
        }
        return false
      },

      Tab: ({ editor }) => {
        const { $from } = editor.state.selection
        if ($from.parent.type.name !== 'paragraph') return false
        const item = $from.node($from.depth - 1)
        if (item?.type.name !== 'taskItem') return false
        return editor.commands.sinkListItem('taskItem')
      },

      'Shift-Tab': ({ editor }) => {
        const { $from } = editor.state.selection
        const item = $from.depth >= 2 ? $from.node($from.depth - 1) : null
        if (item?.type.name !== 'taskItem') return false
        return editor.commands.liftListItem('taskItem')
      },
    }
  },
})

/**
 * 保证每个顶层块都有**唯一** id。
 *
 * 两件事都得管，缺一个就丢数据：
 *   ① 缺 id（新块）→ 补一个；
 *   ② **id 撞车** → 给后一个换新的。
 *
 * ② 不是洁癖：ProseMirror 的 splitBlock 会把原节点的 attrs 复制给新节点，
 * 于是"回车拆块"拆出来的两块**共用同一个 id**。落盘时按 id 存文件，
 * 两块就会写进同一个 blocks/<id>.json —— 前一块的内容直接消失。
 * 这个坑必须在源头堵住，不能指望调用方记得改。
 */
export const FlowBlockIds = Extension.create({
  name: 'flowBlockIds',
  addProseMirrorPlugins() {
    const key = new PluginKey('flowBlockIds')
    return [
      new Plugin({
        key,
        appendTransaction: (_trs, _old, state) => {
          const used = new Set<string>()
          const need: number[] = []
          let max = 0

          state.doc.forEach((node, offset) => {
            const id = String(node.attrs.id ?? '')
            if (id) {
              const m = /^b(\d+)$/.exec(id)
              if (m) max = Math.max(max, Number(m[1]))
            }
            if (!id || used.has(id)) {
              need.push(offset)
              return
            }
            used.add(id)
          })

          if (need.length === 0) return null

          const tr = state.tr
          for (const offset of need) {
            let next = max + 1
            while (used.has(`b${next}`)) next += 1
            max = next
            used.add(`b${next}`)
            tr.setNodeAttribute(offset, 'id', `b${next}`)
          }
          return tr
        },
      }),
    ]
  },
})
