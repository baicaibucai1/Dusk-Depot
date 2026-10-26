import { describe, expect, it } from 'vitest'
import {
  extOf,
  isHidden,
  joinPath,
  nameOf,
  normalizePath,
  parentOf,
  samePath,
  stemOf,
} from '../../src/core/model/path'

describe('normalizePath', () => {
  it('把反斜杠归一成正斜杠', () => {
    expect(normalizePath('thoughts\\2026\\雨天.md')).toBe('thoughts/2026/雨天.md')
  })

  it('丢掉空段和当前目录段', () => {
    expect(normalizePath('a//b/./c')).toBe('a/b/c')
  })

  it('就地回退一级', () => {
    expect(normalizePath('a/b/../c')).toBe('a/c')
  })

  it('根目录返回空串', () => {
    expect(normalizePath('')).toBe('')
    expect(normalizePath('.')).toBe('')
  })

  it('越出仓库的 .. 直接抛，不悄悄夹紧', () => {
    expect(() => normalizePath('../外面.md')).toThrow(/越出仓库/)
    expect(() => normalizePath('a/../../外面.md')).toThrow(/越出仓库/)
  })

  it('绝对路径一律拒绝', () => {
    expect(() => normalizePath('/etc/passwd')).toThrow(/绝对路径/)
    expect(() => normalizePath('C:\\Windows\\x.md')).toThrow(/绝对路径/)
  })
})

describe('取段', () => {
  it('parentOf / nameOf', () => {
    expect(parentOf('a/b/c.md')).toBe('a/b')
    expect(parentOf('c.md')).toBe('')
    expect(nameOf('a/b/c.md')).toBe('c.md')
    expect(nameOf('c.md')).toBe('c.md')
  })
})

describe('后缀', () => {
  it('正常取后缀', () => {
    expect(extOf('a/b/雨天.md')).toBe('.md')
    expect(stemOf('a/b/雨天.md')).toBe('雨天')
  })

  it('没有后缀', () => {
    expect(extOf('a/README')).toBe('')
    expect(stemOf('a/README')).toBe('README')
  })

  it('.gitignore 不算"有后缀"', () => {
    expect(extOf('.gitignore')).toBe('')
    expect(stemOf('.gitignore')).toBe('.gitignore')
  })

  it('多点只取最后一个', () => {
    expect(extOf('a/archive.tar.gz')).toBe('.gz')
    expect(stemOf('a/archive.tar.gz')).toBe('archive.tar')
  })
})

describe('拼接与判定', () => {
  it('joinPath 忽略空段', () => {
    expect(joinPath('', 'a')).toBe('a')
    expect(joinPath('a', 'b')).toBe('a/b')
    expect(joinPath('a', '', 'b')).toBe('a/b')
  })

  it('任意一段点开头就是隐藏', () => {
    expect(isHidden('.git/config')).toBe(true)
    expect(isHidden('a/.dusk/state.json')).toBe(true)
    expect(isHidden('a/b.md')).toBe(false)
  })

  it('同名判定不分大小写', () => {
    expect(samePath('A/b.md', 'a/B.md')).toBe(true)
    expect(samePath('a/b.md', 'a/c.md')).toBe(false)
  })
})
