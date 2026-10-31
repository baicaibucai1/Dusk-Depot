/*
 * `.note` v3 —— **纵向块画布**。
 *
 * ## 目录形状
 *
 *   文档名.note/
 *   ├─ .note                标记：version 3 + layoutMode
 *   ├─ meta.json            标题、创建/更新时间
 *   ├─ board.json           块顺序、布局模式、画布设置（未来 free 视图留的位）
 *   ├─ relations.json       块间连接（类型 + 说明）
 *   ├─ blocks/<id>.json     每块一份
 *   └─ assets/<id>.<ext>    复制进本笔记的图片 / 文件
 *
 * ## 三条底线
 *
 *   ① 旧版（v1 画布 / v2 文档流）**不自动迁移、不写盘**；
 *      这个模块只认识 v3，别的版本由 NoteEditor 交给旧编辑器。
 *   ② 认不出的块、未知字段一律原样保留：旧版本打开新文件再保存，不能丢东西。
 *   ③ 一块一个文件、只写变动；顺序只写 board.json，连接只写 relations.json。
 *
 * 这一层是纯函数（跑在 node 里），不碰 DOM、不碰 React。
 */
import type { Path } from '../model/path'
import {
  NOTE_APP,
  NOTE_BLOCKS,
  NOTE_MARK,
  NOTE_META,
  blockPath,
  type NoteMeta,
} from './format'
import { type Inline, inlineText } from './flow'

export const BOARD_VERSION = 3
export const BOARD_FILE = 'board.json'
export const RELATIONS_FILE = 'relations.json'
export const BOARD_ASSETS = 'assets'
/** 新建文档默认布局。自由排布以后再加，`free` 先只做数据保留 */
export type BoardLayoutMode = 'flow' | 'free'

export type BoardBlockType =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'todo'
  | 'quote'
  | 'image'
  | 'file'
  | 'divider'
  | 'unknown'

export type BoardBlock = {
  id: string
  type: BoardBlockType
  /** 正文 / 标题 / 待办 / 引用 */
  content?: Inline[]
  /** 待办是否勾选 */
  checked?: boolean
  /** 图片 / 文件的仓库内相对路径（`某笔记.note/assets/...`） */
  src?: string
  /** 文件块的原始文件名 */
  name?: string
  /** 文件字节数（展示用） */
  size?: number
  /** 图片 alt */
  alt?: string
  /** 认不出的块：原始 JSON，保存时原样写回 */
  raw?: Record<string, unknown>
  /** 已知块里不认识的字段：原样保留 */
  extra?: Record<string, unknown>
}

export type RelationType = 'related' | 'depends' | 'source' | 'custom'

export const RELATION_TYPES: { id: RelationType; label: string }[] = [
  { id: 'related', label: '相关' },
  { id: 'depends', label: '依赖' },
  { id: 'source', label: '来源' },
  { id: 'custom', label: '自定义' },
]

export type Relation = {
  id: string
  /** 起点块 id */
  from: string
  /** 终点块 id */
  to: string
  type: RelationType
  /** 人写的说明；`custom` 时也可以只靠它 */
  label: string
  createdAt: number
}

export type BoardSettings = Record<string, unknown>

export type BoardDoc = {
  meta: NoteMeta
  version: typeof BOARD_VERSION
  layoutMode: BoardLayoutMode
  order: string[]
  blocks: Record<string, BoardBlock>
  relations: Relation[]
  settings: BoardSettings
}

const KNOWN_FIELDS = new Set(['id', 'type', 'content', 'checked', 'src', 'name', 'size', 'alt'])

export const BOARD_MARK_TEXT = `${JSON.stringify(
  { app: NOTE_APP, format: 'board', version: BOARD_VERSION, layoutMode: 'flow' },
  null,
  2,
)}\n`

export function isBoardVersion(version: number): boolean {
  return version >= BOARD_VERSION
}

export function emptyBoardDoc(title: string, now = new Date()): BoardDoc {
  const id = 'b1'
  return {
    meta: { title, createdAt: now.toISOString() },
    version: BOARD_VERSION,
    layoutMode: 'flow',
    order: [id],
    blocks: { [id]: { id, type: 'paragraph', content: [] } },
    relations: [],
    settings: {},
  }
}

/* ───────────────────── 解析 ───────────────────── */

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function textOfInline(v: unknown): Inline[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v)) return null
  const out: Inline[] = []
  for (const raw of v) {
    const o = asObject(raw)
    if (!o) return null
    if (o.type === 'hardBreak') {
      out.push({ type: 'hardBreak' })
      continue
    }
    if (o.type !== 'text' || typeof o.text !== 'string') return null
    const marks = Array.isArray(o.marks)
      ? o.marks
          .map((m) => {
            if (m === 'bold' || m === 'italic' || m === 'strike' || m === 'code') return m
            const mo = asObject(m)
            if (mo?.type === 'link' && typeof mo.href === 'string' && mo.href) {
              return { type: 'link' as const, href: mo.href }
            }
            return null
          })
          .filter((m): m is NonNullable<typeof m> => Boolean(m))
      : []
    out.push(marks.length ? { type: 'text', text: o.text, marks } : { type: 'text', text: o.text })
  }
  return out
}

/**
 * 一个块文件 → BoardBlock。
 * 结构不完整的**已知类型**降级成 `unknown`（raw 原样留着），
 * 不静默变成空段落 —— 那等于下一次保存把内容删掉。
 */
export function parseBoardBlock(id: string, text: string): BoardBlock | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const obj = asObject(raw)
  if (!obj) return null
  const type = typeof obj.type === 'string' ? obj.type : ''
  const known =
    type === 'paragraph' ||
    type === 'heading1' ||
    type === 'heading2' ||
    type === 'todo' ||
    type === 'quote' ||
    type === 'image' ||
    type === 'file' ||
    type === 'divider'

  if (!known) return { id, type: 'unknown', raw: { ...obj, id } }

  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (!KNOWN_FIELDS.has(k)) extra[k] = v

  const block: BoardBlock = { id, type: type as BoardBlockType }
  if (Object.keys(extra).length > 0) block.extra = extra

  if (type === 'paragraph' || type === 'heading1' || type === 'heading2' || type === 'quote' || type === 'todo') {
    const content = textOfInline(obj.content)
    if (!content) return { id, type: 'unknown', raw: { ...obj, id } }
    block.content = content
    if (type === 'todo') block.checked = Boolean(obj.checked)
    return block
  }

  if (type === 'image') {
    block.src = typeof obj.src === 'string' ? obj.src : ''
    if (typeof obj.alt === 'string' && obj.alt) block.alt = obj.alt
    return block
  }

  if (type === 'file') {
    block.src = typeof obj.src === 'string' ? obj.src : ''
    if (typeof obj.name === 'string' && obj.name) block.name = obj.name
    if (typeof obj.size === 'number' && Number.isFinite(obj.size)) block.size = obj.size
    return block
  }

  return block // divider
}

function parseRelation(raw: unknown, warnings: string[]): Relation | null {
  const o = asObject(raw)
  if (!o) return null
  const from = typeof o.from === 'string' ? o.from : ''
  const to = typeof o.to === 'string' ? o.to : ''
  if (!from || !to) {
    warnings.push('有一条连接缺少起点或终点，已跳过（块本身没动）')
    return null
  }
  const type =
    o.type === 'related' || o.type === 'depends' || o.type === 'source' || o.type === 'custom'
      ? o.type
      : 'related'
  return {
    id: typeof o.id === 'string' && o.id ? o.id : `r-${from}-${to}-${String(o.createdAt ?? '')}`,
    from,
    to,
    type,
    label: typeof o.label === 'string' ? o.label : '',
    createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : Date.now(),
  }
}

export type BoardParseResult = {
  doc: BoardDoc
  warnings: string[]
}

/** 从仓库文件表里解出一篇 v3；不是 v3 就返回 null */
export function parseBoardDoc(dir: Path, files: Record<Path, string>): BoardParseResult | null {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  if (!files[`${base}/${NOTE_MARK}`]) return null

  const warnings: string[] = []
  let meta: NoteMeta = { title: base.split('/').pop()?.replace(/\.note$/, '') ?? '未命名', createdAt: '' }
  try {
    const m = JSON.parse(files[`${base}/${NOTE_META}`] ?? '{}') as Partial<NoteMeta>
    if (m && typeof m.title === 'string') meta = { ...meta, ...m, title: m.title }
  } catch {
    warnings.push('meta.json 坏了，标题先用目录名；正文不受影响')
  }

  if (!files[`${base}/${BOARD_FILE}`]) {
    warnings.push('board.json 不见了，块顺序按文件名排；没有删任何块')
  }

  let layoutMode: BoardLayoutMode = 'flow'
  let order: string[] = []
  let settings: BoardSettings = {}
  try {
    const b = JSON.parse(files[`${base}/${BOARD_FILE}`] ?? '{}') as Record<string, unknown>
    if (b.layoutMode === 'free') layoutMode = 'free'
    if (Array.isArray(b.order)) order = b.order.filter((x): x is string => typeof x === 'string')
    if (asObject(b.settings)) settings = asObject(b.settings) as BoardSettings
  } catch {
    warnings.push('board.json 坏了，块顺序按文件名排；没有删任何块')
  }

  const blocks: Record<string, BoardBlock> = {}
  const prefix = `${base}/${NOTE_BLOCKS}/`
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith(prefix) || !path.endsWith('.json')) continue
    const id = path.slice(prefix.length, -'.json'.length)
    if (!id || id.includes('/')) continue
    const b = parseBoardBlock(id, text)
    if (b) blocks[id] = b
  }

  for (const id of Object.keys(blocks)) if (!order.includes(id)) order.push(id)
  order = order.filter((id) => Boolean(blocks[id]))
  if (order.length === 0 && Object.keys(blocks).length === 0) {
    warnings.push('这块画布是空的（没有块文件）；可以添加一个块继续用')
  }

  let relations: Relation[] = []
  try {
    const raw = JSON.parse(files[`${base}/${RELATIONS_FILE}`] ?? '{"relations":[]}') as unknown
    const list = Array.isArray(raw) ? raw : (asObject(raw)?.relations as unknown[])
    if (Array.isArray(list)) {
      const seen = new Set<string>()
      relations = list
        .map((r) => parseRelation(r, warnings))
        .filter((r): r is Relation => Boolean(r))
        .filter((r) => {
          if (seen.has(r.id)) {
            warnings.push(`连接 id 重复：${r.id}，只保留第一条`)
            return false
          }
          seen.add(r.id)
          return true
        })
    }
  } catch {
    warnings.push('relations.json 坏了，连接暂时读不出来；块本身没动')
  }

  return {
    doc: { meta, version: BOARD_VERSION, layoutMode, order, blocks, relations, settings },
    warnings,
  }
}

/* ───────────────────── 序列化 ───────────────────── */

function serializeBlock(block: BoardBlock): string {
  if (block.type === 'unknown') {
    const raw = { ...(block.raw ?? {}) }
    if (block.id) raw.id = block.id
    return `${JSON.stringify(raw, null, 2)}\n`
  }

  // 先摊未知字段，再写已知字段：新版本加的字段不会因为这里保存而丢
  const out: Record<string, unknown> = { ...(block.extra ?? {}), id: block.id, type: block.type }
  switch (block.type) {
    case 'paragraph':
    case 'heading1':
    case 'heading2':
    case 'quote':
      out.content = block.content ?? []
      break
    case 'todo':
      out.checked = Boolean(block.checked)
      out.content = block.content ?? []
      break
    case 'image':
      out.src = block.src ?? ''
      if (block.alt) out.alt = block.alt
      break
    case 'file':
      out.src = block.src ?? ''
      if (block.name) out.name = block.name
      if (typeof block.size === 'number') out.size = block.size
      break
    case 'divider':
      break
    default:
      break
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/** 一篇文档 → 仓库文件表。assets/ 不在这里（二进制单独写） */
export function boardFiles(dir: Path, doc: BoardDoc): Record<Path, string> {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  const out: Record<Path, string> = {}
  out[`${base}/${NOTE_MARK}`] = BOARD_MARK_TEXT
  out[`${base}/${NOTE_META}`] = `${JSON.stringify(doc.meta, null, 2)}\n`
  out[`${base}/${BOARD_FILE}`] = `${JSON.stringify(
    { version: BOARD_VERSION, layoutMode: doc.layoutMode, order: doc.order, settings: doc.settings },
    null,
    2,
  )}\n`
  out[`${base}/${RELATIONS_FILE}`] = `${JSON.stringify(
    { version: BOARD_VERSION, relations: doc.relations },
    null,
    2,
  )}\n`
  for (const id of Object.keys(doc.blocks)) {
    const b = doc.blocks[id]
    if (b) out[blockPath(base, id)] = serializeBlock(b)
  }
  return out
}

/** 只写变动的文件；返回空对象就说明什么都没改 */
export function diffBoardDoc(dir: Path, before: BoardDoc | null, after: BoardDoc): Record<Path, string> {
  const next = boardFiles(dir, after)
  const prev = before ? boardFiles(dir, before) : {}
  const out: Record<Path, string> = {}
  for (const [path, text] of Object.entries(next)) {
    if (prev[path] !== text) out[path] = text
  }
  return out
}

/** 被删掉的块文件（保存时顺手删） */
export function removedBoardBlockFiles(dir: Path, before: BoardDoc | null, after: BoardDoc): Path[] {
  if (!before) return []
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return Object.keys(before.blocks)
    .filter((id) => !after.blocks[id])
    .map((id) => blockPath(base, id))
}

/* ───────────────────── 编辑 ───────────────────── */

export function nextBoardId(doc: BoardDoc): string {
  let max = 0
  for (const id of Object.keys(doc.blocks)) {
    const m = /^b(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `b${max + 1}`
}

export function newBoardBlock(type: BoardBlockType, id: string): BoardBlock {
  switch (type) {
    case 'todo':
      return { id, type, content: [], checked: false }
    case 'image':
      return { id, type, src: '', alt: '' }
    case 'file':
      return { id, type, src: '', name: '' }
    case 'divider':
      return { id, type }
    default:
      return { id, type, content: [] }
  }
}

export function insertBoardBlock(doc: BoardDoc, afterId: string | null, block: BoardBlock): BoardDoc {
  const order = [...doc.order]
  const at = afterId ? order.indexOf(afterId) : order.length - 1
  order.splice(at + 1, 0, block.id)
  return { ...doc, order, blocks: { ...doc.blocks, [block.id]: block } }
}

export function removeBoardBlock(doc: BoardDoc, id: string): BoardDoc {
  const blocks = { ...doc.blocks }
  delete blocks[id]
  return {
    ...doc,
    order: doc.order.filter((x) => x !== id),
    blocks,
    // 块没了，挂在它身上的连接也一起收掉（连接不能指向空气）
    relations: doc.relations.filter((r) => r.from !== id && r.to !== id),
  }
}

export function updateBoardBlock(doc: BoardDoc, id: string, patch: Partial<BoardBlock>): BoardDoc {
  const cur = doc.blocks[id]
  if (!cur) return doc
  return { ...doc, blocks: { ...doc.blocks, [id]: { ...cur, ...patch, id } } }
}

/** 把块挪到第 index 个位置（插入位置语义，跟 flow 版一致） */
export function moveBoardBlockTo(doc: BoardDoc, id: string, index: number): BoardDoc {
  const from = doc.order.indexOf(id)
  if (from < 0) return doc
  const order = [...doc.order]
  order.splice(from, 1)
  const to = Math.max(0, Math.min(order.length, index > from ? index - 1 : index))
  if (to === from) return doc
  order.splice(to, 0, id)
  return { ...doc, order }
}

export function addRelation(doc: BoardDoc, rel: Relation): BoardDoc {
  const dup = doc.relations.some(
    (r) => r.from === rel.from && r.to === rel.to && r.type === rel.type && r.label === rel.label,
  )
  if (dup) return doc
  return { ...doc, relations: [...doc.relations, rel] }
}

export function removeRelation(doc: BoardDoc, id: string): BoardDoc {
  return { ...doc, relations: doc.relations.filter((r) => r.id !== id) }
}

export function relationsOf(doc: BoardDoc, blockId: string): Relation[] {
  return doc.relations.filter((r) => r.from === blockId || r.to === blockId)
}

/* ───────────────────── 展示用 ───────────────────── */

export function blockText(block: BoardBlock): string {
  if (block.type === 'image') return block.alt || '图片'
  if (block.type === 'file') return block.name || '文件'
  if (block.type === 'divider') return '分隔线'
  if (block.type === 'todo') return `${block.checked ? '[x]' : '[ ]'} ${inlineText(block.content ?? [])}`
  return inlineText(block.content ?? [])
}

/** 关系面板 / 目标选择里的短标签 */
export function blockLabel(block: BoardBlock | undefined, id: string): string {
  if (!block) return `（已删除的块 ${id}）`
  const kind =
    block.type === 'heading1'
      ? 'H1'
      : block.type === 'heading2'
        ? 'H2'
        : block.type === 'todo'
          ? '待办'
          : block.type === 'quote'
            ? '引用'
            : block.type === 'image'
              ? '图片'
              : block.type === 'file'
                ? '文件'
                : block.type === 'divider'
                  ? '分隔线'
                  : block.type === 'unknown'
                    ? '未知块'
                    : '正文'
  const text = blockText(block).replace(/\s+/g, ' ').trim()
  const short = [...text].slice(0, 24).join('')
  return short ? `${kind} · ${short}` : `${kind} · ${id}`
}

export function boardOutline(doc: BoardDoc): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = []
  for (const id of doc.order) {
    const b = doc.blocks[id]
    if (!b) continue
    if (b.type === 'heading1') out.push({ level: 1, text: blockText(b) })
    if (b.type === 'heading2') out.push({ level: 2, text: blockText(b) })
  }
  return out
}

export function boardPlainText(doc: BoardDoc): string {
  return doc.order
    .map((id) => doc.blocks[id])
    .filter((b): b is BoardBlock => Boolean(b))
    .map((b) => blockText(b))
    .join('\n\n')
}

/** 这个资产还被哪块引用（删块后判断孤不孤） */
export function assetRefs(doc: BoardDoc, asset: Path): string[] {
  return doc.order.filter((id) => {
    const b = doc.blocks[id]
    return Boolean(b && (b.type === 'image' || b.type === 'file') && b.src === asset)
  })
}

/** 复制进本笔记的资产命名：`assets/<时间>-<安全文件名>` */
export function assetPath(dir: Path, originalName: string, now = Date.now()): Path {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  const safe = originalName
    .replace(/[\\/:*?"<>|]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  const name = safe || '未命名'
  // 同一毫秒里连续拖入多个文件也不能撞名：加一小段随机后缀
  const salt = Math.random().toString(36).slice(2, 6)
  return `${base}/${BOARD_ASSETS}/${now.toString(36)}-${salt}-${name}`
}
