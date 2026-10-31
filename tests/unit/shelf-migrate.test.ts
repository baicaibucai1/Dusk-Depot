import { describe, expect, it } from 'vitest'
import type { Entry, Host } from '../../src/core/ports/host'
import { copyShelfStaged, dirRelation, safeRelative } from '../../src/core/shelf/migrate'

/**
 * 内存宿主。故意**不实现 move** —— 让搬迁走"读 → 写 → 删"那条兜底路径，
 * 这条路径才是浏览器里的真实路径，也最容易写坏。
 */
class FakeHost implements Host {
  files = new Map<string, { bytes: Uint8Array; mtime: number }>()
  dirs = new Set<string>()
  readonly kind = 'memory' as const
  readonly label = 'test'
  readonly where = ''
  readonly capabilities = { pickDir: false, watch: false, durable: false, keychain: false, reveal: false }

  /** 写到这个路径时抛错（模拟磁盘满 / 权限被撤） */
  failWrite: string | null = null
  /** 返回错误的大小（模拟复制不完整） */
  badStat: string | null = null

  seed(path: string, text: string): void {
    this.files.set(path, { bytes: new TextEncoder().encode(text), mtime: 1 })
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'))
  }

  async list(): Promise<Entry[]> {
    return [
      ...Array.from(this.dirs).map<Entry>((path) => ({ path, kind: 'dir', size: 0, mtime: 0 })),
      ...Array.from(this.files.entries()).map<Entry>(([path, v]) => ({
        path,
        kind: 'file',
        size: v.bytes.length,
        mtime: v.mtime,
      })),
    ]
  }

  async read(path: string): Promise<Uint8Array> {
    const hit = this.files.get(path)
    if (!hit) throw new Error(`NotFound: ${path}`)
    return hit.bytes.slice()
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    if (this.failWrite && path.includes(this.failWrite)) throw new Error('disk full')
    this.files.set(path, { bytes: bytes.slice(), mtime: 2 })
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'))
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
    this.dirs.delete(path)
  }

  async mkdir(path: string): Promise<void> {
    if (path) this.dirs.add(path)
  }

  async rmdir(path: string): Promise<void> {
    for (const p of [...this.files.keys()]) if (p === path || p.startsWith(`${path}/`)) this.files.delete(p)
    for (const d of [...this.dirs]) if (d === path || d.startsWith(`${path}/`)) this.dirs.delete(d)
  }

  async stat(path: string): Promise<{ size: number; mtime: number } | null> {
    const hit = this.files.get(path)
    if (!hit) return null
    if (this.badStat && path.includes(this.badStat)) return { size: hit.bytes.length + 1, mtime: hit.mtime }
    return { size: hit.bytes.length, mtime: hit.mtime }
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  text(path: string): string {
    const hit = this.files.get(path)
    if (!hit) throw new Error(`没有这个文件：${path}`)
    return new TextDecoder().decode(hit.bytes)
  }
}

const LIB = JSON.stringify({
  version: 1,
  updatedAt: 1,
  books: [{ id: 'b1', file: '三体.epub', fileName: '三体.epub', title: '三体', author: '', bookmarks: [] }],
})

function source(): FakeHost {
  const h = new FakeHost()
  h.seed('library.json', LIB)
  h.seed('三体.epub', 'EPUB-BYTES')
  h.seed('.trash/old.epub', 'OLD')
  return h
}

describe('书架搬迁：暂存 → 校验 → 落位', () => {
  it('成功后目标根目录文件齐全，暂存目录被清掉', async () => {
    const src = source()
    const dst = new FakeHost()
    const phases: string[] = []
    const out = await copyShelfStaged(src, dst, (p) => phases.push(p.phase))

    expect(out.files).toBe(3)
    expect(dst.text('library.json')).toBe(LIB)
    expect(dst.text('三体.epub')).toBe('EPUB-BYTES')
    expect(dst.text('.trash/old.epub')).toBe('OLD')
    expect(Array.from(dst.dirs).some((d) => d.startsWith('.dusk-migrate-'))).toBe(false)
    expect(phases).toContain('copy')
    expect(phases).toContain('verify')
    expect(phases).toContain('commit')

    // 旧书架原样不动
    expect(src.text('三体.epub')).toBe('EPUB-BYTES')
  })

  it('复制中途失败：目标回到空目录，旧书架完整', async () => {
    const src = source()
    const dst = new FakeHost()
    dst.failWrite = '三体.epub'

    await expect(copyShelfStaged(src, dst)).rejects.toThrow('disk full')

    expect(Array.from(dst.files.keys())).toEqual([])
    expect(Array.from(dst.dirs)).toEqual([])
    expect(src.text('三体.epub')).toBe('EPUB-BYTES')
  })

  it('落位阶段目标已有同名文件：不覆盖，本次产物清干净', async () => {
    const src = source()
    const dst = new FakeHost()
    dst.seed('三体.epub', 'USER-OWN-FILE')

    await expect(copyShelfStaged(src, dst)).rejects.toThrow('不会覆盖')

    expect(dst.text('三体.epub')).toBe('USER-OWN-FILE')
    expect(dst.files.has('library.json')).toBe(false)
    expect(Array.from(dst.dirs).some((d) => d.startsWith('.dusk-migrate-'))).toBe(false)
  })

  it('校验发现大小不一致：不落位，全部清掉', async () => {
    const src = source()
    const dst = new FakeHost()
    dst.badStat = '.dusk-migrate-'

    await expect(copyShelfStaged(src, dst)).rejects.toThrow('复制不完整')
    expect(dst.files.has('三体.epub')).toBe(false)
    expect(Array.from(dst.dirs).some((d) => d.startsWith('.dusk-migrate-'))).toBe(false)
  })

  it('清单里登记的书在暂存目录里找不到：拒绝落位', async () => {
    const src = new FakeHost()
    src.seed(
      'library.json',
      JSON.stringify({
        version: 1,
        updatedAt: 1,
        books: [{ id: 'b1', file: '缺了.epub', fileName: '缺了.epub', title: '缺了', author: '', bookmarks: [] }],
      }),
    )
    src.seed('别的.epub', 'x')
    const dst = new FakeHost()

    await expect(copyShelfStaged(src, dst)).rejects.toThrow('缺了这本书的文件')
    expect(dst.files.size).toBe(0)
  })

  it('源清单坏了不拦着搬家（boot 会重建）', async () => {
    const src = new FakeHost()
    src.seed('library.json', '{ 坏掉的 json')
    src.seed('三体.epub', 'EPUB-BYTES')
    const dst = new FakeHost()

    await expect(copyShelfStaged(src, dst)).resolves.toMatchObject({ files: 2 })
    expect(dst.text('三体.epub')).toBe('EPUB-BYTES')
  })
})

describe('搬迁前的关系检查', () => {
  it('同一目录 / 父子目录都能认出来', () => {
    expect(dirRelation('C:\\Books', 'c:/books/')).toBe('same')
    // a-in-b 读作"a 在 b 里面"
    expect(dirRelation('C:\\Books', 'C:\\Books\\sub')).toBe('b-in-a')
    expect(dirRelation('C:\\Books\\sub', 'C:\\Books')).toBe('a-in-b')
    expect(dirRelation('C:\\Books', 'D:\\Books')).toBe('none')
  })

  it('源路径不许出现 .. / 绝对路径 / 反斜杠', () => {
    expect(safeRelative('a/b.epub')).toBe(true)
    expect(safeRelative('../a.epub')).toBe(false)
    expect(safeRelative('/etc/passwd')).toBe(false)
    expect(safeRelative('a\\b.epub')).toBe(false)
    expect(safeRelative('a//b.epub')).toBe(false)
  })
})
