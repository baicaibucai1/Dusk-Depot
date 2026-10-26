import { describe, expect, it } from 'vitest'
import type { FileMap } from '../../src/core/model/library'
import type { Snapshot } from '../../src/core/model/flush'
import { diffRepo, flushRepo, settleBaseline } from '../../src/core/model/flush'
import { decodeBytes } from '../../src/core/model/text'
import type { Host } from '../../src/core/ports/host'

function fakeHost(initial: { files?: Record<string, string>; dirs?: string[] } = {}) {
  const files = new Map(Object.entries(initial.files ?? {}))
  const dirs = new Set(initial.dirs ?? [])
  const failing = new Set<string>()
  const log: string[] = []

  const host: Host = {
    kind: 'memory',
    label: 'fake',
    where: '',
    capabilities: { pickDir: false, watch: false, durable: false, keychain: false },

    async list() {
      return [
        ...[...dirs].map((path) => ({ path, kind: 'dir' as const, size: 0, mtime: 0 })),
        ...[...files.keys()].map((path) => ({ path, kind: 'file' as const, size: 0, mtime: 0 })),
      ]
    },
    async read(path) {
      return new TextEncoder().encode(files.get(path) ?? '')
    },
    async write(path, bytes) {
      if (failing.has(path)) throw new Error('写不进去')
      log.push(`write ${path}`)
      files.set(path, decodeBytes(bytes))
    },
    async remove(path) {
      if (failing.has(path)) throw new Error('删不掉')
      log.push(`remove ${path}`)
      files.delete(path)
    },
    async mkdir(path) {
      if (failing.has(path)) throw new Error('建不了')
      log.push(`mkdir ${path}`)
      dirs.add(path)
    },
    async rmdir(path) {
      if (failing.has(path)) throw new Error('删不了')
      log.push(`rmdir ${path}`)
      dirs.delete(path)
    },
  }

  return { host, files, dirs, failing, log }
}

const snap = (files: FileMap, dirs: string[] = []): Snapshot => ({ files, dirs })

describe('diffRepo · 文件', () => {
  it('只报变了的和删掉的', () => {
    const plan = diffRepo(
      snap({ 'a.md': '1', 'b.md': '2' }),
      snap({ 'a.md': '1', 'b.md': '2 改了', 'c.md': '新' }),
    )
    expect(plan.files).toEqual([
      { kind: 'write', path: 'b.md' },
      { kind: 'write', path: 'c.md' },
    ])
  })

  it('一模一样就一条都不报', () => {
    expect(diffRepo(snap({ 'a.md': '1' }), snap({ 'a.md': '1' })).files).toEqual([])
  })
})

describe('diffRepo · 目录', () => {
  it('新建的目录先建（浅在前）', () => {
    const plan = diffRepo(snap({}, []), snap({}, ['a', 'a/b', 'a/b/c']))
    expect(plan.dirs.map((d) => d.path)).toEqual(['a', 'a/b', 'a/b/c'])
  })

  it('删掉的目录后删（深在前）', () => {
    const plan = diffRepo(snap({}, ['a', 'a/b', 'a/b/c']), snap({}, []))
    expect(plan.dirs.map((d) => d.path)).toEqual(['a/b/c', 'a/b', 'a'])
  })
})

describe('flushRepo', () => {
  it('按 建目录 → 写 → 删文件 → 删目录 的顺序落盘', async () => {
    const { host, log } = fakeHost({ files: { '旧.md': 'x' }, dirs: ['旧目录'] })
    const plan = diffRepo(snap({ '旧.md': 'x' }, ['旧目录']), snap({ '新/甲.md': '正文' }, ['新']))

    await flushRepo(host, snap({ '新/甲.md': '正文' }, ['新']), plan)

    expect(log).toEqual(['mkdir 新', 'write 新/甲.md', 'remove 旧.md', 'rmdir 旧目录'])
  })

  it('写失败只报告、不抛出，别的照常写', async () => {
    const { host, failing, files } = fakeHost()
    failing.add('坏.md')

    const report = await flushRepo(
      host,
      snap({ '坏.md': 'x', '好.md': 'y' }),
      diffRepo(snap({}), snap({ '坏.md': 'x', '好.md': 'y' })),
    )

    expect(report.written).toEqual(['好.md'])
    expect(report.failed.map((f) => f.path)).toEqual(['坏.md'])
    expect(files.has('好.md')).toBe(true)
  })
})

describe('settleBaseline', () => {
  it('写失败的那条退回旧值，下次再试', async () => {
    const before = snap({ 'a.md': '旧', 'b.md': '旧' })
    const after = snap({ 'a.md': '新', 'b.md': '也新' })
    const { host, failing } = fakeHost()
    failing.add('a.md')

    const plan = diffRepo(before, after)
    const report = await flushRepo(host, after, plan)
    const next = settleBaseline(before, after, report)

    expect(next.files['a.md']).toBe('旧')
    expect(next.files['b.md']).toBe('也新')
  })

  it('删失败的那条放回基线', async () => {
    const before = snap({ 'a.md': '旧' })
    const after = snap({})
    const { host, failing } = fakeHost({ files: { 'a.md': '旧' } })
    failing.add('a.md')

    const plan = diffRepo(before, after)
    const report = await flushRepo(host, after, plan)
    const next = settleBaseline(before, after, report)

    expect(next.files['a.md']).toBe('旧')
  })

  it('建目录失败的也退回', async () => {
    const before = snap({}, [])
    const after = snap({}, ['新'])
    const { host, failing } = fakeHost()
    failing.add('新')

    const plan = diffRepo(before, after)
    const report = await flushRepo(host, after, plan)
    const next = settleBaseline(before, after, report)

    expect(next.dirs).toEqual([])
  })
})
