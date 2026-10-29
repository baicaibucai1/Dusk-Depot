import { describe, expect, it } from 'vitest'
import { canEdit, kindOf } from '../../src/core/model/fileKind'

describe('kindOf', () => {
  it('md 是主格式', () => {
    expect(kindOf('a.md')).toBe('md')
    expect(kindOf('目录/A.MD')).toBe('md')
    expect(kindOf('a.markdown')).toBe('md')
  })

  it('文本 / 代码 / 表格 / 图片 / 压缩包各归各的', () => {
    expect(kindOf('说明.txt')).toBe('text')
    expect(kindOf('论文.pdf')).toBe('text')
    expect(kindOf('x.ts')).toBe('code')
    expect(kindOf('x.json')).toBe('code')
    expect(kindOf('表.csv')).toBe('sheet')
    expect(kindOf('图.PNG')).toBe('image')
    expect(kindOf('包.zip')).toBe('archive')
  })

  it('认不出的给 unknown，不瞎猜', () => {
    expect(kindOf('a.zzz')).toBe('unknown')
    expect(kindOf('无后缀')).toBe('unknown')
    expect(kindOf('.gitignore')).toBe('unknown')
  })

  it('这版只有 md 能编辑', () => {
    expect(canEdit('a.md')).toBe(true)
    expect(canEdit('a.txt')).toBe(false)
    expect(canEdit('a.png')).toBe(false)
  })
})
