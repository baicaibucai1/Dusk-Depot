import { describe, expect, it } from 'vitest'
import { buildTreeFromEntries } from '../../src/core/model/library'

const entries = [
  { path: 'notes', kind: 'dir' as const },
  { path: 'notes/甲.md', kind: 'file' as const },
  { path: 'notes/乙.md', kind: 'file' as const },
  { path: 'thoughts', kind: 'dir' as const },
  { path: '收件箱.md', kind: 'file' as const },
]

const names = (nodes: ReturnType<typeof buildTreeFromEntries>) =>
  nodes.map((n) => (n.kind === 'dir' ? `${n.name}/` : n.name))

describe('buildTreeFromEntries', () => {
  it('默认顺序：目录在前，同类按名字', () => {
    expect(names(buildTreeFromEntries(entries))).toEqual(['notes/', 'thoughts/', '收件箱.md'])
  })

  it('空目录也列得出来', () => {
    const tree = buildTreeFromEntries([{ path: '空的', kind: 'dir' }])
    expect(names(tree)).toEqual(['空的/'])
    expect(tree[0]?.children).toEqual([])
  })

  it('置顶的排到最前，按置顶顺序而不是名字', () => {
    const pinned = ['收件箱.md', 'thoughts']
    const rank = (p: string) => {
      const i = pinned.indexOf(p)
      return i < 0 ? 1e9 : i
    }
    // 收件箱是文件、thoughts 是目录 —— 置顶优先级高过"目录在前"
    expect(names(buildTreeFromEntries(entries, rank))).toEqual([
      '收件箱.md',
      'thoughts/',
      'notes/',
    ])
  })

  it('同一个目录里的置顶也在内部生效', () => {
    const rank = (p: string) => (p === 'notes/乙.md' ? 0 : 1e9)
    const tree = buildTreeFromEntries(entries, rank)
    const notes = tree.find((n) => n.name === 'notes')
    expect(notes?.children?.map((c) => c.name)).toEqual(['乙.md', '甲.md'])
  })
})
