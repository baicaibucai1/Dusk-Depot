/*
 * `.note` 块文档 ⇄ ProseMirror 文档。
 *
 * 这里是**纯函数**（跑在 node 环境）：编辑器用 ProseMirror 的文档模型，
 * 落盘用我们自己的 `.note` 目录格式，两边靠这两个函数来回转。
 *
 * 为什么要换 ProseMirror：自己用 contentEditable 拼块编辑器，
 * 输入法、选区、撤销、拖拽这些坑永远填不完 —— 专业编辑器早就解决了。
 */
import type { Block, BlockType, NoteDoc } from './format'
import { tokenize } from '../markdown/parse'
import { clampPlacement, type Placement } from './layout'

export type PmMark = {
  type: string
  attrs?: Record<string, unknown>
}

export type PmNode = {
  type: string
  attrs?: Record<string, unknown>
  content?: PmNode[]
  marks?: PmMark[]
  text?: string
}

export type PmDoc = {
  type: 'doc'
  content: PmNode[]
}

/* ───────────────────── 行内 markdown ⇄ PM 行内 ───────────────────── */

/** 行内 markdown → PM 行内节点数组 */
export function inlineToPm(text: string): PmNode[] {
  const out: PmNode[] = []
  const lines = text.split('\n')

  lines.forEach((line, i) => {
    if (i > 0) out.push({ type: 'hardBreak' })

    for (const tok of tokenize(line)) {
      switch (tok.t) {
        case 'bold':
          out.push({ type: 'text', text: tok.v, marks: [{ type: 'bold' }] })
          break
        case 'italic':
          out.push({ type: 'text', text: tok.v, marks: [{ type: 'italic' }] })
          break
        case 'strike':
          out.push({ type: 'text', text: tok.v, marks: [{ type: 'strike' }] })
          break
        case 'code':
          out.push({ type: 'text', text: tok.v, marks: [{ type: 'code' }] })
          break
        case 'link':
          out.push({
            type: 'text',
            text: tok.v,
            marks: [{ type: 'link', attrs: { href: tok.href } }],
          })
          break
        case 'wiki':
          out.push({ type: 'text', text: `[[${tok.v}]]` })
          break
        case 'tag':
          out.push({ type: 'text', text: `#${tok.v}` })
          break
        case 'math':
          out.push({ type: 'text', text: `$${tok.v}$` })
          break
        case 'image':
          out.push({ type: 'text', text: `![${tok.alt}](${tok.src})` })
          break
        default:
          // 硬换行在行内流里就是一个 hardBreak
          if (tok.t === 'br') out.push({ type: 'hardBreak' })
          else if (tok.v) out.push({ type: 'text', text: tok.v })
      }
    }
  })

  return out
}

/** PM 行内节点 → 行内 markdown */
export function pmInlineToMarkdown(nodes: PmNode[] = []): string {
  let out = ''

  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      out += '\n'
      continue
    }
    if (n.type !== 'text') continue

    let t = n.text ?? ''
    if (!t) continue

    const marks = n.marks ?? []
    const has = (m: string) => marks.some((x) => x.type === m)

    if (has('code')) t = `\`${t}\``
    if (has('bold')) t = `**${t}**`
    if (has('italic')) t = `*${t}*`
    if (has('strike')) t = `~~${t}~~`

    const link = marks.find((m) => m.type === 'link')
    if (link) t = `[${t}](${String(link.attrs?.href ?? '')})`

    out += t
  }

  return out
}

/* ───────────────────── 块 ⇄ PM 顶层节点 ───────────────────── */

function blockToNode(b: Block): PmNode {
  if (b.type === 'columns' && b.columns) {
    return {
      type: 'columns',
      attrs: { id: b.id, layout: b.layout ?? null },
      content: b.columns.map((col) => ({
        type: 'column',
        attrs: { width: Math.round(col.width) },
        content: col.blocks.map(blockToNode),
      })),
    }
  }

  if (b.type === 'image') {
    return {
      type: 'image',
      attrs: { id: b.id, src: b.src ?? '', alt: b.alt ?? '', layout: b.layout ?? null },
    }
  }

  const content = inlineToPm(b.text)
  if (b.type === 'heading') {
    return {
      type: 'heading',
      attrs: { id: b.id, level: b.level ?? 1, layout: b.layout ?? null },
      content: content.length > 0 ? content : undefined,
    }
  }

  return {
    type: 'paragraph',
    attrs: { id: b.id, layout: b.layout ?? null },
    content: content.length > 0 ? content : undefined,
  }
}

export function blocksToPm(doc: NoteDoc): PmDoc {
  return {
    type: 'doc',
    content: doc.order
      .map((id) => doc.blocks[id])
      .filter((b): b is Block => Boolean(b))
      .map(blockToNode),
  }
}

export function pmToBlocks(pm: PmDoc): NoteDoc['blocks'] {
  const blocks: NoteDoc['blocks'] = {}

  for (const node of pm.content ?? []) {
    const id = String(node.attrs?.id ?? '')
    if (!id) continue

    const block = nodeToBlock(node)
    if (block) blocks[id] = block
  }

  return blocks
}

/** PM 节点（顶层或列内）→ 块 */
function nodeToBlock(node: PmNode): Block | null {
  const id = String(node.attrs?.id ?? '')
  if (!id) return null
  const rawLayout = node.attrs?.layout as { x?: unknown; y?: unknown; w?: unknown } | null
  const layout: Placement | undefined =
    rawLayout && typeof rawLayout.x === 'number' && typeof rawLayout.y === 'number' && typeof rawLayout.w === 'number'
      ? clampPlacement({ x: rawLayout.x, y: rawLayout.y, w: rawLayout.w })
      : undefined

  if (node.type === 'columns') {
    const columns = (node.content ?? [])
      .filter((col) => col.type === 'column')
      .map((col) => ({
        width: typeof col.attrs?.width === 'number' ? (col.attrs.width as number) : 50,
        blocks: (col.content ?? [])
          .map((child) => nodeToBlock(child))
          .filter((b): b is Block => Boolean(b)),
      }))
    return { id, type: 'columns', text: '', ...(layout ? { layout } : {}), columns }
  }

  if (node.type === 'image') {
    return {
      id,
      type: 'image',
      text: '',
      src: String(node.attrs?.src ?? ''),
      ...(node.attrs?.alt ? { alt: String(node.attrs.alt) } : {}),
      ...(layout ? { layout } : {}),
    }
  }

  const text = pmInlineToMarkdown(node.content)
  if (node.type === 'heading') {
    return { id, type: 'heading', text, level: node.attrs?.level === 2 ? 2 : 1, ...(layout ? { layout } : {}) }
  }
  return { id, type: 'paragraph' as BlockType, text, ...(layout ? { layout } : {}) }
}

/** 顺序表直接从 PM 顶层节点拿（节点 id 就是块 id） */
export function pmOrder(pm: PmDoc): string[] {
  return (pm.content ?? [])
    .map((n) => String(n.attrs?.id ?? ''))
    .filter((id) => id.length > 0)
}

export type PmSnapshot = { order: string[]; blocks: NoteDoc['blocks'] }

export function pmToSnapshot(pm: PmDoc): PmSnapshot {
  return { order: pmOrder(pm), blocks: pmToBlocks(pm) }
}
