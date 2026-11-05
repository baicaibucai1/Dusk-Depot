/*
 * `.board` —— **独立白板文件**（单个 JSON 文件，不是目录）。
 *
 * ## 和 `.note` 的关系
 *
 * `.note` 是"一篇文档"，一个目录；`.board` 是一块"白板"，一个文件。
 * `.note` 里可以放一个**白板引用块**（`boardref`），它只记 `boardId` + 路径提示，
 * **不复制白板内容** —— 引用块和独立打开的白板永远是同一份数据，不会分叉。
 *
 * ## 文件长什么样
 *
 *   {
 *     "app": "dusk-depot",
 *     "format": "board",
 *     "version": 1,
 *     "boardId": "bd-lq3k2x",        ← 稳定身份：改名/搬家都不变，引用靠它锚定
 *     "title": "项目白板",
 *     "createdAt": "…", "updatedAt": "…",
 *     "layout": { "mode": "stack", "order": ["n1","n2"] },
 *     "blocks": { "n1": { "id": "n1", "type": "paragraph", "content": [...] } },
 *     "links":  [ { "id": "l1", "from": "n1", "to": "n2", "type": "related", "label": "" } ]
 *   }
 *
 * ## 四条底线
 *
 *   ① **未知字段、未知块一律原样保留**：旧版本打开新文件再保存，不能丢东西。
 *   ② **版本超前不猜**：`version > 1` 时只报告、不解析、不写回 —— 让用户升级，
 *      而不是拿旧逻辑把新数据重排一遍。
 *   ③ `boardId` 一旦生成就不改：引用块、复制进白板的附件目录都挂在它上面。
 *   ④ 这一层是**纯函数**，不碰 DOM、不碰 React，node 里能直接测。
 */
import { type Inline, inlineText } from '../note/flow'
import type { Path } from '../model/path'
import { stemOf } from '../model/path'

export const BOARD_APP = 'dusk-depot'
export const BOARD_FORMAT = 'board'
export const BOARD_SUFFIX = '.board'
export const BOARD_FILE_VERSION = 1

/**
 * 复制进白板的附件目录：`.dusk/board/<boardId>/`。
 *
 * 为什么按 boardId 而不是跟着文件名：文件改名/搬家时附件不用跟着搬，
 * 也不会出现"`xxx.board` 旁边多出一个 `xxx.board.files/` 目录"这种噪音。
 * `.dusk` 开头，文件树天然不列（见 core/model/path.ts 的 isHidden）。
 */
export const BOARD_COPY_ROOT = '.dusk/board'

export type BoardLayoutMode = 'stack' | 'free'

export type BoardBlockType =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'todo'
  | 'quote'
  | 'image'
  | 'file'
  | 'divider'
  /** 组合：把若干块框在一个范围里，框上可以有个标题。子块坐标仍是绝对的 */
  | 'group'
  | 'unknown'

/** 图片 / 文件块：是复制进白板，还是只引用仓库里已有的那个文件 */
export type BlockSource = 'copy' | 'link'

/**
 * `.note` 里白板引用块的显示方式。
 * 定义在 `.board` 这一侧：显示方式是"白板被怎么展示"，跟着白板概念走。
 */
export type BoardRefView = 'compact' | 'preview'

export type BoardBlock = {
  id: string
  type: BoardBlockType
  /** 正文 / 标题 / 待办 / 引用：行内内容 */
  content?: Inline[]
  /** 待办是否勾选 */
  checked?: boolean
  /** 图片 / 文件：仓库内相对路径 */
  src?: string
  /** 文件块原始文件名（展示用；引用已有文件时也用它） */
  name?: string
  /** 文件字节数（展示用） */
  size?: number
  /** 图片 alt */
  alt?: string
  /** 文字类块的字号（px）。不写 = 用界面默认 */
  fontSize?: number
  /** 组框上的标题 */
  title?: string
  /** 组里装了哪些块（id）。块本身还在顶层，组只是把它们框起来 */
  children?: string[]
  /** 图片来源：copy = 复制进 `.dusk/board/<id>/`；link = 只记路径 */
  source?: BlockSource
  /** 认不出的块：原始 JSON，保存时原样写回 */
  raw?: Record<string, unknown>
  /** 已知块里不认识的字段：原样保留 */
  extra?: Record<string, unknown>
}

/**
 * 连接从卡片的哪条边出入。
 *
 * 为什么记这个：拖拽连线时用户是**从某个圆点拉出去**的，那条线就该从那个点出发，
 * 重开白板也不能自己跑到另一边去。没记（老数据、或从菜单建的连接）就按两块相对位置自动选。
 */
export type AnchorSide = 'top' | 'right' | 'bottom' | 'left'

export const ANCHOR_SIDES: AnchorSide[] = ['top', 'right', 'bottom', 'left']

export function isAnchorSide(v: unknown): v is AnchorSide {
  return v === 'top' || v === 'right' || v === 'bottom' || v === 'left'
}

/** 反过来那条边（连接反向时用） */
export function flipSide(side: AnchorSide): AnchorSide {
  return side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side === 'left' ? 'right' : 'left'
}

export type LinkType = 'related' | 'depends' | 'source' | 'custom'

export const LINK_TYPES: { id: LinkType; label: string }[] = [
  { id: 'related', label: '相关' },
  { id: 'depends', label: '依赖' },
  { id: 'source', label: '来源' },
  { id: 'custom', label: '自定义' },
]

export type BoardLink = {
  id: string
  /** 起点块 id */
  from: string
  /** 终点块 id */
  to: string
  type: LinkType
  /** 人写的说明 */
  label: string
  /** 出线边。缺省 = 按两块相对位置自动选 */
  fromSide?: AnchorSide
  /** 入线边。缺省 = 按两块相对位置自动选 */
  toSide?: AnchorSide
  createdAt: number
  /** 不认识的字段，原样保留 */
  extra?: Record<string, unknown>
}

/**
 * 自由画布上的一个位置：左上角坐标 + 尺寸。
 *
 * `w` / `h` 都是可选的：不写就是"按内容来"（宽度按块类型的默认值，高度量出来）。
 * 一旦用户拖过手柄，就把那个方向固定下来 —— 文字多了也不会把卡片撑变形。
 */
export type Pos = { x: number; y: number; w?: number; h?: number }

/**
 * 布局：`free` = 无限画布（默认），`stack` = 旧版纵向堆叠。
 *
 * `stack` 是这一版之前写出来的白板。**不自动迁移**：读的时候按一列兜底摆出来，
 * 用户第一次拖动/调宽才变成 `free` 并把坐标写进文件。
 */
export type BoardLayout = {
  mode: BoardLayoutMode
  /** 块的插入顺序。画布上不用它排版，但它是稳定的枚举顺序（导出/大纲/兜底都靠它） */
  order: string[]
  /** 每个块的坐标与宽度 */
  pos?: Record<string, Pos>
}

export type BoardFileDoc = {
  version: number
  boardId: string
  title: string
  createdAt: string
  updatedAt?: string
  layout: BoardLayout
  blocks: Record<string, BoardBlock>
  links: BoardLink[]
  /** 顶层不认识的字段：原样保留 */
  extra?: Record<string, unknown>
}

/* ───────────────────────── 判定 ───────────────────────── */

/** 白板标题的兜底：文件名去掉 `.board` */
export function titleOfBoardPath(path: Path): string {
  return stemOf(path) || '未命名白板'
}

export function newBoardId(now = Date.now()): string {
  return `bd-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/* ───────────────────────── 解析 ───────────────────────── */

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

const KNOWN_BLOCK_FIELDS = new Set([
  'id',
  'type',
  'content',
  'checked',
  'src',
  'name',
  'size',
  'alt',
  'source',
  'fontSize',
  'title',
  'children',
])

const TEXT_TYPES = new Set(['paragraph', 'heading1', 'heading2', 'todo', 'quote'])

/** 一个块的 JSON → BoardBlock。结构不对的**已知类型**降级成 unknown（raw 留着），不静默变空段 */
/** 字号只收一个合理区间：太大一张卡吃掉整屏，太小看不清 */
export const MIN_FONT = 11
export const MAX_FONT = 72

function fontSizeOf(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  if (v < MIN_FONT || v > MAX_FONT) return undefined
  return Math.round(v)
}

export function parseBlock(id: string, raw: unknown): BoardBlock {
  const obj = asObject(raw) ?? {}
  const type = typeof obj.type === 'string' ? obj.type : ''

  const known =
    TEXT_TYPES.has(type) ||
    type === 'image' ||
    type === 'file' ||
    type === 'divider' ||
    type === 'group'

  if (!known) return { id, type: 'unknown', raw: { ...obj, id } }

  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (!KNOWN_BLOCK_FIELDS.has(k)) extra[k] = v

  const block: BoardBlock = { id, type: type as BoardBlockType }
  if (Object.keys(extra).length > 0) block.extra = extra

  if (TEXT_TYPES.has(type)) {
    const content = textOfInline(obj.content)
    if (!content) return { id, type: 'unknown', raw: { ...obj, id } }
    block.content = content
    if (type === 'todo') block.checked = Boolean(obj.checked)
    block.fontSize = fontSizeOf(obj.fontSize)
    return block
  }

  if (type === 'group') {
    block.title = typeof obj.title === 'string' ? obj.title : '分组'
    block.children = Array.isArray(obj.children)
      ? obj.children.filter((x): x is string => typeof x === 'string')
      : []
    return block
  }

  if (type === 'image') {
    block.src = typeof obj.src === 'string' ? obj.src : ''
    if (typeof obj.alt === 'string' && obj.alt) block.alt = obj.alt
    if (obj.source === 'copy' || obj.source === 'link') block.source = obj.source
    return block
  }

  if (type === 'file') {
    block.src = typeof obj.src === 'string' ? obj.src : ''
    if (typeof obj.name === 'string' && obj.name) block.name = obj.name
    if (typeof obj.size === 'number' && Number.isFinite(obj.size)) block.size = obj.size
    if (obj.source === 'copy' || obj.source === 'link') block.source = obj.source
    return block
  }

  return block // divider
}

/**
 * 读坐标。数字必须有限，缺 `w` 就留空（由界面按类型给默认宽度）。
 * 坏掉的坐标**整条丢掉**，让那块回到兜底位置 —— 宁可位置不对，也不要 NaN 把画布撑爆。
 */
function posOfRaw(raw: unknown): { pos?: Record<string, Pos> } {
  const o = asObject(raw)
  if (!o) return {}
  const pos: Record<string, Pos> = {}
  for (const [id, v] of Object.entries(o)) {
    const p = asObject(v)
    if (!p || !id) continue
    const x = typeof p.x === 'number' && Number.isFinite(p.x) ? p.x : null
    const y = typeof p.y === 'number' && Number.isFinite(p.y) ? p.y : null
    if (x === null || y === null) continue
    const w = typeof p.w === 'number' && Number.isFinite(p.w) && p.w > 0 ? p.w : undefined
    const h = typeof p.h === 'number' && Number.isFinite(p.h) && p.h > 0 ? p.h : undefined
    const at: Pos = { x, y }
    if (w) at.w = w
    if (h) at.h = h
    pos[id] = at
  }
  return Object.keys(pos).length > 0 ? { pos } : {}
}

function parseLink(raw: unknown, warnings: string[]): BoardLink | null {
  const o = asObject(raw)
  if (!o) return null
  const from = typeof o.from === 'string' ? o.from : ''
  const to = typeof o.to === 'string' ? o.to : ''
  if (!from || !to) {
    warnings.push('有一条连接缺起点或终点，已跳过（块本身没动）')
    return null
  }
  const type =
    o.type === 'related' || o.type === 'depends' || o.type === 'source' || o.type === 'custom'
      ? o.type
      : 'related'
  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (
      k !== 'id' &&
      k !== 'from' &&
      k !== 'to' &&
      k !== 'type' &&
      k !== 'label' &&
      k !== 'createdAt' &&
      k !== 'fromSide' &&
      k !== 'toSide'
    ) {
      extra[k] = v
    }
  }
  const link: BoardLink = {
    id: typeof o.id === 'string' && o.id ? o.id : `l-${from}-${to}-${String(o.createdAt ?? '')}`,
    from,
    to,
    type,
    label: typeof o.label === 'string' ? o.label : '',
    createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : Date.now(),
  }
  // 锚边只认那四个值：坏掉的丢掉（让线自己找位置），不因为一个字段废掉整条连接
  if (isAnchorSide(o.fromSide)) link.fromSide = o.fromSide
  if (isAnchorSide(o.toSide)) link.toSide = o.toSide
  if (Object.keys(extra).length > 0) link.extra = extra
  return link
}

export type BoardFileParse =
  | { kind: 'ok'; doc: BoardFileDoc; warnings: string[] }
  /** 版本比这个程序新：只提示，不解析、不写回 */
  | { kind: 'unsupported'; version: number; message: string }
  /** 不是白板 / 文件坏了 */
  | { kind: 'bad'; message: string }

/**
 * 读一块白板。
 *
 * `fallbackTitle` 用在标题缺失时（新建的空文件、被别的工具抹掉了 title）——
 * 用文件名，而不是"未命名"，人一眼还能认出是哪一块。
 */
export function parseBoardFile(text: string, fallbackTitle = '未命名白板'): BoardFileParse {
  if (!text.trim()) return { kind: 'bad', message: '这个 .board 文件是空的' }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'bad', message: '这个 .board 文件不是有效的 JSON' }
  }
  const o = asObject(raw)
  if (!o) return { kind: 'bad', message: '这个 .board 的顶层不是一个对象' }

  if (o.format !== BOARD_FORMAT) {
    return { kind: 'bad', message: '这不是白板文件（缺 "format": "board" 标记）' }
  }

  const warnings: string[] = []
  const version = typeof o.version === 'number' && Number.isFinite(o.version) ? o.version : 0
  if (version > BOARD_FILE_VERSION) {
    return {
      kind: 'unsupported',
      version,
      message: `这块白板由更新版本（v${version}）创建，当前程序只认识 v${BOARD_FILE_VERSION}；为了不写坏它，这次不打开。请先升级 Dusk Depot。`,
    }
  }
  if (version < 1) warnings.push('这份白板没写版本号，按 v1 读；保存时会补上')

  const extra: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (
      k !== 'app' &&
      k !== 'format' &&
      k !== 'version' &&
      k !== 'boardId' &&
      k !== 'title' &&
      k !== 'createdAt' &&
      k !== 'updatedAt' &&
      k !== 'layout' &&
      k !== 'blocks' &&
      k !== 'links'
    ) {
      extra[k] = v
    }
  }

  const blocks: Record<string, BoardBlock> = {}
  const blocksRaw = o.blocks
  if (Array.isArray(blocksRaw)) {
    // 容错：也接受数组形式（别人的工具写出来的）
    for (const item of blocksRaw) {
      const obj = asObject(item)
      const id = typeof obj?.id === 'string' && obj.id ? obj.id : ''
      if (!obj || !id) {
        warnings.push('有一个块没有 id，已跳过')
        continue
      }
      blocks[id] = parseBlock(id, obj)
    }
  } else if (blocksRaw !== undefined) {
    const asRecord = asObject(blocksRaw)
    if (!asRecord) return { kind: 'bad', message: '这个白板的 blocks 既不是对象也不是数组' }
    for (const [id, item] of Object.entries(asRecord)) {
      if (!id) continue
      blocks[id] = parseBlock(id, item)
    }
  }

  let layout: BoardLayout = { mode: 'free', order: [] }
  const layoutRaw = asObject(o.layout)
  if (layoutRaw) {
    const mode = layoutRaw.mode === 'stack' ? 'stack' : 'free'
    const order = Array.isArray(layoutRaw.order)
      ? layoutRaw.order.filter((x): x is string => typeof x === 'string')
      : []
    layout = { mode, order, ...posOfRaw(layoutRaw.pos) }
  } else if (o.layout !== undefined) {
    warnings.push('layout 格式不对，改按块的出现顺序排；块和连接都没动')
  }

  // 顺序表里没有的块补到末尾：宁可多显示，也不静默丢块
  for (const id of Object.keys(blocks)) if (!layout.order.includes(id)) layout.order.push(id)
  layout.order = layout.order.filter((id) => Boolean(blocks[id]))
  if (layout.mode === 'stack' && Object.keys(blocks).length > 0) {
    // 旧版纵向白板：能读，按一列显示；用户一拖就变成 free（见 setPos）
    if (!layout.pos || Object.keys(layout.pos).length === 0) {
      warnings.push('这块白板是旧版纵向排列（没有坐标）；按一列显示，拖动任意一块就会切换成自由画布')
    }
  }

  const links: BoardLink[] = []
  const seen = new Set<string>()
  const linksRaw = Array.isArray(o.links) ? o.links : []
  if (o.links !== undefined && !Array.isArray(o.links)) {
    warnings.push('links 不是数组，连接暂时读不出来；块本身没动')
  }
  for (const item of linksRaw) {
    const link = parseLink(item, warnings)
    if (!link) continue
    if (seen.has(link.id)) {
      warnings.push(`连接 id 重复：${link.id}，只保留第一条`)
      continue
    }
    seen.add(link.id)
    if (!blocks[link.from] || !blocks[link.to]) {
      // 指向不存在的块：留着比删掉安全（块可能只是暂时读不出来）
      warnings.push('有连接指向已经不在的块，仍然保留，不会自动删')
    }
    links.push(link)
  }

  const doc: BoardFileDoc = {
    version: BOARD_FILE_VERSION,
    boardId: typeof o.boardId === 'string' && o.boardId ? o.boardId : newBoardId(),
    title: typeof o.title === 'string' && o.title.trim() ? o.title : fallbackTitle,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
    layout,
    blocks,
    links,
  }
  if (typeof o.updatedAt === 'string') doc.updatedAt = o.updatedAt
  if (typeof o.boardId !== 'string' || !o.boardId) warnings.push('这块白板没有 boardId，已补一个')
  if (Object.keys(extra).length > 0) doc.extra = extra

  return { kind: 'ok', doc, warnings }
}

/* ───────────────────────── 序列化 ───────────────────────── */

function serializeBlock(block: BoardBlock): Record<string, unknown> {
  if (block.type === 'unknown') {
    const raw = { ...(block.raw ?? {}) }
    raw.id = block.id
    return raw
  }

  // 先摊未知字段，再写已知字段：新版本加的字段不会因为这里保存而丢
  const out: Record<string, unknown> = { ...(block.extra ?? {}), id: block.id, type: block.type }
  switch (block.type) {
    case 'paragraph':
    case 'heading1':
    case 'heading2':
    case 'quote':
      out.content = block.content ?? []
      if (block.fontSize) out.fontSize = block.fontSize
      break
    case 'todo':
      out.checked = Boolean(block.checked)
      out.content = block.content ?? []
      if (block.fontSize) out.fontSize = block.fontSize
      break
    case 'group':
      out.title = block.title ?? '分组'
      out.children = block.children ?? []
      break
    case 'image':
      out.src = block.src ?? ''
      if (block.alt) out.alt = block.alt
      if (block.source) out.source = block.source
      break
    case 'file':
      out.src = block.src ?? ''
      if (block.name) out.name = block.name
      if (typeof block.size === 'number') out.size = block.size
      if (block.source) out.source = block.source
      break
    default:
      break
  }
  return out
}

/** 一块白板 → 文件文本。键序固定：手写 diff 时不会满屏噪音 */
export function serializeBoardFile(doc: BoardFileDoc): string {
  const layout: Record<string, unknown> = { mode: doc.layout.mode, order: doc.layout.order }
  if (doc.layout.pos) layout.pos = doc.layout.pos

  const blocks: Record<string, unknown> = {}
  for (const id of doc.layout.order) {
    const b = doc.blocks[id]
    if (b) blocks[id] = serializeBlock(b)
  }
  // 顺序表外的块（正常不会有）也别丢
  for (const [id, b] of Object.entries(doc.blocks)) if (!(id in blocks)) blocks[id] = serializeBlock(b)

  const out: Record<string, unknown> = {
    ...(doc.extra ?? {}),
    app: BOARD_APP,
    format: BOARD_FORMAT,
    version: BOARD_FILE_VERSION,
    boardId: doc.boardId,
    title: doc.title,
    createdAt: doc.createdAt,
    ...(doc.updatedAt ? { updatedAt: doc.updatedAt } : {}),
    layout,
    blocks,
    links: doc.links.map((l) => {
      const { extra, ...rest } = l
      return { ...(extra ?? {}), ...rest }
    }),
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/** 只有内容真的变了才返回新文本（用于"保存时显示已保存，但什么都没写"） */
export function diffBoardFile(before: string, doc: BoardFileDoc): string | null {
  const next = serializeBoardFile(doc)
  return next === before ? null : next
}

/* ───────────────────────── 新建 / 编辑 ───────────────────────── */

export function newBoardFile(title: string, now = new Date()): BoardFileDoc {
  return {
    version: BOARD_FILE_VERSION,
    boardId: newBoardId(now.getTime()),
    title,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    layout: { mode: 'free', order: [] },
    blocks: {},
    links: [],
  }
}

export function nextBlockId(doc: BoardFileDoc): string {
  let max = 0
  for (const id of Object.keys(doc.blocks)) {
    const m = /^n(\d+)$/.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `n${max + 1}`
}

export function newBlock(type: BoardBlockType, id: string): BoardBlock {
  switch (type) {
    case 'todo':
      return { id, type, content: [], checked: false }
    case 'image':
      return { id, type, src: '', alt: '', source: 'copy' }
    case 'file':
      return { id, type, src: '', name: '', source: 'copy' }
    case 'divider':
      return { id, type }
    case 'group':
      return { id, type, title: '分组', children: [] }
    case 'unknown':
      return { id, type: 'unknown', raw: { id, type: 'unknown' } }
    default:
      return { id, type, content: [] }
  }
}

export function insertBlock(doc: BoardFileDoc, afterId: string | null, block: BoardBlock): BoardFileDoc {
  const order = [...doc.layout.order]
  const at = afterId ? order.indexOf(afterId) : order.length - 1
  order.splice(at + 1, 0, block.id)
  return {
    ...doc,
    layout: { ...doc.layout, order },
    blocks: { ...doc.blocks, [block.id]: block },
  }
}

export function removeBlock(doc: BoardFileDoc, id: string): BoardFileDoc {
  const blocks = { ...doc.blocks }
  delete blocks[id]
  const pos = { ...(doc.layout.pos ?? {}) }
  delete pos[id]

  const layout: BoardLayout = {
    mode: doc.layout.mode,
    order: doc.layout.order.filter((x) => x !== id),
  }
  if (Object.keys(pos).length > 0) layout.pos = pos

  return {
    ...doc,
    blocks,
    layout,
    // 块没了，挂在它身上的连接一起收掉（连接不能指向空气）
    links: doc.links.filter((l) => l.from !== id && l.to !== id),
  }
}

export function updateBlock(doc: BoardFileDoc, id: string, patch: Partial<BoardBlock>): BoardFileDoc {
  const cur = doc.blocks[id]
  if (!cur) return doc
  return { ...doc, blocks: { ...doc.blocks, [id]: { ...cur, ...patch, id } } }
}

/** 把块挪到第 index 个位置（插入位置语义） */
export function moveBlockTo(doc: BoardFileDoc, id: string, index: number): BoardFileDoc {
  const from = doc.layout.order.indexOf(id)
  if (from < 0) return doc
  const order = [...doc.layout.order]
  order.splice(from, 1)
  const to = Math.max(0, Math.min(order.length, index > from ? index - 1 : index))
  if (to === from) return doc
  order.splice(to, 0, id)
  return { ...doc, layout: { ...doc.layout, order } }
}

export function duplicateBlock(doc: BoardFileDoc, id: string): { doc: BoardFileDoc; id: string } | null {
  const block = doc.blocks[id]
  if (!block) return null
  const nextId = nextBlockId(doc)
  const copy: BoardBlock = {
    ...block,
    id: nextId,
    content: block.content ? block.content.map((x) => ({ ...x })) : undefined,
    raw: block.raw ? { ...block.raw, id: nextId } : undefined,
  }
  let next = insertBlock(doc, id, copy)
  // 复制出来的那块往右下错开一点，否则正好压在原件上，看着像没复制
  const at = posOf(doc, id)
  if (at) next = setPos(next, nextId, { ...at, x: at.x + 28, y: at.y + 28 })
  return { doc: next, id: nextId }
}

export function addLink(doc: BoardFileDoc, link: BoardLink): BoardFileDoc {
  if (link.from === link.to) return doc
  const dup = doc.links.some(
    (l) => l.from === link.from && l.to === link.to && l.type === link.type && l.label === link.label,
  )
  if (dup) return doc
  return { ...doc, links: [...doc.links, link] }
}

export function removeLink(doc: BoardFileDoc, id: string): BoardFileDoc {
  return { ...doc, links: doc.links.filter((l) => l.id !== id) }
}

/** 改一条已有连接（类型 / 说明 / 目标 / 锚边）。只动这一条，块和其它连接不受影响 */
export function updateLink(
  doc: BoardFileDoc,
  id: string,
  patch: Partial<Omit<BoardLink, 'id'>>,
): BoardFileDoc {
  if (!doc.links.some((l) => l.id === id)) return doc
  return {
    ...doc,
    links: doc.links.map((l) => {
      if (l.id !== id) return l
      const next: BoardLink = { ...l, ...patch, id: l.id }
      // 传 undefined 表示"清掉"（把锚边改回自动选），不是存一个 undefined 进去
      if ('fromSide' in patch && patch.fromSide === undefined) delete next.fromSide
      if ('toSide' in patch && patch.toSide === undefined) delete next.toSide
      return next
    }),
  }
}

/** 反向：起点终点对调，锚边跟着换到对面 */
export function reverseLink(doc: BoardFileDoc, id: string): BoardFileDoc {
  const l = doc.links.find((x) => x.id === id)
  if (!l) return doc
  const next: BoardLink = { ...l, from: l.to, to: l.from }
  if (l.toSide) next.fromSide = flipSide(l.toSide)
  else delete next.fromSide
  if (l.fromSide) next.toSide = flipSide(l.fromSide)
  else delete next.toSide
  return { ...doc, links: doc.links.map((x) => (x.id === id ? next : x)) }
}

export function linksOf(doc: BoardFileDoc, blockId: string): BoardLink[] {
  return doc.links.filter((l) => l.from === blockId || l.to === blockId)
}

/* ───────────────────────── 画布坐标 ───────────────────────── */

/**
 * 各类卡片的默认宽度。
 *
 * 画布上**不靠文字撑宽度**：文字一长卡片就变形，整块白板的版面会跟着抖。
 * 所以宽度按类型定一个手感值，用户想改就拖右边那条边（写进 `pos.w`）。
 */
export const CARD_W: Record<BoardBlockType, number> = {
  paragraph: 320,
  heading1: 460,
  heading2: 380,
  quote: 320,
  todo: 320,
  image: 380,
  file: 360,
  // 组框不按这个宽度画（它跟着子块的包围盒走），这里只是让表是完整的
  group: 420,
  divider: 260,
  unknown: 320,
}

export function defaultWidth(type: BoardBlockType): number {
  return CARD_W[type] ?? 320
}

export function posOf(doc: BoardFileDoc, id: string): Pos | null {
  return doc.layout.pos?.[id] ?? null
}

/** 挪一块。**第一次挪动就把 mode 切成 free** —— 这是唯一"顺手迁移"的地方，且由用户动作触发 */
export function setPos(doc: BoardFileDoc, id: string, pos: Pos): BoardFileDoc {
  if (!doc.blocks[id]) return doc
  const cur = doc.layout.pos?.[id]
  const w = pos.w ?? cur?.w
  const h = pos.h ?? cur?.h
  const next: Pos = {
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    ...(w && Number.isFinite(w) ? { w: Math.round(w) } : {}),
    ...(h && Number.isFinite(h) ? { h: Math.round(h) } : {}),
  }
  if (
    cur &&
    cur.x === next.x &&
    cur.y === next.y &&
    cur.w === next.w &&
    cur.h === next.h
  ) {
    return doc
  }
  return {
    ...doc,
    layout: { ...doc.layout, mode: 'free', pos: { ...(doc.layout.pos ?? {}), [id]: next } },
  }
}

/** 把高度放回"按内容来"：双击下边缘手柄就是这个意思 */
export function clearHeight(doc: BoardFileDoc, id: string): BoardFileDoc {
  const cur = doc.layout.pos?.[id]
  if (!cur || cur.h === undefined) return doc
  const next: Pos = { x: cur.x, y: cur.y }
  if (cur.w) next.w = cur.w
  return { ...doc, layout: { ...doc.layout, pos: { ...(doc.layout.pos ?? {}), [id]: next } } }
}

/**
 * 没有坐标的块（旧版纵向白板）按一列兜底摆出来。
 * **只算不写** —— 打开旧白板不该悄悄改文件。
 */
export function fallbackPositions(doc: BoardFileDoc): Record<string, Pos> {
  const out: Record<string, Pos> = {}
  let y = 0
  for (const id of doc.layout.order) {
    const b = doc.blocks[id]
    if (!b) continue
    out[id] = { x: 0, y, w: defaultWidth(b.type) }
    // 高度量不出来（还没渲染），给一个够用的行距，保证兜底时不会叠在一起
    y += b.type === 'heading1' ? 140 : 110
  }
  return out
}

/** 界面用：每块最终落在哪儿 —— 文件里的坐标优先，没有就按顺序兜底 */
export function layoutOf(doc: BoardFileDoc): Record<string, Pos> {
  const fallback = fallbackPositions(doc)
  const out: Record<string, Pos> = {}
  for (const id of doc.layout.order) {
    const b = doc.blocks[id]
    if (!b) continue
    out[id] = doc.layout.pos?.[id] ?? fallback[id] ?? { x: 0, y: 0, w: defaultWidth(b.type) }
  }
  return out
}

/* ───────────────────────── 展示 / 命名 ───────────────────────── */

export function blockText(block: BoardBlock): string {
  if (block.type === 'image') return block.alt || block.src?.split('/').pop() || '图片'
  if (block.type === 'file') return block.name || block.src?.split('/').pop() || '文件'
  if (block.type === 'divider') return '分隔线'
  if (block.type === 'todo') return `${block.checked ? '[x]' : '[ ]'} ${inlineText(block.content ?? [])}`
  return inlineText(block.content ?? [])
}

const TYPE_LABEL: Record<string, string> = {
  heading1: 'H1',
  heading2: 'H2',
  todo: '待办',
  quote: '引用',
  image: '图片',
  file: '文件',
  divider: '分隔线',
  unknown: '未知块',
  paragraph: '正文',
}

export function blockLabel(block: BoardBlock | undefined, id: string): string {
  if (!block) return `（已删除的块 ${id}）`
  const kind = TYPE_LABEL[block.type] ?? '正文'
  const text = blockText(block).replace(/\s+/g, ' ').trim()
  const short = [...text].slice(0, 24).join('')
  return short ? `${kind} · ${short}` : `${kind} · ${id}`
}

export function boardPlainText(doc: BoardFileDoc): string {
  return doc.layout.order
    .map((id) => doc.blocks[id])
    .filter((b): b is BoardBlock => Boolean(b))
    .map((b) => blockText(b))
    .join('\n\n')
}

export function boardOutline(doc: BoardFileDoc): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = []
  for (const id of doc.layout.order) {
    const b = doc.blocks[id]
    if (!b) continue
    if (b.type === 'heading1') out.push({ level: 1, text: blockText(b) })
    if (b.type === 'heading2') out.push({ level: 2, text: blockText(b) })
  }
  return out
}

/** 复制进白板的附件放哪儿：`.dusk/board/<boardId>` */
export function copyDirOf(boardId: string): Path {
  return `${BOARD_COPY_ROOT}/${boardId}`
}

/** 一个附件是不是"复制进白板"的（判断 `.dusk/board/` 前缀，不看 source 字段） */
export function isCopiedAsset(src: string): boolean {
  return src.startsWith(`${BOARD_COPY_ROOT}/`)
}

/** `assets/…` 这类文件名清洗：去掉非法字符、限制长度 */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  return cleaned || '未命名'
}

/** 复制进白板的附件路径：`<dir>/<ts>-<rand>-<名字>`（同一毫秒里连续拖入也不撞名） */
export function copyAssetPath(boardId: string, originalName: string, now = Date.now()): Path {
  const salt = Math.random().toString(36).slice(2, 6)
  return `${copyDirOf(boardId)}/${now.toString(36)}-${salt}-${safeFileName(originalName)}`
}

/** 白板里所有"复制进来"的附件路径（删白板时可以问用户要不要一起删） */
export function copiedAssets(doc: BoardFileDoc): Path[] {
  const out = new Set<Path>()
  for (const b of Object.values(doc.blocks)) {
    if ((b.type === 'image' || b.type === 'file') && b.src && isCopiedAsset(b.src)) out.add(b.src)
  }
  return [...out]
}

/** 哪些块引用了这个附件（删块时判断孤不孤） */
export function assetRefs(doc: BoardFileDoc, asset: Path): string[] {
  return doc.layout.order.filter((id) => {
    const b = doc.blocks[id]
    return Boolean(b && (b.type === 'image' || b.type === 'file') && b.src === asset)
  })
}
