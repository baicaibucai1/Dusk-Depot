import { describe, expect, it } from 'vitest'
import { canEdit, isImagePath, kindOf, previewOf } from '../../src/core/model/fileKind'

describe('kindOf', () => {
  it('md 是主格式', () => {
    expect(kindOf('a.md')).toBe('md')
    expect(kindOf('目录/A.MD')).toBe('md')
    expect(kindOf('a.markdown')).toBe('md')
  })

  it('文本 / 代码 / 表格 / 图片 / 压缩包各归各的', () => {
    expect(kindOf('说明.txt')).toBe('text')
    expect(kindOf('论文.pdf')).toBe('pdf')
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

describe('PDF 与图片（中间区可预览的那一类）', () => {
  it('pdf 是独立种类，不再算文本', () => {
    expect(kindOf('a.pdf')).toBe('pdf')
    expect(kindOf('目录/A.PDF')).toBe('pdf')
    expect(kindOf('a.txt')).toBe('text')
  })

  it('图片扩展名覆盖一套（分类 / 图标 / 附件共用同一张表）', () => {
    for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.ico']) {
      expect(kindOf(`x${ext}`)).toBe('image')
      expect(isImagePath(`x${ext}`)).toBe(true)
    }
  })

  it('previewOf 只说谁能进中间区预览', () => {
    expect(previewOf('a.png')).toBe('image')
    expect(previewOf('a.pdf')).toBe('pdf')
    expect(previewOf('a.md')).toBeNull()
    expect(previewOf('a.txt')).toBeNull()
    expect(previewOf('a.zip')).toBeNull()
  })

  it('图片 / PDF 都不能编辑（只读预览）', () => {
    expect(canEdit('a.md')).toBe(true)
    expect(canEdit('a.pdf')).toBe(false)
    expect(canEdit('a.png')).toBe(false)
  })
})
