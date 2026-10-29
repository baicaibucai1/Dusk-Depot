import { describe, expect, it } from 'vitest'
import {
  backlinksOf,
  outgoingRefs,
  pendingLinksOf,
  refHits,
  resolvePath,
  normalizeRel,
  resolveWiki,
  wikiSection,
} from '../../src/core/markdown/links'

const files = {
  'notes/路径层.md': '# 路径层\n\n正文',
  'notes/单一真相.md': '# 单一真相\n\n见 [[路径层]] 和 [另一篇](notes/记账.md)',
  'notes/记账.md': '# 记账\n\n被标准链接指向',
  '2026-10-17-雨天.md': '# 雨天\n\n今天写点东西',
} as Record<string, string>

describe('resolveWiki', () => {
  it('按标题解析', () => {
    expect(resolveWiki(files, '路径层')).toBe('notes/路径层.md')
    expect(resolveWiki(files, '雨天')).toBe('2026-10-17-雨天.md')
  })

  it('按文件名解析', () => {
    expect(resolveWiki(files, '2026-10-17-雨天')).toBe('2026-10-17-雨天.md')
  })

  it('按路径解析（带不带 .md 都行）', () => {
    expect(resolveWiki(files, 'notes/路径层')).toBe('notes/路径层.md')
    expect(resolveWiki(files, 'notes/路径层.md')).toBe('notes/路径层.md')
  })

  it('带小节和别名也能解析', () => {
    expect(resolveWiki(files, '路径层#三条规矩')).toBe('notes/路径层.md')
    expect(resolveWiki(files, '路径层|显示名')).toBe('notes/路径层.md')
  })

  it('还没建的篇目返回 null', () => {
    expect(resolveWiki(files, '人物')).toBeNull()
    expect(resolveWiki(files, '')).toBeNull()
  })
})

describe('resolvePath', () => {
  it('认相对路径（带不带 .md）', () => {
    expect(resolvePath(files, 'notes/记账.md')).toBe('notes/记账.md')
    expect(resolvePath(files, 'notes/记账')).toBe('notes/记账.md')
    expect(resolvePath(files, './notes/记账.md')).toBe('notes/记账.md')
  })

  it('不存在的路径返回 null', () => {
    expect(resolvePath(files, 'notes/不存在.md')).toBeNull()
  })
})

describe('outgoingRefs', () => {
  it('双链按名字、标准链接按路径，两种都收', () => {
    const refs = outgoingRefs(files['notes/单一真相.md'] ?? '')
    expect(refs).toContainEqual({ kind: 'wiki', value: '路径层' })
    expect(refs).toContainEqual({ kind: 'path', value: 'notes/记账.md' })
  })

  it('外链不算站内引用', () => {
    expect(outgoingRefs('[官网](https://example.com)')).toEqual([])
    expect(outgoingRefs('[邮件](mailto:a@b.c)')).toEqual([])
  })
})

describe('refHits', () => {
  it('标准链接能命中目标', () => {
    expect(refHits(files, { kind: 'path', value: 'notes/记账.md' }, 'notes/记账.md')).toBe(true)
    expect(refHits(files, { kind: 'path', value: 'notes/记账' }, 'notes/记账.md')).toBe(true)
  })

  it('双链按名字命中', () => {
    expect(refHits(files, { kind: 'wiki', value: '路径层' }, 'notes/路径层.md')).toBe(true)
    expect(refHits(files, { kind: 'wiki', value: '不存在' }, 'notes/路径层.md')).toBe(false)
  })
})

describe('反链与悬空', () => {
  it('标准链接也算反链', () => {
    const list = backlinksOf(files, 'notes/记账.md')
    expect(list.map((b) => b.path)).toContain('notes/单一真相.md')
  })

  it('指向不存在的路径会被列进"悬空"', () => {
    const withBroken = { ...files, 'x.md': '# x\n\n[没了](notes/没了.md)' }
    expect(pendingLinksOf(withBroken, 'x.md')).toContain('notes/没了.md')
  })
})

describe('wikiSection', () => {
  it('取出 # 后面的小节名', () => {
    expect(wikiSection('路径层#三条规矩')).toBe('三条规矩')
    expect(wikiSection('路径层')).toBeNull()
    expect(wikiSection('路径层#')).toBeNull()
  })
})

describe('相对路径（../ 与绝对写法）', () => {
  const files = {
    '开始这里.md': '',
    '项目/周计划.md': '# 周计划\n\n回到 [开始这里](../开始这里.md)。\n',
    '项目/子/深.md': '[上级](../周计划.md) [根](../../开始这里.md)\n',
  }

  it('normalizeRel 处理 . 与 ..', () => {
    expect(normalizeRel('', 'a/b.md')).toBe('a/b.md')
    expect(normalizeRel('项目', '../开始这里.md')).toBe('开始这里.md')
    expect(normalizeRel('项目/子', '../../开始这里.md')).toBe('开始这里.md')
    expect(normalizeRel('项目', './周计划.md')).toBe('项目/周计划.md')
  })

  it('子目录里 ../ 能解析到根上的篇', () => {
    expect(resolvePath(files, '../开始这里.md', '项目/周计划.md')).toBe('开始这里.md')
    expect(resolvePath(files, '../周计划.md', '项目/子/深.md')).toBe('项目/周计划.md')
    expect(resolvePath(files, '../../开始这里.md', '项目/子/深.md')).toBe('开始这里.md')
  })

  it('不带出发路径时仍按仓库根算（老写法不坏）', () => {
    expect(resolvePath(files, '项目/周计划.md')).toBe('项目/周计划.md')
    expect(resolvePath(files, './项目/周计划')).toBe('项目/周计划.md')
  })

  it('绝对写法 /a/b.md 也认', () => {
    expect(resolvePath(files, '/项目/周计划.md')).toBe('项目/周计划.md')
  })

  it('往上跳过头就是解析不到，不瞎猜', () => {
    expect(resolvePath(files, '../../../开始这里.md', '项目/周计划.md')).toBe('开始这里.md')
    expect(resolvePath(files, '../不存在.md', '项目/周计划.md')).toBeNull()
  })
})
