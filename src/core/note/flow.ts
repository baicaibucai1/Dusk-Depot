/*
 * `.note` 第二版：**文档流**块模型 ⇄ ProseMirror JSON。
 *
 * ## 跟 v1 的分界（写在最前面，别混）
 *
 *   v1 是自由画布：块带 `layout {x,y,w}`，位置是用户的决定；
 *   v2 是文档流：块只按 `order.json` 的顺序竖着排，**没有位置**。
 *
 *   两个格式各自有解析/序列化（v1 在 format.ts，v2 在 flowDoc.ts），
 *   共用同一个 `.note/` 目录骨架和"一块一个文件、只写变动"的落盘纪律。
 *   这里只放**纯函数**：块模型 ⇄ PM 节点，跑在 node 里、可单测。
 *
 * ## 块模型长什么样
 *
 *   { id: "b12", type: "paragraph", content: [{ type: "text", text: "重要", marks: ["bold"] }] }
 *   { id: "b13", type: "code", text: "npm i", lang: "bash" }
 *   { id: "b14", type: "bulletList", items: [{ content: [...], children: [...] }] }
 *
 * 三条约束：
 *   ① 列表的层级是**显式结构**（item.children），不从 DOM 层级反推；
 *   ② 认不出的块存 `type: "unknown"` + 原始 JSON（raw），保存时原样写回，
 *      绝不静默降级成正文、也绝不删掉；
 *   ③ 行内格式只留 粗/斜/删/行内码/链接 —— schema 里也只开这几样，
 *      所以"文档里存在但存不下来"的格式在这套编辑器里根本进不来。
 */
import type { PmMark, PmNode } from './pm'

/* ───────────────────────── 类型 ───────────────────────── */

export type InlineMark = 'bold' | 'italic' | 'strike' | 'code' | { type: 'link'; href: string }

export type Inline =
  | { type: 'text'; text: string; marks?: InlineMark[] }
  | { type: 'hardBreak' }

export type FlowListType = 'bulletList' | 'orderedList' | 'todoList'
export type FlowTextType = 'paragraph' | 'heading1' | 'heading2' | 'quote'
export type FlowType = FlowTextType | FlowListType | 'code' | 'divider' | 'image' | 'columns' | 'unknown'

export type FlowListItem = {
  content: Inline[]
  /** 只对待办列表有意义 */
  checked?: boolean
  /** 这一项下面挂的块（一般是更深一层的列表；也可能是段落） */
  children?: FlowBlock[]
}

export type FlowColumn = { width: number; blocks: FlowBlock[] }

export type FlowBlock = {
  /** 顶层块必有（BlockIds 插件补）；列里的块可以没有 */
  id?: string
  type: FlowType
  /** 段落 / 标题 / 引用 */
  content?: Inline[]
  /** 代码块：原样的多行文本 */
  text?: string
  /** 代码块语言（fence info） */
  lang?: string
  src?: string
  alt?: string
  items?: FlowListItem[]
  columns?: FlowColumn[]
  /** type === 'unknown'：原始 JSON，保存时原样写回 */
  raw?: Record<string, unknown>
}

/** 可以在菜单里"转换"到的块类型 */
export type FlowTarget =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'quote'
  | 'code'
  | 'bulletList'
  | 'orderedList'
  | 'todoList'

/** 可以凭空插入的块类型（斜杠菜单 / 块菜单） */
export type FlowInsertable = FlowTarget | 'divider' | 'image' | 'columns'

const TEXT_TYPES = new Set<string>(['paragraph', 'heading1', 'heading2', 'quote'])
const LIST_TYPES = new Set<string>(['bulletList', 'orderedList', 'todoList'])
const KNOWN_TYPES = new Set<string>([
  ...TEXT_TYPES,
  ...LIST_TYPES,
  'code',
  'divider',
  'image',
  'columns',
])

export function isTextType(t: string): t is FlowTextType {
  return TEXT_TYPES.has(t)
}

export function isListType(t: string): t is FlowListType {
  return LIST_TYPES.has(t)
}

export function isKnownFlowType(t: string): boolean {
  return KNOWN_TYPES.has(t)
}

/* ───────────────────── 行内：PM ⇄ 我们的形状 ───────────────────── */

function markOf(m: PmMark): InlineMark | null {
  if (m.type === 'link') {
    const href = String(m.attrs?.href ?? '')
    return href ? { type: 'link', href } : null
  }
  if (m.type === 'bold' || m.type === 'italic' || m.type === 'strike' || m.type === 'code') {
    return m.type
  }
  return null
}

const MARKS_ORDER = ['bold', 'italic', 'strike', 'code']

function sortMarks(marks: InlineMark[]): InlineMark[] {
  return [...marks].sort((a, b) => {
    const ai = typeof a === 'string' ? MARKS_ORDER.indexOf(a) : 99
    const bi = typeof b === 'string' ? MARKS_ORDER.indexOf(b) : 99
    return ai - bi
  })
}

function sameMarks(a?: InlineMark[], b?: InlineMark[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
}

/** PM 行内节点 → Inline[]（相邻同样式的文本合并，文件里别碎成一地） */
export function inlineOf(nodes: PmNode[] = []): Inline[] {
  const out: Inline[] = []
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      out.push({ type: 'hardBreak' })
      continue
    }
    if (n.type !== 'text' || !n.text) continue

    const marks = (n.marks ?? [])
      .map(markOf)
      .filter((m): m is InlineMark => m !== null)
    const sorted = marks.length > 1 ? sortMarks(marks) : marks

    const last = out[out.length - 1]
    if (last && last.type === 'text' && sameMarks(last.marks, sorted.length ? sorted : undefined)) {
      last.text += n.text
      continue
    }
    out.push(sorted.length ? { type: 'text', text: n.text, marks: sorted } : { type: 'text', text: n.text })
  }
  return out
}

function pmMarks(marks?: InlineMark[]): PmMark[] | undefined {
  if (!marks || marks.length === 0) return undefined
  return marks.map((m) => (typeof m === 'string' ? { type: m } : { type: 'link', attrs: { href: m.href } }))
}

/** Inline[] → PM 行内节点 */
export function inlineNodes(inline: Inline[] = []): PmNode[] {
  const out: PmNode[] = []
  for (const i of inline) {
    if (i.type === 'hardBreak') {
      out.push({ type: 'hardBreak' })
      continue
    }
    if (!i.text) continue
    const marks = pmMarks(i.marks)
    out.push(marks ? { type: 'text', text: i.text, marks } : { type: 'text', text: i.text })
  }
  return out
}

/** 行内纯文本（大纲 / 反链 / 纯文本复制都用它） */
export function inlineText(inline: Inline[] = []): string {
  let out = ''
  for (const i of inline) {
    if (i.type === 'hardBreak') out += '\n'
    else out += i.text
  }
  return out
}

/* ───────────────────── 块：PM → 我们的形状 ───────────────────── */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function textOfNodes(nodes: PmNode[] = []): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') out += n.text ?? ''
    else if (n.type === 'hardBreak') out += '\n'
  }
  return out
}

function itemsOf(node: PmNode, todo: boolean): FlowListItem[] {
  const out: FlowListItem[] = []
  for (const li of node.content ?? []) {
    if (li.type !== 'listItem' && li.type !== 'taskItem') continue
    const kids = li.content ?? []
    const head = kids[0]?.type === 'paragraph' ? kids[0] : undefined
    const rest = head ? kids.slice(1) : kids

    const item: FlowListItem = { content: inlineOf(head?.content ?? []) }
    if (todo) item.checked = Boolean(li.attrs?.checked)
    const children = rest.map((n) => flowBlockOf(n)).filter((b) => b.type !== 'unknown' || b.raw)
    if (children.length > 0) item.children = children
    out.push(item)
  }
  return out
}

/**
 * 一个 PM 块节点 → FlowBlock。
 * 认不出的节点**不丢**：整份 PM JSON 留在 raw 里，保存时原样写回。
 */
export function flowBlockOf(node: PmNode, fallbackId?: string): FlowBlock {
  const id = String(node.attrs?.id ?? fallbackId ?? '') || undefined
  const base = id ? { id } : {}

  switch (node.type) {
    case 'paragraph':
      return { ...base, type: 'paragraph', content: inlineOf(node.content) }

    case 'heading': {
      const level = Number(node.attrs?.level ?? 1)
      return { ...base, type: level >= 2 ? 'heading2' : 'heading1', content: inlineOf(node.content) }
    }

    case 'blockquote': {
      const paras = (node.content ?? []).filter((n) => n.type === 'paragraph')
      const content: Inline[] = []
      paras.forEach((p, i) => {
        if (i > 0) content.push({ type: 'hardBreak' })
        content.push(...inlineOf(p.content))
      })
      return { ...base, type: 'quote', content }
    }

    case 'codeBlock': {
      const lang = node.attrs?.language
      return {
        ...base,
        type: 'code',
        text: textOfNodes(node.content),
        ...(typeof lang === 'string' && lang ? { lang } : {}),
      }
    }

    case 'bulletList':
      return { ...base, type: 'bulletList', items: itemsOf(node, false) }
    case 'orderedList':
      return { ...base, type: 'orderedList', items: itemsOf(node, false) }
    case 'taskList':
      return { ...base, type: 'todoList', items: itemsOf(node, true) }

    case 'horizontalRule':
      return { ...base, type: 'divider' }

    case 'image':
      return {
        ...base,
        type: 'image',
        src: String(node.attrs?.src ?? ''),
        ...(node.attrs?.alt ? { alt: String(node.attrs.alt) } : {}),
      }

    case 'columns':
      return {
        ...base,
        type: 'columns',
        columns: (node.content ?? [])
          .filter((c) => c.type === 'column')
          .map((c) => ({
            width: typeof c.attrs?.width === 'number' ? Math.round(c.attrs.width as number) : 50,
            blocks: (c.content ?? []).map((b) => flowBlockOf(b)),
          })),
      }

    case 'flowUnknown': {
      const raw = node.attrs?.raw
      const parsed = typeof raw === 'string' ? safeParse(raw) : null
      return { ...base, type: 'unknown', raw: parsed ?? { type: 'unknown', content: node } }
    }

    default:
      return { ...base, type: 'unknown', raw: node as unknown as Record<string, unknown> }
  }
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return asRecord(v)
  } catch {
    return null
  }
}

/* ───────────────────── 块：我们的形状 → PM ───────────────────── */

function paraNode(content: Inline[]): PmNode {
  const nodes = inlineNodes(content)
  return nodes.length ? { type: 'paragraph', content: nodes } : { type: 'paragraph' }
}

function itemNode(item: FlowListItem, type: FlowListType): PmNode {
  const content: PmNode[] = [paraNode(item.content)]
  for (const child of item.children ?? []) {
    const n = pmNodeOf(child)
    if (n) content.push(n)
  }
  if (type === 'todoList') {
    return { type: 'taskItem', attrs: { checked: Boolean(item.checked) }, content }
  }
  return { type: 'listItem', content }
}

/**
 * FlowBlock → PM 节点。形不成合法节点时返回 null（调用方跳过，别让整篇打不开）。
 */
export function pmNodeOf(block: FlowBlock): PmNode | null {
  const attrs = block.id ? { id: block.id } : {}

  switch (block.type) {
    case 'paragraph':
      return { type: 'paragraph', attrs, content: inlineNodes(block.content) }

    case 'heading1':
      return { type: 'heading', attrs: { ...attrs, level: 1 }, content: inlineNodes(block.content) }

    case 'heading2':
      return { type: 'heading', attrs: { ...attrs, level: 2 }, content: inlineNodes(block.content) }

    case 'quote': {
      const content = inlineNodes(block.content)
      return { type: 'blockquote', attrs, content: [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }] }
    }

    case 'code':
      return {
        type: 'codeBlock',
        attrs: { ...attrs, language: block.lang ?? null },
        content: block.text ? [{ type: 'text', text: block.text }] : undefined,
      }

    case 'bulletList':
    case 'orderedList':
    case 'todoList': {
      const items = (block.items ?? []).map((i) => itemNode(i, block.type as FlowListType))
      // 列表至少要有一项，否则 schema 不认
      if (items.length === 0) items.push(itemNode({ content: [] }, block.type as FlowListType))
      if (block.type === 'bulletList') return { type: 'bulletList', attrs, content: items }
      if (block.type === 'orderedList') return { type: 'orderedList', attrs: { ...attrs, start: 1 }, content: items }
      return { type: 'taskList', attrs, content: items }
    }

    case 'divider':
      return { type: 'horizontalRule', attrs }

    case 'image':
      return {
        type: 'image',
        attrs: { ...attrs, src: block.src ?? '', alt: block.alt ?? '' },
      }

    case 'columns': {
      const cols = (block.columns ?? []).map((c) => ({
        type: 'column',
        attrs: { width: Math.min(90, Math.max(10, Math.round(c.width || 50))) },
        content: c.blocks
          .map((b) => pmNodeOf(b))
          .filter((n): n is PmNode => Boolean(n)),
      }))
      if (cols.length === 0) return null
      return { type: 'columns', attrs, content: cols }
    }

    case 'unknown': {
      const raw = block.raw ?? {}
      return {
        type: 'flowUnknown',
        attrs: {
          ...attrs,
          raw: JSON.stringify(raw),
          label: typeof raw.type === 'string' ? raw.type : '未知块',
        },
      }
    }

    default:
      return null
  }
}

/* ───────────────────── 整篇 ───────────────────── */

export type FlowSnapshot = { order: string[]; blocks: Record<string, FlowBlock> }

/** PM 文档 → 顶层块表 + 顺序（嵌套内容跟着父块走，不单独成文件） */
export function flowSnapshot(pm: { content?: PmNode[] }): FlowSnapshot {
  const order: string[] = []
  const blocks: Record<string, FlowBlock> = {}

  for (const node of pm.content ?? []) {
    const id = String(node.attrs?.id ?? '')
    if (!id) continue
    order.push(id)
    blocks[id] = flowBlockOf(node, id)
  }
  return { order, blocks }
}

/** 顶层块表 + 顺序 → PM 文档 */
export function pmFromFlow(order: string[], blocks: Record<string, FlowBlock>): { type: 'doc'; content: PmNode[] } {
  const content: PmNode[] = []
  for (const id of order) {
    const block = blocks[id]
    if (!block) continue
    const node = pmNodeOf({ ...block, id: block.id ?? id })
    if (node) content.push(node)
  }
  return { type: 'doc', content }
}

/** 纯文本（右栏反链、复制用） */
export function blockText(block: FlowBlock): string {
  switch (block.type) {
    case 'paragraph':
    case 'heading1':
    case 'heading2':
    case 'quote':
      return inlineText(block.content)
    case 'code':
      return block.text ?? ''
    case 'divider':
      return ''
    case 'image':
      return `![](${block.src ?? ''})`
    case 'bulletList':
    case 'orderedList':
    case 'todoList':
      return (block.items ?? []).map((i) => inlineText(i.content)).join('\n')
    case 'columns':
      return (block.columns ?? []).map((c) => c.blocks.map(blockText).join('\n')).join('\n')
    default:
      return ''
  }
}

/* ───────────────────── 新建 / 转换（块菜单用） ───────────────────── */

/** 造一个空块（斜杠菜单、转换、复制都要它） */
export function emptyBlock(type: FlowInsertable, id: string): FlowBlock {
  switch (type) {
    case 'paragraph':
      return { id, type, content: [] }
    case 'heading1':
    case 'heading2':
    case 'quote':
      return { id, type, content: [] }
    case 'code':
      return { id, type, text: '', lang: '' }
    case 'bulletList':
    case 'orderedList':
    case 'todoList':
      return { id, type, items: [{ content: [] }] }
    case 'divider':
      return { id, type }
    case 'image':
      return { id, type, src: '' }
    case 'columns':
      return {
        id,
        type,
        columns: [
          { width: 50, blocks: [{ type: 'paragraph', content: [] }] },
          { width: 50, blocks: [{ type: 'paragraph', content: [] }] },
        ],
      }
  }
}

/** 空的 PM 块节点（插入用） */
export function makeFlowNode(type: FlowInsertable, id: string): PmNode | null {
  return pmNodeOf(emptyBlock(type, id))
}

/**
 * 把若干顶层块转成目标类型。
 *
 * 返回**一串**节点：列表 → 正文会摊成多个段落。第一个节点保留原 id，
 * 其余没有 id，交给 BlockIds 插件补 —— 这样落盘时"改类型"仍然只动一块的文件。
 *
 * 结构上转不了的（图片/分栏/分隔线 ↔ 文字）返回空数组，调用方保持原样。
 */
export function convertFlowNodes(nodes: PmNode[], target: FlowTarget): PmNode[] {
  if (nodes.length === 0) return []
  const keepId = String(nodes[0]?.attrs?.id ?? '')
  const blocks = nodes.map((n) => flowBlockOf(n))

  const withId = (node: PmNode, first: boolean): PmNode => {
    if (!first || !keepId) return node
    return { ...node, attrs: { ...(node.attrs ?? {}), id: keepId } }
  }

  if (isListType(target)) {
    const items: FlowListItem[] = []
    for (const b of blocks) items.push(...itemsForList(b))
    if (items.length === 0) return []
    const node = pmNodeOf({ type: target, items })
    if (!node) return []
    return [withId(node, true)]
  }

  const out: PmNode[] = []
  for (const b of blocks) {
    for (const inline of contentsForText(b)) {
      const built = pmNodeOf(textBlockOf(target, inline))
      if (built) out.push(withId(built, out.length === 0))
    }
  }
  return out
}

function textBlockOf(target: Exclude<FlowTarget, FlowListType>, content: Inline[]): FlowBlock {
  if (target === 'code') {
    return { type: 'code', text: inlineText(content), lang: '' }
  }
  return { type: target, content }
}

/** 把一个块拆成"若干段行内内容"——列表摊平、代码拆行 */
function contentsForText(block: FlowBlock): Inline[][] {
  switch (block.type) {
    case 'paragraph':
    case 'heading1':
    case 'heading2':
    case 'quote':
      return [block.content ?? []]
    case 'code':
      return [[{ type: 'text', text: block.text ?? '' }]]
    case 'bulletList':
    case 'orderedList':
    case 'todoList':
      return (block.items ?? []).flatMap((item) => {
        const own: Inline[][] = [item.content]
        for (const child of item.children ?? []) own.push(...contentsForText(child))
        return own
      })
    default:
      return []
  }
}

/** 把一个块拆成列表项 */
function itemsForList(block: FlowBlock): FlowListItem[] {
  switch (block.type) {
    case 'paragraph':
    case 'heading1':
    case 'heading2':
    case 'quote':
      return [{ content: block.content ?? [] }]
    case 'code':
      return [{ content: [{ type: 'text', text: block.text ?? '' }] }]
    case 'bulletList':
    case 'orderedList':
    case 'todoList':
      return (block.items ?? []).map((i) => ({
        content: i.content,
        ...(i.children ? { children: i.children } : {}),
      }))
    default:
      return []
  }
}

/** 复制一块：同结构、新 id（列表/分栏里的 id 也要换，否则两块撞号） */
export function cloneBlock(node: PmNode, nextId: () => string): PmNode {
  const changed = (n: PmNode, top: boolean): PmNode => {
    const attrs = { ...(n.attrs ?? {}) }
    if (top || typeof attrs.id === 'string') attrs.id = nextId()
    const content = (n.content ?? []).map((c) => changed(c, false))
    return {
      type: n.type,
      ...(Object.keys(attrs).length ? { attrs } : {}),
      ...(n.marks ? { marks: n.marks } : {}),
      ...(n.text !== undefined ? { text: n.text } : {}),
      ...(content.length ? { content } : {}),
    }
  }
  return changed(node, true)
}

/** 大纲：只认一级/二级标题 */
export function flowOutline(blocks: FlowBlock[]): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = []
  for (const b of blocks) {
    if (b.type !== 'heading1' && b.type !== 'heading2') continue
    const text = inlineText(b.content ?? []).trim()
    if (!text) continue
    out.push({ level: b.type === 'heading1' ? 1 : 2, text })
  }
  return out
}
