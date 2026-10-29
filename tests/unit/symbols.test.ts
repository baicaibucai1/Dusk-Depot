import { describe, expect, it } from 'vitest'
import {
  CATEGORIES,
  SYMBOLS,
  isSymbol,
  searchSymbols,
  withRecent,
} from '../../src/core/model/symbols'
import { emptyMeta, iconsOf, parseVault, pruneMeta, serializeVault, setIcon } from '../../src/core/model/vault'

describe('符号目录', () => {
  it('每个类目都有符号，数量适度（翻得动）', () => {
    for (const c of CATEGORIES) {
      const n = SYMBOLS.filter((s) => s.cat === c).length
      expect(n).toBeGreaterThanOrEqual(10)
      expect(n).toBeLessThanOrEqual(22)
    }
  })

  it('同一个字符不在两类里重复出现', () => {
    const seen = new Map<string, string>()
    const dup: string[] = []
    for (const s of SYMBOLS) {
      const prev = seen.get(s.ch)
      if (prev) dup.push(`${s.ch} 同时出现在「${prev}」和「${s.cat}」`)
      else seen.set(s.ch, s.cat)
    }
    expect(dup).toEqual([])
  })

  it('名字都不为空，符号都是单字符（或 ZWJ 组合）', () => {
    for (const s of SYMBOLS) {
      expect(s.name.trim().length).toBeGreaterThan(0)
      expect(isSymbol(s.ch)).toBe(true)
    }
  })
})

describe('searchSymbols', () => {
  it('空查询返回全部', () => {
    expect(searchSymbols(SYMBOLS, '')).toHaveLength(SYMBOLS.length)
    expect(searchSymbols(SYMBOLS, '   ')).toHaveLength(SYMBOLS.length)
  })

  it('按名字搜', () => {
    const hits = searchSymbols(SYMBOLS, '完成')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((s) => s.ch === '✅')).toBe(true)
  })

  it('按关键词搜（用户打的词和名字不一样）', () => {
    expect(searchSymbols(SYMBOLS, '勾').some((s) => s.ch === '✅')).toBe(true)
    expect(searchSymbols(SYMBOLS, 'rocket').some((s) => s.ch === '🚀')).toBe(true)
    expect(searchSymbols(SYMBOLS, '紧急').some((s) => s.ch === '🔥')).toBe(true)
  })

  it('直接打字符本身，它排第一（不被关键词命中挤下去）', () => {
    // 搜 "➡️" 时，名字里带「箭头」的那一堆也会命中关键词，但字符本身必须排第一
    const hits = searchSymbols(SYMBOLS, '➡️')
    expect(hits[0]?.ch).toBe('➡️')
  })

  it('搜不到就是空，不瞎返回', () => {
    expect(searchSymbols(SYMBOLS, 'zzzz不存在的词')).toEqual([])
  })
})

describe('withRecent', () => {
  it('新用的放最前，重复的挪上来而不是出现两次', () => {
    expect(withRecent(['🚀', '📌'], '📌')).toEqual(['📌', '🚀'])
    expect(withRecent(['🚀'], '💡')).toEqual(['💡', '🚀'])
  })

  it('有上限，老的自然掉出去', () => {
    let list: string[] = []
    for (const ch of ['a', 'b', 'c', 'd']) list = withRecent(list, ch, 3)
    expect(list).toEqual(['d', 'c', 'b'])
  })
})

describe('isSymbol', () => {
  it('emoji 与符号是真，文字和空串不是', () => {
    expect(isSymbol('🚀')).toBe(true)
    expect(isSymbol('✅')).toBe(true)
    expect(isSymbol('👨‍💻')).toBe(true) // ZWJ 组合
    expect(isSymbol('→')).toBe(true)
    expect(isSymbol('')).toBe(false)
    expect(isSymbol('   ')).toBe(false)
    expect(isSymbol('项目')).toBe(false)
    expect(isSymbol('abc')).toBe(false)
    expect(isSymbol('这是一整句话，不该当图标')).toBe(false)
  })
})

describe('文件夹图标存在 .zzq 里', () => {
  it('设了就能读回来', () => {
    const meta = setIcon(emptyMeta(), '项目', '🚀')
    expect(iconsOf(meta)).toEqual({ 项目: '🚀' })
    expect(meta.files['项目']?.icon).toBe('🚀')
  })

  it('清掉之后不留空键（文件里不留 "icon": ""）', () => {
    const meta = setIcon(setIcon(emptyMeta(), '项目', '🚀'), '项目', '')
    expect(iconsOf(meta)).toEqual({})
    expect(meta.files['项目']).toBeUndefined()
    expect(serializeVault(meta)).not.toContain('icon')
  })

  it('清除图标不会顺手删掉同一条上的别的属性', () => {
    const meta = setIcon({ ...emptyMeta(), files: { 项目: { starred: true } } }, '项目', '🚀')
    const cleared = setIcon(meta, '项目', '')
    expect(cleared.files['项目']).toEqual({ starred: true })
  })

  it('往返：写出去再读回来，图标还在', () => {
    const text = serializeVault(setIcon(emptyMeta(), '素材', '🎨'))
    expect(iconsOf(parseVault(text))).toEqual({ 素材: '🎨' })
  })

  it('删掉文件夹时图标跟着清（不留悬空条目）', () => {
    const meta = setIcon(emptyMeta(), '素材/图', '🎨')
    expect(iconsOf(pruneMeta(meta, ['素材']))).toEqual({})
  })

  it('坏文件里 icon 不是字符串就当没有，不炸', () => {
    const meta = parseVault('{"files":{"项目":{"icon":123}}}')
    expect(iconsOf(meta)).toEqual({})
  })
})
