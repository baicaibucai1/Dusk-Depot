/*
 * `.note` —— 块笔记格式（Notion 那套的最小实现）。
 *
 * ## 形状：一个 `.note` **目录就是一篇文档**
 *
 *   我的笔记.note/
 *   ├─ .note                 标记 + 格式版本（跟 .zzq 一个路子）
 *   ├─ meta.json             标题、创建时间
 *   ├─ order.json            顶层块的顺序（只存 id）
 *   └─ blocks/
 *      ├─ b1.json            一块一个文件
 *      ├─ b2.json
 *      └─ …
 *
 * ## 为什么不是一个 content.json
 *
 * 一条：**改一段只写一个文件**。
 *   · 编辑正文 → 只碰 `blocks/<id>.json`
 *   · 增删/移动 → 才碰 `order.json`
 *   · 改标题   → 才碰 `meta.json`
 * 这一条跟 .md 那边"增量落盘"是同一条纪律：不许因为改一个字就重写整篇。
 *
 * 附带好处：块文件小、可 diff、可 grep；坏掉一块只丢一块，不至于整篇打不开。
 *
 * ## 块里存什么
 *
 * `text` 存的是**行内 markdown**（`**粗**`、`[链接](路径)`），不是富文本 delta。
 * 这样块文件仍然是可读文本、能 grep、能拿别的工具看，也不会把 markdown 变成私有格式。
 */
import type { Path } from '../model/path'
import { clampPlacement, type Placement } from './layout'

export const NOTE_SUFFIX = '.note'
/** 目录里的标记文件（名字跟后缀一样，一眼知道这是 .note 文档） */
export const NOTE_MARK = '.note'
export const NOTE_META = 'meta.json'
export const NOTE_ORDER = 'order.json'
export const NOTE_BLOCKS = 'blocks'

export const NOTE_APP = 'dusk-depot'
export const NOTE_VERSION = 1

/**
 * 第一批块类型。
 *
 * 「标题」没有卡片边框（它是页面上的标题，不是一张卡）；
 * 「正文」是卡片，块内支持 md 行内语法；
 * 「图片」是卡片，图片进图库（`附件/`），块里只存路径。
 *
 * 旧的 list/todo/quote/code/divider 已经删掉 —— 读旧文件时会降级成正文。
 */
export type BlockType = 'heading' | 'paragraph' | 'image' | 'columns'

/** 分栏里的一列：宽度是百分比，内容是一串块（可以是任意块类型） */
export type Column = {
  width: number
  blocks: Block[]
}

/** @deprecated 旧字段：早期版本用"占几列"表达宽度，现在只为读老文件 */
export type BlockWidth = number

export type Block = {
  id: string
  type: BlockType
  /** 正文/标题：行内 markdown；图片块用不到 */
  text: string
  /** 标题用：1 = 大标题，2 = 小标题 */
  level?: 1 | 2
  /** 图片用：仓库里的相对路径（`附件/xxx.png`） */
  src?: string
  /** 自由排版位置；缺省 = 还没摆过，按顺序往下堆 */
  layout?: Placement
  /** @deprecated 旧的"占几列"，只为读老文件 */
  width?: BlockWidth
  /** 图片的说明文字（alt） */
  alt?: string
  /**
   * type === 'columns' 时：各列的宽度与内容。
   *
   * ⚠️ 列里的块**没有自己的文件** —— 它们跟着这个 columns 块一起存在同一个 JSON 里。
   *    理由：一列里的块如果各占一个文件，删列/换列会产生一堆"孤儿文件"，
   *    而分栏本来就是"这一块内部的排版"，不是独立文档。
   */
  columns?: Column[]
}

/** 老文件里的类型 → 现在的类型（不能因为格式变了就打不开） */
/** 存盘时统一收成一位小数、夹进合法范围 */
function roundPlacement(p: { x: number; y: number; w: number }): Placement {
  return clampPlacement(p)
}

/**
 * 读位置。
 * 老的 `width`（'half' 或 1..12 列 / 20..100 百分比）没有位置信息，
 * 折算成宽度、位置留空 —— 留空就会按顺序往下堆，不会所有块叠在左上角。
 */
function placementOf(rawLayout: unknown): { layout?: Placement } {
  const l = rawLayout as { x?: unknown; y?: unknown; w?: unknown } | undefined
  if (l && typeof l.x === 'number' && typeof l.y === 'number' && typeof l.w === 'number') {
    return { layout: clampPlacement({ x: l.x, y: l.y, w: l.w }) }
  }
  return {}
}
const LEGACY_TYPE: Record<string, BlockType> = {
  paragraph: 'paragraph',
  heading: 'heading',
  image: 'image',
  columns: 'columns',
  bulleted_list_item: 'paragraph',
  todo: 'paragraph',
  quote: 'paragraph',
  code: 'paragraph',
  divider: 'paragraph',
}


export type NoteMeta = {
  title: string
  createdAt: string
  updatedAt?: string
}

export type NoteDoc = {
  meta: NoteMeta
  order: string[]
  blocks: Record<string, Block>
}

/** `foo/bar.note` → true。只看后缀，不看存不存在 */
export function isNoteDocPath(path: Path): boolean {
  return path.toLowerCase().endsWith(NOTE_SUFFIX)
}

/**
 * 这份 `.note` 是哪一版、什么布局。
 *
 * v1（没写 version / version: 1）、v2（version: 2 + layoutMode: "flow"）、
 * v3（version: 3 + layoutMode: "flow"|"free"，纵向块画布）。
 * **不认识的新版本不猜**：`version >= 3` 时 layoutMode 走标记里写的那个，
 * 没写就当 flow（宁可当成新版打开，也不要拿 v1 的画布去覆盖它）。
 */
export type NoteLayoutMode = 'canvas' | 'flow'
export type NoteMarker = { version: number; layoutMode: NoteLayoutMode }

export function readNoteMarker(dir: Path, files: Record<Path, string>): NoteMarker | null {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  const raw = files[`${base}/${NOTE_MARK}`]
  if (!raw) return null

  try {
    const m = JSON.parse(raw) as { version?: unknown; layoutMode?: unknown }
    const version = typeof m.version === 'number' ? m.version : 1
    const mode =
      m.layoutMode === 'flow' || m.layoutMode === 'canvas'
        ? m.layoutMode
        : version >= 2
          ? 'flow'
          : 'canvas'
    return { version, layoutMode: mode }
  } catch {
    return null
  }
}

/**
 * 标记坏了（或压根没有 version）时的兜底判断。
 *
 * 不靠猜后缀里的日期，只看块文件的形状：有 `content` / `items` 数组的就是 v2。
 * 这条兜底的唯一目的是**别把 v2 的块当 v1 解析成空正文再保存回去**——那是真丢数据。
 */
export function inferNoteMarker(dir: Path, files: Record<Path, string>): NoteMarker {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  // v3 的 board.json 是一眼能认出来的形状，优先于块文件猜
  if (files[`${base}/board.json`]) return { version: 3, layoutMode: 'flow' }
  const prefix = `${base}/${NOTE_BLOCKS}/`
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith(prefix) || !path.endsWith('.json')) continue
    try {
      const b = JSON.parse(text) as { type?: unknown; content?: unknown; items?: unknown; text?: unknown }
      if (Array.isArray(b.content) || Array.isArray(b.items)) return { version: 2, layoutMode: 'flow' }
      if (b.type === 'divider' || b.type === 'bulletList' || b.type === 'todoList') {
        return { version: 2, layoutMode: 'flow' }
      }
      if (typeof b.text === 'string') return { version: 1, layoutMode: 'canvas' }
    } catch {
      /* 坏块不参与判断 */
    }
  }
  return { version: 1, layoutMode: 'canvas' }
}

/** 块文件在仓库里的路径 */
export function blockPath(dir: Path, id: string): Path {
  return `${dir}/${NOTE_BLOCKS}/${id}.json`
}

/* ───────────────────────── 读写 ───────────────────────── */

const MARK_TEXT = `${JSON.stringify(
  { app: NOTE_APP, format: 'blocks', version: NOTE_VERSION },
  null,
  2,
)}\n`

function parseBlock(id: string, text: string): Block | null {
  try {
    const raw = JSON.parse(text) as Partial<Block> & { checked?: boolean; children?: string[] }
    if (!raw || typeof raw !== 'object') return null

    const type = LEGACY_TYPE[String(raw.type ?? 'paragraph')] ?? 'paragraph'
    const level = raw.level === 1 ? 1 : raw.level === 2 || raw.level === 3 ? 2 : undefined

    return {
      id,
      type,
      text: typeof raw.text === 'string' ? raw.text : '',
      ...(type === 'heading' ? { level: level ?? 1 } : {}),
      ...(typeof raw.src === 'string' && raw.src ? { src: raw.src } : {}),
      ...placementOf(raw.layout),
      ...(typeof raw.alt === 'string' && raw.alt ? { alt: raw.alt } : {}),
      ...(Array.isArray(raw.columns) ? { columns: parseColumns(raw.columns) } : {}),
    }
  } catch {
    return null
  }
}

/** 列里的块没有独立文件，跟着 columns 块一起存 */
function parseColumns(raw: unknown): NoteDoc['blocks'][string]['columns'] {
  if (!Array.isArray(raw)) return undefined
  const cols = raw
    .map((c) => {
      const col = c as { width?: unknown; blocks?: unknown }
      const width = typeof col.width === 'number' ? Math.min(100, Math.max(10, Math.round(col.width))) : 50
      const blocks = Array.isArray(col.blocks)
        ? col.blocks
            .map((b, i) => parseNestedBlock(b as Record<string, unknown>, `c${i}`))
            .filter((b): b is Block => Boolean(b))
        : []
      return { width, blocks }
    })
    .filter((c) => c.blocks.length >= 0)
  return cols.length > 0 ? cols : undefined
}

/** 列内块：id 缺失时补一个可预测的 id，别让整列丢掉 */
function parseNestedBlock(raw: Record<string, unknown>, fallbackId: string): Block | null {
  if (!raw || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id : fallbackId
  try {
    const parsed = parseBlock(id, JSON.stringify(raw))
    return parsed
  } catch {
    return null
  }
}

/** 从仓库文件表里解出一篇 `.note`；不是这个格式就返回 null */
export function parseNoteDoc(dir: Path, files: Record<Path, string>): NoteDoc | null {
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

  const blocks: Record<string, Block> = {}
  const prefix = `${base}/${NOTE_BLOCKS}/`
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith(prefix) || !path.endsWith('.json')) continue
    const id = path.slice(prefix.length, -'.json'.length)
    if (!id || id.includes('/')) continue
    const b = parseBlock(id, text)
    if (b) blocks[id] = b
  }

  // 顺序表里丢了但文件还在的块，补到末尾（宁可多显示，也不静默丢块）
  for (const id of Object.keys(blocks)) if (!order.includes(id)) order.push(id)

  return { meta, order, blocks }
}

function serializeBlock(b: Block): string {
  const out: Record<string, unknown> = { id: b.id, type: b.type, text: b.text }
  if (b.type === 'heading') out.level = b.level ?? 1
  if (b.type === 'image' && b.src) out.src = b.src
  if (b.type === 'image' && b.alt) out.alt = b.alt
  if (b.layout) out.layout = roundPlacement(b.layout)
  if (b.type === 'columns' && b.columns) {
    out.columns = b.columns.map((c) => ({
      width: Math.round(c.width),
      blocks: c.blocks.map((child) => {
        const o: Record<string, unknown> = { id: child.id, type: child.type, text: child.text }
        if (child.type === 'heading') o.level = child.level ?? 1
        if (child.type === 'image' && child.src) o.src = child.src
        if (child.type === 'image' && child.alt) o.alt = child.alt
        if (child.layout) o.layout = roundPlacement(child.layout)
        return o
      }),
    }))
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/** 一篇文档 → 仓库文件表（键是完整路径） */
export function docFiles(dir: Path, doc: NoteDoc): Record<Path, string> {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  const out: Record<Path, string> = {}
  out[`${base}/${NOTE_MARK}`] = MARK_TEXT
  out[`${base}/${NOTE_META}`] = `${JSON.stringify(doc.meta, null, 2)}\n`
  out[`${base}/${NOTE_ORDER}`] = `${JSON.stringify(doc.order, null, 2)}\n`
  for (const id of Object.keys(doc.blocks)) {
    const b = doc.blocks[id]
    if (b) out[blockPath(base, id)] = serializeBlock(b)
  }
  return out
}

/**
 * 两份文档 → **要写哪些文件**。
 * 这是"只写变动"的地方：返回空对象就说明什么都没改。
 */
export function diffDoc(dir: Path, before: NoteDoc | null, after: NoteDoc): Record<Path, string> {
  const next = docFiles(dir, after)
  const prev = before ? docFiles(dir, before) : {}

  const out: Record<Path, string> = {}
  for (const [path, text] of Object.entries(next)) {
    if (prev[path] !== text) out[path] = text
  }
  return out
}

/** 被删掉的块文件路径（保存时要顺手删） */
export function removedBlockFiles(dir: Path, before: NoteDoc | null, after: NoteDoc): Path[] {
  if (!before) return []
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return Object.keys(before.blocks)
    .filter((id) => !after.blocks[id])
    .map((id) => blockPath(base, id))
}

/* ───────────────────────── 编辑 ───────────────────────── */

export function nextBlockId(doc: NoteDoc): string {
  // 取现有最大编号 + 1 —— 不能按"块数 + 1"算：删过块之后那样会撞号
  let max = 0
  for (const id of Object.keys(doc.blocks)) {
    const m = /^b(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `b${max + 1}`
}

export function emptyDoc(title: string, now = new Date()): NoteDoc {
  const id = 'b1'
  return {
    meta: { title, createdAt: now.toISOString() },
    order: [id],
    blocks: { [id]: { id, type: 'paragraph', text: '' } },
  }
}

export function insertBlock(doc: NoteDoc, afterId: string | null, block: Block): NoteDoc {
  const order = [...doc.order]
  const at = afterId ? order.indexOf(afterId) : order.length - 1
  order.splice(at + 1, 0, block.id)
  return {
    ...doc,
    order,
    blocks: { ...doc.blocks, [block.id]: block },
  }
}

export function removeBlock(doc: NoteDoc, id: string): NoteDoc {
  const blocks = { ...doc.blocks }
  delete blocks[id]
  return {
    ...doc,
    order: doc.order.filter((x) => x !== id),
    blocks,
  }
}

export function updateBlock(doc: NoteDoc, id: string, patch: Partial<Block>): NoteDoc {
  const cur = doc.blocks[id]
  if (!cur) return doc
  return { ...doc, blocks: { ...doc.blocks, [id]: { ...cur, ...patch, id } } }
}

export function moveBlock(doc: NoteDoc, id: string, delta: -1 | 1): NoteDoc {
  const at = doc.order.indexOf(id)
  const to = at + delta
  if (at < 0 || to < 0 || to >= doc.order.length) return doc
  const order = [...doc.order]
  order.splice(at, 1)
  order.splice(to, 0, id)
  return { ...doc, order }
}

/**
 * 把块挪到第 index 个位置（拖动排序用）。
 * index 是**插入位置**：0 = 放到最前，len = 放到最后。
 */
export function moveBlockTo(doc: NoteDoc, id: string, index: number): NoteDoc {
  const from = doc.order.indexOf(id)
  if (from < 0) return doc

  const order = [...doc.order]
  order.splice(from, 1)
  // 删掉自己之后，原位置之后的插入点要往前挪一格
  const to = Math.max(0, Math.min(order.length, index > from ? index - 1 : index))
  if (to === from) return doc
  order.splice(to, 0, id)
  return { ...doc, order }
}

/** 按 order 排出块（跳过对不上的 id） */
export function orderedBlocks(doc: NoteDoc): Block[] {
  return doc.order.map((id) => doc.blocks[id]).filter((b): b is Block => Boolean(b))
}
