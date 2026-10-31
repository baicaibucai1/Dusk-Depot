import { describe, expect, it } from 'vitest'
import {
  type Book,
  emptyLibrary,
  filterBooks,
  formatWhen,
  hashBytes,
  parseLibrary,
  patchBook,
  percentLabel,
  rebuildFromFiles,
  removeBookEntry,
  safeFileName,
  serializeLibrary,
  sortBooks,
  uniqueFileName,
  upsertBook,
} from '../../src/core/shelf/library'

const book = (over: Partial<Book> = {}): Book => ({
  id: 'a1',
  file: '三体.epub',
  fileName: '三体.epub',
  title: '三体',
  author: '刘慈欣',
  size: 1024,
  mtime: 0,
  addedAt: 1000,
  lastReadAt: 0,
  percent: 0,
  cfi: '',
  bookmarks: [],
  ...over,
})

describe('书架清单：读', () => {
  it('空文件当空书架，不算错', () => {
    const r = parseLibrary(null)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.library.books).toHaveLength(0)
  })

  it('坏 JSON 明确报错（调用方负责备份 + 重建）', () => {
    const r = parseLibrary('{ 不是 json')
    expect(r.ok).toBe(false)
  })

  it('顶层不是对象也报错', () => {
    expect(parseLibrary('[]').ok).toBe(false)
    expect(parseLibrary('"x"').ok).toBe(false)
  })

  it('缺字段的书补默认值，不整条丢', () => {
    const raw = JSON.stringify({ version: 1, books: [{ id: 'b1', file: 'x.epub' }] })
    const r = parseLibrary(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const b = r.library.books[0]
    expect(b?.title).toBe('x.epub')
    expect(b?.author).toBe('')
    expect(b?.bookmarks).toEqual([])
    expect(b?.percent).toBe(0)
  })

  it('既没 id 也没路径的书跳过，并给出提示', () => {
    const raw = JSON.stringify({ version: 1, books: [{ title: '没有身份的书' }] })
    const r = parseLibrary(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.library.books).toHaveLength(0)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('重复 bookId 只留第一条（不删文件）', () => {
    const raw = JSON.stringify({
      version: 1,
      books: [
        { id: 'x', file: 'a.epub', title: 'A' },
        { id: 'x', file: 'b.epub', title: 'B' },
      ],
    })
    const r = parseLibrary(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.library.books).toHaveLength(1)
    expect(r.library.books[0]?.title).toBe('A')
  })

  it('百分比夹进 0..1，坏值不传染', () => {
    const raw = JSON.stringify({ version: 1, books: [{ id: 'x', file: 'a.epub', percent: 3.5 }] })
    const r = parseLibrary(raw)
    if (!r.ok) throw new Error('should parse')
    expect(r.library.books[0]?.percent).toBe(1)
  })

  it('书签坏了只丢那一条', () => {
    const raw = JSON.stringify({
      version: 1,
      books: [{ id: 'x', file: 'a.epub', bookmarks: [{ cfi: 'epubcfi(/6/2)' }, null, { percent: 0.4 }] }],
    })
    const r = parseLibrary(raw)
    if (!r.ok) throw new Error('should parse')
    expect(r.library.books[0]?.bookmarks).toHaveLength(2)
  })

  it('不认识的字段原样保留（版本向前兼容）', () => {
    const raw = JSON.stringify({
      version: 1,
      books: [{ id: 'x', file: 'a.epub', futureField: { keep: true } }],
    })
    const r = parseLibrary(raw)
    if (!r.ok) throw new Error('should parse')
    const again = JSON.parse(serializeLibrary(r.library)) as { books: Record<string, unknown>[] }
    expect(again.books[0]).toHaveProperty('futureField')
  })
})

describe('书架清单：写', () => {
  it('加书 / 改书 / 删书', () => {
    let lib = emptyLibrary()
    lib = upsertBook(lib, book())
    expect(lib.books).toHaveLength(1)

    lib = patchBook(lib, 'a1', { percent: 0.42, cfi: 'epubcfi(/6/4)' })
    expect(lib.books[0]?.percent).toBe(0.42)
    expect(lib.books[0]?.id).toBe('a1')

    lib = removeBookEntry(lib, 'a1')
    expect(lib.books).toHaveLength(0)
  })

  it('同一 id 再 upsert 是替换，不是追加', () => {
    let lib = upsertBook(emptyLibrary(), book())
    lib = upsertBook(lib, book({ title: '三体（新版）' }))
    expect(lib.books).toHaveLength(1)
    expect(lib.books[0]?.title).toBe('三体（新版）')
  })

  it('序列化带版本号', () => {
    const out = JSON.parse(serializeLibrary(emptyLibrary())) as { version: number }
    expect(out.version).toBe(1)
  })
})

describe('文件名与冲突', () => {
  it('去掉路径分隔符、非法字符、结尾点', () => {
    expect(safeFileName('../../etc/passwd')).toBe('.. .. etc passwd')
    expect(safeFileName('a<b>c:d"e|f?g*h')).toBe('a b c d e f g h')
    expect(safeFileName('书名. ')).toBe('书名')
  })

  it('空名字兜底', () => {
    expect(safeFileName('   ')).toBe('未命名')
  })

  it('同名生成 (2)', () => {
    expect(uniqueFileName('三体.epub', [])).toBe('三体.epub')
    expect(uniqueFileName('三体.epub', ['三体.epub'])).toBe('三体 (2).epub')
    expect(uniqueFileName('三体.epub', ['三体.epub', '三体 (2).epub'])).toBe('三体 (3).epub')
  })

  it('大小写不同也算重名（Windows 是一回事）', () => {
    expect(uniqueFileName('Book.EPUB', ['book.epub'])).toBe('Book (2).epub')
  })

  it('没后缀自动补 .epub', () => {
    expect(uniqueFileName('三体', [])).toBe('三体.epub')
  })
})

describe('列表视图', () => {
  const books = [
    book({ id: '1', title: 'B 书', lastReadAt: 100, percent: 0.5 }),
    book({ id: '2', title: 'A 书', lastReadAt: 300 }),
    book({ id: '3', title: 'C 书', lastReadAt: 0 }),
  ]

  it('搜索书名 / 作者 / 文件名', () => {
    expect(filterBooks(books, 'a 书', 'all').map((b) => b.id)).toEqual(['2'])
    expect(filterBooks(books, '刘慈欣', 'all')).toHaveLength(3)
    expect(filterBooks(books, '不存在', 'all')).toHaveLength(0)
  })

  it('最近阅读只留读过的', () => {
    expect(filterBooks(books, '', 'reading').map((b) => b.id).sort()).toEqual(['1', '2'])
  })

  it('排序：最近阅读 / 书名', () => {
    expect(sortBooks(books, 'recent').map((b) => b.id)).toEqual(['2', '1', '3'])
    expect(sortBooks(books, 'title').map((b) => b.title)).toEqual(['A 书', 'B 书', 'C 书'])
  })

  it('进度文案', () => {
    expect(percentLabel(0)).toBe('未开始')
    expect(percentLabel(0.42)).toBe('42%')
    expect(percentLabel(1)).toBe('已读完')
  })

  it('时间文案', () => {
    const now = Date.UTC(2026, 9, 30, 12, 0, 0)
    expect(formatWhen(0, now)).toBe('还没读过')
    expect(formatWhen(now - 30_000, now)).toBe('刚刚')
    expect(formatWhen(now - 3_600_000, now)).toBe('1 小时前')
  })
})

describe('从目录重建（清单坏了 / 换了目录）', () => {
  it('已有的书保留元数据，只更新大小时间', () => {
    const known = [book({ id: 'keep', file: '三体.epub', title: '三体', percent: 0.7 })]
    const out = rebuildFromFiles([{ path: '三体.epub', size: 2048, mtime: 99 }], known)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe('keep')
    expect(out[0]?.title).toBe('三体')
    expect(out[0]?.percent).toBe(0.7)
    expect(out[0]?.size).toBe(2048)
  })

  it('没登记过的文件建成占位书（标题先用文件名）', () => {
    const out = rebuildFromFiles([{ path: '新书.epub', size: 10, mtime: 1 }])
    expect(out[0]?.title).toBe('新书')
    expect(out[0]?.broken).toBeUndefined()
  })
})

describe('内容哈希', () => {
  it('同样的字节 → 同样的 id；不同字节 → 不同 id', async () => {
    const a = new TextEncoder().encode('hello epub')
    const b = new TextEncoder().encode('hello epub!')
    const ha = await hashBytes(a)
    expect(ha).toMatch(/^[0-9a-f]{16}$/)
    expect(await hashBytes(a)).toBe(ha)
    expect(await hashBytes(b)).not.toBe(ha)
  })
})
