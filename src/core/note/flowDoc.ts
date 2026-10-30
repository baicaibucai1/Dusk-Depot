/*
 * `.note` v2 —— 文档流的落盘格式。
 *
 * 目录骨架和 v1 一模一样（一块一个文件、只写变动），
 * 区别只有两处：
 *   ① `.note` 标记里多了 `version: 2` 和 `layoutMode: "flow"`；
 *   ② 块文件里存的是**结构化内容**（见 flow.ts），不是行内 markdown。
 *
 * 为什么不把 v1 直接升级：v1 的 `layout {x,y,w}` 是用户摆出来的版面，
 * 自动迁移等于替用户重排版面。所以两种格式并存，各读各的，谁都不动谁。
 * 将来要做"画布 → 文档流"，那是一个带预览、可撤销的独立操作，不在这里。
 */
import type { Path } from '../model/path'
import { NOTE_APP, NOTE_BLOCKS, NOTE_MARK, NOTE_META, NOTE_ORDER, blockPath, type NoteMeta } from './format'
import { type FlowBlock, isKnownFlowType, pmFromFlow, flowSnapshot } from './flow'

export const FLOW_VERSION = 2
export const FLOW_LAYOUT = 'flow'

export type FlowDoc = {
  meta: NoteMeta
  order: string[]
  blocks: Record<string, FlowBlock>
  version: typeof FLOW_VERSION
  layoutMode: 'flow'
}

/** 写进 `.note` 的标记。人眼可读，程序只认 app/version/layoutMode */
export const FLOW_MARK_TEXT = `${JSON.stringify(
  { app: NOTE_APP, format: 'blocks', version: FLOW_VERSION, layoutMode: FLOW_LAYOUT },
  null,
  2,
)}\n`

export function emptyFlowDoc(title: string, now = new Date()): FlowDoc {
  const id = 'b1'
  return {
    meta: { title, createdAt: now.toISOString() },
    order: [id],
    blocks: { [id]: { id, type: 'paragraph', content: [] } },
    version: FLOW_VERSION,
    layoutMode: 'flow',
  }
}

/* ───────────────────── 解析 ───────────────────── */

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * 一个块文件 → FlowBlock。
 *
 * ⚠️ 认不出/结构不完整的块**一律进 unknown**，原始 JSON 一字不改地留着。
 *    这条是防数据丢失的底线：新版本写的块，旧版本打开再保存，也必须原样活着。
 */
export function parseFlowBlock(id: string, text: string): FlowBlock | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const obj = asObject(raw)
  if (!obj) return null

  const type = typeof obj.type === 'string' ? obj.type : ''
  if (!isKnownFlowType(type)) {
    return { id, type: 'unknown', raw: { ...obj, id } }
  }

  const block: FlowBlock = { id, type: type as FlowBlock['type'] }

  if (type === 'paragraph' || type === 'heading1' || type === 'heading2' || type === 'quote') {
    const content = obj.content
    if (content !== undefined && !Array.isArray(content)) return { id, type: 'unknown', raw: { ...obj, id } }
    block.content = Array.isArray(content) ? (content as FlowBlock['content']) : []
    return block
  }

  if (type === 'code') {
    if (typeof obj.text !== 'string') return { id, type: 'unknown', raw: { ...obj, id } }
    block.text = obj.text
    if (typeof obj.lang === 'string' && obj.lang) block.lang = obj.lang
    return block
  }

  if (type === 'bulletList' || type === 'orderedList' || type === 'todoList') {
    if (!Array.isArray(obj.items)) return { id, type: 'unknown', raw: { ...obj, id } }
    block.items = obj.items
      .map((i) => {
        const it = asObject(i)
        if (!it) return null
        if (!Array.isArray(it.content)) return null
        const item: NonNullable<FlowBlock['items']>[number] = {
          content: it.content as NonNullable<FlowBlock['items']>[number]['content'],
        }
        if (type === 'todoList') item.checked = Boolean(it.checked)
        if (Array.isArray(it.children)) {
          const children = it.children
            .map((c, k) => {
              const co = asObject(c)
              if (!co) return null
              return parseFlowBlock(`${id}c${k}`, JSON.stringify(co))
            })
            .filter((b): b is FlowBlock => Boolean(b))
          if (children.length > 0) item.children = children
        }
        return item
      })
      .filter((i): i is NonNullable<FlowBlock['items']>[number] => Boolean(i))
    return block
  }

  if (type === 'divider') return block

  if (type === 'image') {
    if (typeof obj.src !== 'string') return { id, type: 'unknown', raw: { ...obj, id } }
    block.src = obj.src
    if (typeof obj.alt === 'string' && obj.alt) block.alt = obj.alt
    return block
  }

  if (type === 'columns') {
    if (!Array.isArray(obj.columns)) return { id, type: 'unknown', raw: { ...obj, id } }
    block.columns = obj.columns
      .map((c, k) => {
        const co = asObject(c)
        if (!co) return null
        const width = typeof co.width === 'number' ? Math.min(90, Math.max(10, Math.round(co.width))) : 50
        const blocks = Array.isArray(co.blocks)
          ? co.blocks
              .map((b, j) => {
                const bo = asObject(b)
                if (!bo) return null
                return parseFlowBlock(`${id}c${k}b${j}`, JSON.stringify(bo))
              })
              .filter((b): b is FlowBlock => Boolean(b))
          : []
        return { width, blocks }
      })
      .filter((c): c is NonNullable<FlowBlock['columns']>[number] => Boolean(c))
    return block
  }

  return { id, type: 'unknown', raw: { ...obj, id } }
}

/** 从仓库文件表里解出一篇 v2 文档；不是这个格式就返回 null */
export function parseFlowDoc(dir: Path, files: Record<Path, string>): FlowDoc | null {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  if (!files[`${base}/${NOTE_MARK}`]) return null

  let meta: NoteMeta = { title: base.split('/').pop()?.replace(/\.note$/, '') ?? '未命名', createdAt: '' }
  try {
    const m = JSON.parse(files[`${base}/${NOTE_META}`] ?? '{}') as Partial<NoteMeta>
    if (m && typeof m.title === 'string') meta = { ...meta, ...m, title: m.title }
  } catch {
    /* 元数据坏了不影响正文 */
  }

  let order: string[] = []
  try {
    const o = JSON.parse(files[`${base}/${NOTE_ORDER}`] ?? '[]') as unknown
    if (Array.isArray(o)) order = o.filter((x): x is string => typeof x === 'string')
  } catch {
    order = []
  }

  const blocks: Record<string, FlowBlock> = {}
  const prefix = `${base}/${NOTE_BLOCKS}/`
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith(prefix) || !path.endsWith('.json')) continue
    const id = path.slice(prefix.length, -'.json'.length)
    if (!id || id.includes('/')) continue
    const b = parseFlowBlock(id, text)
    if (b) blocks[id] = b
  }

  // 顺序表里没列到的块补到末尾：宁可多显示，也不静默丢块
  for (const id of Object.keys(blocks)) if (!order.includes(id)) order.push(id)

  return { meta, order, blocks, version: FLOW_VERSION, layoutMode: FLOW_LAYOUT }
}

/* ───────────────────── 序列化 ───────────────────── */

function serializeBlock(block: FlowBlock): string {
  if (block.type === 'unknown') {
    const raw = { ...(block.raw ?? {}) }
    if (block.id) raw.id = block.id
    return `${JSON.stringify(raw, null, 2)}\n`
  }

  const out: Record<string, unknown> = { id: block.id, type: block.type }

  switch (block.type) {
    case 'paragraph':
    case 'heading1':
    case 'heading2':
    case 'quote':
      out.content = block.content ?? []
      break
    case 'code':
      out.text = block.text ?? ''
      if (block.lang) out.lang = block.lang
      break
    case 'bulletList':
    case 'orderedList':
    case 'todoList':
      out.items = (block.items ?? []).map((i) => ({
        ...(block.type === 'todoList' ? { checked: Boolean(i.checked) } : {}),
        content: i.content ?? [],
        ...(i.children && i.children.length > 0 ? { children: i.children.map(stripIds) } : {}),
      }))
      break
    case 'divider':
      break
    case 'image':
      out.src = block.src ?? ''
      if (block.alt) out.alt = block.alt
      break
    case 'columns':
      out.columns = (block.columns ?? []).map((c) => ({
        width: Math.round(c.width),
        blocks: c.blocks.map(stripIds),
      }))
      break
    default:
      break
  }

  return `${JSON.stringify(out, null, 2)}\n`
}

/** 嵌套块不存 id（它们不是独立文件，id 只会带来"撞号"的麻烦） */
function stripIds(block: FlowBlock): Record<string, unknown> {
  const parsed = JSON.parse(serializeBlock({ ...block, id: undefined })) as Record<string, unknown>
  delete parsed.id
  return parsed
}

/** 一篇文档 → 仓库文件表 */
export function flowDocFiles(dir: Path, doc: FlowDoc): Record<Path, string> {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  const out: Record<Path, string> = {}
  out[`${base}/${NOTE_MARK}`] = FLOW_MARK_TEXT
  out[`${base}/${NOTE_META}`] = `${JSON.stringify(doc.meta, null, 2)}\n`
  out[`${base}/${NOTE_ORDER}`] = `${JSON.stringify(doc.order, null, 2)}\n`
  for (const id of Object.keys(doc.blocks)) {
    const b = doc.blocks[id]
    if (b) out[blockPath(base, id)] = serializeBlock({ ...b, id })
  }
  return out
}

/** 只写变动的文件；返回空对象就说明什么都没改 */
export function diffFlowDoc(dir: Path, before: FlowDoc | null, after: FlowDoc): Record<Path, string> {
  const next = flowDocFiles(dir, after)
  const prev = before ? flowDocFiles(dir, before) : {}

  const out: Record<Path, string> = {}
  for (const [path, text] of Object.entries(next)) {
    if (prev[path] !== text) out[path] = text
  }
  return out
}

/** 被删掉的块文件（保存时顺手删） */
export function removedFlowBlockFiles(dir: Path, before: FlowDoc | null, after: FlowDoc): Path[] {
  if (!before) return []
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return Object.keys(before.blocks)
    .filter((id) => !after.blocks[id])
    .map((id) => blockPath(base, id))
}

/* ───────────────────── 与 PM 的整篇互转 ───────────────────── */

export function flowDocToPm(doc: FlowDoc) {
  return pmFromFlow(doc.order, doc.blocks)
}

export function pmToFlowDoc(meta: NoteMeta, pm: { content?: unknown[] }): FlowDoc {
  const snap = flowSnapshot(pm as Parameters<typeof flowSnapshot>[0])
  return {
    meta,
    order: snap.order,
    blocks: snap.blocks,
    version: FLOW_VERSION,
    layoutMode: 'flow',
  }
}
