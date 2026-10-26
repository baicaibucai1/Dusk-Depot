import { describe, expect, it } from 'vitest'
import {
  emptyMeta,
  getFileMeta,
  isListable,
  isReserved,
  parseVault,
  pruneMeta,
  serializeVault,
  setFileMeta,
  VAULT_MARK,
} from '../../src/core/model/vault'

describe('parseVault', () => {
  it('空文件当空的', () => {
    expect(parseVault('')).toEqual(emptyMeta())
    expect(parseVault('   \n ')).toEqual(emptyMeta())
  })

  it('坏 JSON 也当空的，不抛', () => {
    expect(parseVault('{ 这不是 json')).toEqual(emptyMeta())
    expect(parseVault('null')).toEqual(emptyMeta())
    expect(parseVault('[]')).toEqual(emptyMeta())
  })

  it('读出 pins 与 files，剔掉不合法条目', () => {
    const m = parseVault(
      JSON.stringify({
        pins: ['a.md', 3, null],
        files: { 'a.md': { starred: true }, 'b.md': 'not-an-object' },
      }),
    )
    expect(m.pins).toEqual(['a.md'])
    expect(m.files).toEqual({ 'a.md': { starred: true } })
  })

  it('v1 的顶层 starred 数组折进 files', () => {
    const m = parseVault(JSON.stringify({ pins: [], starred: ['x.md'] }))
    expect(m.files['x.md']).toEqual({ starred: true })
  })

  it('**保留不认识的字段** —— 别把别的版本写进去的东西冲掉', () => {
    const m = parseVault(JSON.stringify({ pins: [], futureThing: { x: 1 } }))
    expect(m.futureThing).toEqual({ x: 1 })
  })

  it('每份文件上不认识的字段也保留', () => {
    const m = parseVault(JSON.stringify({ files: { 'a.md': { cover: 'x.png' } } }))
    expect(m.files['a.md']).toEqual({ cover: 'x.png' })
  })
})

describe('serializeVault', () => {
  it('往返不丢东西', () => {
    let meta = { ...emptyMeta(), pins: ['notes/a.md'] }
    meta = setFileMeta(meta, 'notes/a.md', { starred: true, alias: '别名' })
    expect(parseVault(serializeVault(meta))).toEqual(meta)
  })

  it('总是写上 app 与 version，且不再写老字段', () => {
    const text = serializeVault({ ...emptyMeta(), app: '别的', version: 99 })
    const out = JSON.parse(text) as Record<string, unknown>
    expect(out.app).toBe('dusk-depot')
    expect(out.version).toBe(2)
    expect('starred' in out).toBe(false)
  })

  it('写出来是给人看的多行 JSON，结尾带换行', () => {
    const text = serializeVault(emptyMeta())
    expect(text).toContain('\n  "pins"')
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('小工具', () => {
  it('setFileMeta 是合并，不是替换', () => {
    let meta = setFileMeta(emptyMeta(), 'a.md', { starred: true })
    meta = setFileMeta(meta, 'a.md', { alias: '别名' })
    expect(getFileMeta(meta, 'a.md')).toEqual({ starred: true, alias: '别名' })
  })

  it('pruneMeta 连整棵子树一起清', () => {
    let meta = { ...emptyMeta(), pins: ['notes/a.md', 'notes/sub/b.md', 'keep.md'] }
    meta = setFileMeta(meta, 'notes/a.md', { starred: true })
    meta = setFileMeta(meta, 'notes/sub/b.md', { starred: true })
    meta = setFileMeta(meta, 'keep.md', { starred: true })

    const next = pruneMeta(meta, ['notes'])
    expect(next.pins).toEqual(['keep.md'])
    expect(Object.keys(next.files)).toEqual(['keep.md'])
  })
})

describe('.zzq 是保留文件', () => {
  it('不列、不删、不参与 diff', () => {
    expect(isReserved(VAULT_MARK)).toBe(true)
    expect(isListable(VAULT_MARK)).toBe(false)
    expect(isReserved('notes/.zzq')).toBe(true)
    expect(isListable('notes/正常.md')).toBe(true)
  })
})
