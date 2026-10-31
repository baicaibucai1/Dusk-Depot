/*
 * 书架清单（`library.json`）。
 *
 * ## 它管什么
 *
 *   书籍索引（书目 + 文件位置）、阅读位置、书签、封面缩略图。
 *   **只管一本本 EPUB 的账，不碰仓库**：仓库的 FileMap / .zzq / .note 里
 *   不会出现任何书架条目 —— 书架是设备级的东西，换仓库不该带着它走。
 *
 * ## 三条底线
 *
 *   ① 清单坏了**不能丢书**：解析失败时调用方把坏文件改名留档，再从目录里
 *      已有的 `*.epub` 重建索引（见 `rebuildFromFiles`）。
 *   ② 认不出的字段**原样留着**：将来加字段，旧版本打开再保存不会把它抹掉。
 *   ③ 删书 = 删文件 + 删条目，两件事由调用方一起做；这里只负责记账。
 */
import type { Path } from '../model/path'

export const LIBRARY_FILE = 'library.json'
export const LIBRARY_VERSION = 1
/** 单本上限。再大就不是"书架"该管的东西了 */
export const MAX_BOOK_BYTES = 200 * 1024 * 1024

export type Bookmark = {
  id: string
  /** EPUB CFI；拿不到时为空串，靠 percent 兜底 */
  cfi: string
  /** 章节标题（人看的） */
  label: string
  /** 全书百分比 0..1 */
  percent: number
  at: number
}

export type Book = {
  /** 内容哈希（前 16 位十六进制）。改名、搬目录都不变 */
  id: string
  /** 书架内的相对路径，如 `三体.epub` */
  file: string
  fileName: string
  title: string
  author: string
  publisher?: string
  language?: string
  /** 封面缩略图（data URL）。原封面在 EPUB 里，这里只存一张小的给列表用 */
  cover?: string
  size: number
  mtime: number
  addedAt: number
  lastReadAt: number
  /** 0..1 */
  percent: number
  cfi: string
  /** CFI 失效时的后备：第几章（spine 下标）+ 章内比例 */
  locator?: { chapter: number; ratio: number }
  bookmarks: Bookmark[]
  /** 解析失败 / 文件不在了 —— 列表里显示占位，不隐藏 */
  broken?: boolean
}

export type Library = {
  version: number
  updatedAt: number
  books: Book[]
}

export type ParseResult =
  | { ok: true; library: Library; warnings: string[] }
  | { ok: false; error: string }

const EMPTY: Library = { version: LIBRARY_VERSION, updatedAt: 0, books: [] }

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** 一条书签，字段缺了也不炸 */
function bookmarkOf(raw: unknown): Bookmark | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const cfi = str(b.cfi)
  const percent = Math.min(1, Math.max(0, num(b.percent)))
  if (!cfi && percent <= 0) return null
  return {
    id: str(b.id) || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    cfi,
    label: str(b.label),
    percent,
    at: num(b.at, Date.now()),
  }
}

function bookOf(raw: unknown, warnings: string[]): Book | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const file = str(r.file)
  const id = str(r.id)
  if (!file || !id) {
    warnings.push('有一条书缺少 id 或文件路径，已跳过（文件本身没动）')
    return null
  }

  const bookmarks = Array.isArray(r.bookmarks)
    ? r.bookmarks.map(bookmarkOf).filter((b): b is Bookmark => Boolean(b))
    : []

  return {
    // 先把不认识的字段摊进来，再覆盖已知字段 —— 新版本加的字段不会因为旧版本保存而丢
    ...(r as object),
    id,
    file,
    fileName: str(r.fileName, file.split('/').pop() ?? file),
    title: str(r.title) || str(r.fileName, file),
    author: str(r.author),
    ...(str(r.publisher) ? { publisher: str(r.publisher) } : {}),
    ...(str(r.language) ? { language: str(r.language) } : {}),
    ...(str(r.cover) ? { cover: str(r.cover) } : {}),
    size: num(r.size),
    mtime: num(r.mtime),
    addedAt: num(r.addedAt, Date.now()),
    lastReadAt: num(r.lastReadAt),
    percent: Math.min(1, Math.max(0, num(r.percent))),
    cfi: str(r.cfi),
    ...(r.locator && typeof r.locator === 'object'
      ? {
          locator: {
            chapter: Math.max(0, Math.round(num((r.locator as Record<string, unknown>).chapter))),
            ratio: Math.min(1, Math.max(0, num((r.locator as Record<string, unknown>).ratio))),
          },
        }
      : {}),
    bookmarks,
    ...(r.broken ? { broken: true } : {}),
  } as Book
}

/** 读清单。坏到不能解析时返回 ok:false，调用方负责留档 + 重建 */
export function parseLibrary(raw: string | null | undefined): ParseResult {
  if (!raw || !raw.trim()) return { ok: true, library: { ...EMPTY, books: [] }, warnings: [] }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `清单不是合法 JSON：${String(e)}` }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: '清单的顶层不是一个对象' }
  }
  const obj = data as Record<string, unknown>
  const warnings: string[] = []
  const list = Array.isArray(obj.books) ? obj.books : []
  if (!Array.isArray(obj.books)) warnings.push('清单里没有 books 数组，已按空书架处理')

  const books = list.map((b) => bookOf(b, warnings)).filter((b): b is Book => Boolean(b))
  const seen = new Set<string>()
  const deduped = books.filter((b) => {
    if (seen.has(b.id)) {
      warnings.push(`书号重复：${b.id}，只保留第一条（不会删文件）`)
      return false
    }
    seen.add(b.id)
    return true
  })

  return {
    ok: true,
    library: {
      version: LIBRARY_VERSION,
      updatedAt: num(obj.updatedAt),
      books: deduped,
    },
    warnings,
  }
}

export function serializeLibrary(lib: Library): string {
  return `${JSON.stringify({ ...lib, version: LIBRARY_VERSION, updatedAt: Date.now() }, null, 2)}\n`
}

/* ───────────────────── 编辑 ───────────────────── */

export function upsertBook(lib: Library, book: Book): Library {
  const at = lib.books.findIndex((b) => b.id === book.id)
  const books = at < 0 ? [...lib.books, book] : lib.books.map((b, i) => (i === at ? book : b))
  return { ...lib, books }
}

export function removeBookEntry(lib: Library, id: string): Library {
  return { ...lib, books: lib.books.filter((b) => b.id !== id) }
}

export function patchBook(lib: Library, id: string, patch: Partial<Book>): Library {
  return { ...lib, books: lib.books.map((b) => (b.id === id ? { ...b, ...patch, id: b.id } : b)) }
}

export function addBookmark(lib: Library, id: string, mark: Bookmark): Library {
  const book = lib.books.find((b) => b.id === id)
  if (!book) return lib
  return patchBook(lib, id, { bookmarks: [...book.bookmarks, mark] })
}

export function removeBookmark(lib: Library, id: string, markId: string): Library {
  const book = lib.books.find((b) => b.id === id)
  if (!book) return lib
  return patchBook(lib, id, { bookmarks: book.bookmarks.filter((m) => m.id !== markId) })
}

/* ───────────────────── 文件名 ───────────────────── */

/**
 * 文件名清理：去掉路径分隔符、控制字符、Windows 非法字符，
 * 再去掉结尾的点和空格（Windows 上 `a.` 会变成 `a`，改名会打架）。
 */
export function safeFileName(input: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  const cut = [...cleaned].slice(0, 80).join('')
  return cut || '未命名'
}

export function withEpubExt(name: string): string {
  return /\.epub$/i.test(name) ? name : `${name}.epub`
}

/**
 * 同名冲突 → `书名 (2).epub`。
 * `taken` 里放的是**当前目录已有的 fileName**（不区分大小写，Windows 上是一回事）。
 */
export function uniqueFileName(desired: string, taken: string[]): string {
  const name = withEpubExt(safeFileName(desired))
  const used = new Set(taken.map((t) => t.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name

  const stem = name.replace(/\.epub$/i, '')
  for (let i = 2; i < 1000; i++) {
    const next = `${stem} (${i}).epub`
    if (!used.has(next.toLowerCase())) return next
  }
  return `${stem} (${Date.now()}).epub`
}

/** 内容哈希 → 稳定 bookId（改文件名也不变） */
export async function hashBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const digest = await crypto.subtle.digest('SHA-256', buf as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/* ───────────────────── 视图 ───────────────────── */

export type SortMode = 'recent' | 'title'
export type ShelfFilter = 'all' | 'reading'

export function filterBooks(books: Book[], q: string, filter: ShelfFilter): Book[] {
  const needle = q.trim().toLowerCase()
  return books.filter((b) => {
    if (filter === 'reading' && b.lastReadAt <= 0) return false
    if (!needle) return true
    return `${b.title} ${b.fileName} ${b.author}`.toLowerCase().includes(needle)
  })
}

export function sortBooks(books: Book[], mode: SortMode): Book[] {
  const out = [...books]
  if (mode === 'title') {
    out.sort((a, b) => a.title.localeCompare(b.title, 'zh'))
  } else {
    // 读过的按最近阅读排前面；没读过的排在后面，内部按加入时间
    out.sort((a, b) => {
      if (a.lastReadAt !== b.lastReadAt) return b.lastReadAt - a.lastReadAt
      return b.addedAt - a.addedAt
    })
  }
  return out
}

export function formatWhen(ts: number, now = Date.now()): string {
  if (!ts) return '还没读过'
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function percentLabel(p: number): string {
  if (!p || p <= 0) return '未开始'
  if (p >= 0.999) return '已读完'
  return `${Math.round(p * 100)}%`
}

/**
 * 清单坏了 / 刚换到新目录时的重建：
 * 只看目录里真实存在的 `.epub`，其余信息留空，等打开时再解析。
 */
export function rebuildFromFiles(
  files: { path: Path; size: number; mtime: number }[],
  known: Book[] = [],
): Book[] {
  const byFile = new Map(known.map((b) => [b.file.toLowerCase(), b]))
  return files.map((f) => {
    const hit = byFile.get(f.path.toLowerCase())
    if (hit) return { ...hit, file: f.path, size: f.size || hit.size, mtime: f.mtime || hit.mtime }
    const fileName = f.path.split('/').pop() ?? f.path
    return {
      id: `pending-${f.path}`,
      file: f.path,
      fileName,
      title: fileName.replace(/\.epub$/i, ''),
      author: '',
      size: f.size,
      mtime: f.mtime,
      addedAt: Date.now(),
      lastReadAt: 0,
      percent: 0,
      cfi: '',
      bookmarks: [],
    }
  })
}

export function emptyLibrary(): Library {
  return { ...EMPTY, books: [] }
}
