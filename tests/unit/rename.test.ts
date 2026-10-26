import { describe, expect, it } from 'vitest'
import type { FileMap } from '../../src/core/model/library'
import { deleteEntry, moveEntry, renameEntry, retargetLinks } from '../../src/core/model/rename'

const base = (): FileMap => ({
  'notes/路径层.md': '# 路径层\n\n见 [[单一真相]] 与 [[单一真相#判据|那段]]。',
  'notes/单一真相.md': '# 单一真相\n\n正文。',
  'thoughts/雨天.md': '# 雨天\n\n也提到 [[单一真相]]。',
})

describe('retargetLinks', () => {
  it('保形：小节与显示文字都留着', () => {
    const map = new Map([['单一真相', '唯一真相']])
    expect(retargetLinks('见 [[单一真相#判据|那段]] 与 [[单一真相]]', map)).toEqual({
      text: '见 [[唯一真相#判据|那段]] 与 [[唯一真相]]',
      count: 2,
    })
  })

  it('没命中的原样不动', () => {
    const map = new Map([['甲', '乙']])
    expect(retargetLinks('见 [[丙]]', map)).toEqual({ text: '见 [[丙]]', count: 0 })
  })
})

describe('renameEntry · 文件', () => {
  it('改名后全库指向它的链接跟着改', () => {
    const files = base()
    const r = renameEntry(files, ['notes'], 'notes/单一真相.md', '唯一真相')
    if (!r.ok) throw new Error(r.error)

    expect(r.to).toBe('notes/唯一真相.md')
    expect(r.files['notes/唯一真相.md']).toBeDefined()
    expect(r.files['notes/路径层.md']).toContain('[[唯一真相]]')
    expect(r.files['notes/路径层.md']).toContain('[[唯一真相#判据|那段]]')
    expect(r.files['thoughts/雨天.md']).toContain('[[唯一真相]]')
    expect(r.links).toBe(3)
  })

  it('正文第一行标题逐字等于旧名时才跟着改', () => {
    const r = renameEntry(base(), ['notes'], 'notes/单一真相.md', '唯一真相')
    if (!r.ok) throw new Error(r.error)
    expect(r.files['notes/唯一真相.md']).toMatch(/^# 唯一真相/)
    expect(r.retitled).toBe(true)
  })

  it('自起的小标题不碰', () => {
    const files = base()
    files['notes/单一真相.md'] = '# 我自己起的名\n\n正文。'
    const r = renameEntry(files, ['notes'], 'notes/单一真相.md', '唯一真相')
    if (!r.ok) throw new Error(r.error)
    expect(r.files['notes/唯一真相.md']).toMatch(/^# 我自己起的名/)
    expect(r.retitled).toBe(false)
  })

  it('撞名拦下，不覆盖', () => {
    const r = renameEntry(base(), ['notes'], 'notes/单一真相.md', '路径层')
    expect(r).toEqual({ ok: false, error: expect.stringContaining('已经存在') })
  })

  it('空名字拦下', () => {
    const r = renameEntry(base(), ['notes'], 'notes/单一真相.md', '///')
    expect(r.ok).toBe(false)
  })

  it('没改名字就是空操作', () => {
    const r = renameEntry(base(), ['notes'], 'notes/单一真相.md', '单一真相')
    if (!r.ok) throw new Error(r.error)
    expect(r.moved).toEqual([])
  })
})

describe('renameEntry · 目录', () => {
  it('整棵子树跟着换前缀', () => {
    const files = base()
    const r = renameEntry(files, ['notes'], 'notes', '笔记')
    if (!r.ok) throw new Error(r.error)

    expect(Object.keys(r.files).sort()).toEqual(
      ['笔记/单一真相.md', '笔记/路径层.md', 'thoughts/雨天.md'].sort(),
    )
    expect(r.dirs).toEqual(['笔记'])
    expect(r.to).toBe('笔记')
  })
})

describe('moveEntry', () => {
  it('换目录以后，带路径的链接跟着改，裸名不变', () => {
    const files: FileMap = {
      'notes/甲.md': '# 甲\n\n正文。',
      'notes/引用.md': '见 [[notes/甲]] 与 [[甲]]。',
    }

    const r = moveEntry(files, ['notes', '读书'], 'notes/甲.md', '读书')
    if (!r.ok) throw new Error(r.error)

    expect(r.to).toBe('读书/甲.md')
    expect(r.files['notes/引用.md']).toContain('[[读书/甲]]')
    expect(r.files['notes/引用.md']).toContain('[[甲]]')
    // 只有"带路径"那一处算改动，裸名那处不算
    expect(r.links).toBe(1)
  })

  it('拖进自己里面被拦下', () => {
    const r = moveEntry(base(), ['notes', 'notes/子'], 'notes', 'notes/子')
    expect(r).toEqual({ ok: false, error: expect.stringContaining('自己') })
  })

  it('目标位置重名被拦下', () => {
    const files: FileMap = { 'a/甲.md': '1', 'b/甲.md': '2' }
    const r = moveEntry(files, ['a', 'b'], 'a/甲.md', 'b')
    expect(r.ok).toBe(false)
  })

  it('移到根目录', () => {
    const r = moveEntry(base(), ['notes'], 'notes/单一真相.md', '')
    if (!r.ok) throw new Error(r.error)
    expect(r.to).toBe('单一真相.md')
  })
})

describe('deleteEntry', () => {
  it('删目录连整棵子树一起', () => {
    const files = base()
    const r = deleteEntry(files, ['notes'], 'notes')

    expect(Object.keys(r.files)).toEqual(['thoughts/雨天.md'])
    expect(r.dirs).toEqual([])
    expect(r.removed.sort()).toEqual(
      ['notes', 'notes/单一真相.md', 'notes/路径层.md'].sort(),
    )
  })

  it('删单篇不碰同目录别的', () => {
    const r = deleteEntry(base(), ['notes'], 'notes/单一真相.md')
    expect(Object.keys(r.files).sort()).toEqual(
      ['notes/路径层.md', 'thoughts/雨天.md'].sort(),
    )
    expect(r.dirs).toEqual(['notes'])
  })
})

describe('标准链接跟着改名走', () => {
  it('](旧路径.md) 会重写成新路径', () => {
    const files = { 'a.md': '# a\n\n[去看](b.md)', 'b.md': '# b' }
    const r = renameEntry(files, [], 'b.md', 'c')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.files['a.md']).toContain('(c.md)')
    expect(r.links).toBeGreaterThan(0)
  })

  it('带目录的路径也认', () => {
    const files = { 'a.md': '# a\n\n[去看](notes/b.md)', 'notes/b.md': '# b' }
    const r = renameEntry(files, [], 'notes/b.md', 'c')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.files['a.md']).toContain('(notes/c.md)')
  })
})