/*
 * 文档流的块级命令：插入 / 转换 / 复制 / 删除 / 移动。
 *
 * 全部走 ProseMirror transaction —— 一行 DOM 都不碰。
 * 位置一律按"顶层节点"算：`$from.before(1)` 就是当前块在 doc 里的起点。
 */
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import {
  cloneBlock,
  convertFlowNodes,
  makeFlowNode,
  type FlowInsertable,
  type FlowTarget,
} from '../../core/note/flow'
import type { PmNode } from '../../core/note/pm'

function topLevelPos(editor: Editor): number | null {
  const { $from } = editor.state.selection
  if ($from.depth < 1) return null
  return $from.before(1)
}

/** 生成器：一次批量操作里递增，避免复制出来的块撞号 */
export function idGen(editor: Editor): () => string {
  const used = new Set<string>()
  let max = 0
  editor.state.doc.forEach((n) => {
    const id = String(n.attrs.id ?? '')
    if (!id) return
    used.add(id)
    const m = /^b(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  })
  return () => {
    let next = max + 1
    while (used.has(`b${next}`)) next += 1
    max = next
    used.add(`b${next}`)
    return `b${next}`
  }
}

/** 块里第一个可放光标的位置（列表要钻进去，不能停在容器上） */
function firstTextPos(doc: { nodeAt: (pos: number) => unknown }, pos: number): number {
  type N = { type: { name: string }; descendants?: (f: (n: N, p: number) => boolean | void) => void }
  const node = doc.nodeAt(pos) as N | null
  if (!node) return pos
  let found = -1
  node.descendants?.((n, p) => {
    if (found >= 0) return false
    if (n.type.name === 'paragraph' || n.type.name === 'heading' || n.type.name === 'codeBlock') {
      found = pos + p + 2
      return false
    }
    return true
  })
  return found >= 0 ? found : pos + 1
}

/**
 * 斜杠菜单选了一项。
 * `range` 是 `/query` 在文档里的范围，先删掉再插块。
 */
export function insertFlowBlock(
  editor: Editor,
  kind: FlowInsertable,
  range?: { from: number; to: number },
): void {
  const { state, view } = editor
  let tr = state.tr
  if (range) tr = tr.delete(range.from, range.to)

  const $from = tr.selection.$from
  if ($from.depth < 1) return

  const pos = $from.before(1)
  const cur = tr.doc.nodeAt(pos)
  const node = view.state.schema.nodeFromJSON(makeFlowNode(kind, idGen(editor)()) as never)
  if (!node) return

  const emptyText = cur && cur.isTextblock && cur.content.size === 0
  if (emptyText && cur) {
    tr = tr.replaceWith(pos, pos + cur.nodeSize, node)
  } else {
    tr = tr.insert(pos + (cur?.nodeSize ?? 0), node)
  }

  const at = firstTextPos(tr.doc, pos)
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size))))
  view.dispatch(tr)
  editor.commands.focus()
}

/** 在光标所在块下面插一个空段落 */
export function insertParagraphBelow(editor: Editor): void {
  const pos = topLevelPos(editor)
  if (pos === null) return
  const { state, view } = editor
  const node = state.doc.nodeAt(pos)
  const at = pos + (node?.nodeSize ?? 0)
  const para = state.schema.nodes.paragraph
  if (!para) return
  const tr = state.tr.insert(at, para.create({ id: idGen(editor)() }))
  view.dispatch(tr)
  editor.commands.focus(at + 1)
}

/** 把某一块转成目标类型（列表 → 正文会变成多块） */
export function convertBlockAt(editor: Editor, pos: number, target: FlowTarget): boolean {
  const { state, view } = editor
  const node = state.doc.nodeAt(pos)
  if (!node) return false

  const next = convertFlowNodes([node.toJSON() as PmNode], target)
  if (next.length === 0) return false

  const gen = idGen(editor)
  try {
    const nodes = next.map((n) => {
      const attrs = { ...(n.attrs ?? {}) }
      if (!attrs.id) attrs.id = gen()
      return state.schema.nodeFromJSON({ ...n, attrs } as never)
    })
    view.dispatch(state.tr.replaceWith(pos, pos + node.nodeSize, nodes))
    editor.commands.focus()
    return true
  } catch {
    return false
  }
}

/** 复制一块（结构和内容都留，id 换新的） */
export function duplicateBlockAt(editor: Editor, pos: number): void {
  const { state, view } = editor
  const node = state.doc.nodeAt(pos)
  if (!node) return
  const copy = state.schema.nodeFromJSON(cloneBlock(node.toJSON() as PmNode, idGen(editor)) as never)
  view.dispatch(state.tr.insert(pos + node.nodeSize, copy))
}

/** 删一块；删空了就补一个空段落（文档不能空着） */
export function deleteBlockAt(editor: Editor, pos: number): void {
  const { state, view } = editor
  const node = state.doc.nodeAt(pos)
  if (!node) return

  let tr = state.tr.delete(pos, pos + node.nodeSize)
  if (tr.doc.childCount === 0) {
    const para = state.schema.nodes.paragraph
    if (para) tr = tr.insert(0, para.create())
  }
  view.dispatch(tr)
  editor.commands.focus()
}

/**
 * 拖动排序。
 * `to` 是**插入位置**（目标块的起点，或在它后面 = 起点 + nodeSize）。
 */
export function moveBlockTo(editor: Editor, from: number, to: number): void {
  const { state, view } = editor
  const node = state.doc.nodeAt(from)
  if (!node) return
  if (to >= from && to <= from + node.nodeSize) return

  const tr = state.tr.delete(from, from + node.nodeSize)
  const at = to > from ? to - node.nodeSize : to
  tr.insert(Math.max(0, Math.min(at, tr.doc.content.size)), node)
  view.dispatch(tr)
}

/** 图片：插成独立块（别把段落劈开） */
export function insertImageBlock(editor: Editor, src: string, alt: string): void {
  const { state, view } = editor
  const pos = topLevelPos(editor)
  const image = state.schema.nodes.image
  if (!image) return

  const cur = pos === null ? null : state.doc.nodeAt(pos)
  const node = image.create({ id: idGen(editor)(), src, alt })
  let tr = state.tr
  if (pos !== null && cur && cur.isTextblock && cur.content.size === 0) {
    tr = tr.replaceWith(pos, pos + cur.nodeSize, node)
  } else {
    const at = pos === null ? state.doc.content.size : pos + (cur?.nodeSize ?? 0)
    tr = tr.insert(at, node)
  }
  view.dispatch(tr)
}
