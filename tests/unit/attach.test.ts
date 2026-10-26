import { describe, expect, it } from 'vitest'
import {
  ATTACH_DIR,
  attachName,
  attachPath,
  extOfMime,
  imageRefs,
  isImageName,
  safeFileName,
} from '../../src/core/model/attach'

describe('图片类型', () => {
  it('常见后缀都认', () => {
    for (const n of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg', 'g.bmp']) {
      expect(isImageName(n)).toBe(true)
    }
    expect(isImageName('笔记.md')).toBe(false)
    expect(isImageName('无后缀')).toBe(false)
  })

  it('MIME 猜扩展名', () => {
    expect(extOfMime('image/png')).toBe('png')
    expect(extOfMime('image/jpeg')).toBe('jpg')
    expect(extOfMime('image/svg+xml')).toBe('svg')
    expect(extOfMime('application/octet-stream')).toBe('png')
  })
})

describe('文件名', () => {
  it('去掉路径与空白，保留中文', () => {
    expect(safeFileName('C:\\x\\我的 图.png')).toBe('我的-图.png')
    expect(safeFileName('')).toBe('image')
  })

  it('带时间戳和随机后缀，不会互相覆盖', () => {
    const t = new Date(2026, 9, 18, 9, 5, 7)
    const a = attachName('截图.png', 'image/png', t)
    const b = attachName('截图.png', 'image/png', t)
    expect(a).toMatch(/^截图-20261018-090507-[a-z0-9]{4}\.png$/)
    expect(a).not.toBe(b)
  })

  it('剪贴板里没有扩展名时按 MIME 补', () => {
    const n = attachName('image', 'image/jpeg', new Date(2026, 0, 1, 0, 0, 0))
    expect(n.endsWith('.jpg')).toBe(true)
  })
})

describe('路径', () => {
  it('都落在图床目录下', () => {
    expect(attachPath('x.png')).toBe(`${ATTACH_DIR}/x.png`)
    expect(ATTACH_DIR).toBe('附件')
  })
})

describe('imageRefs', () => {
  it('挑出仓库内的图片引用', () => {
    const md = ['![](' + ATTACH_DIR + '/a.png)', '![说明](./附件/b.jpg)', '![](https://x/y.png)'].join('\n')
    expect(imageRefs(md).sort()).toEqual(['附件/a.png', '附件/b.jpg'])
  })

  it('外链和 data 不算仓库内引用', () => {
    expect(imageRefs('![](data:image/png;base64,AAA)')).toEqual([])
    expect(imageRefs('![](https://example.com/x.png)')).toEqual([])
  })

  it('没有图片返回空', () => {
    expect(imageRefs('# 标题\n正文')).toEqual([])
  })
})
