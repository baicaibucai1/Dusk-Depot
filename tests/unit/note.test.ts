import { describe, expect, it } from 'vitest'
import {
  folderPath,
  notePath,
  sanitizeName,
  uniquePath,
  withSameExt,
} from '../../src/core/model/note'

describe('sanitizeName', () => {
  it('去掉 Windows 非法字符', () => {
    expect(sanitizeName('a<b>c:d"e/f\\g|h?i*j')).toBe('abcdefghij')
  })

  it('中文与空格原样保留', () => {
    expect(sanitizeName('  雨天的 散步  ')).toBe('雨天的 散步')
  })

  it('尾部点与空格要去掉（Windows 不允许）', () => {
    expect(sanitizeName('标题.')).toBe('标题')
    expect(sanitizeName('标题 . . ')).toBe('标题')
  })

  it('连续空白压成一个', () => {
    expect(sanitizeName('a    b')).toBe('a b')
  })

  it('超长按码点截断，不劈坏 emoji', () => {
    const long = '🌧'.repeat(80)
    const out = sanitizeName(long)
    expect([...out].length).toBe(60)
    expect(out).toBe('🌧'.repeat(60))
  })
})

describe('路径拼装', () => {
  it('notePath 落在指定目录，标题空着叫未命名', () => {
    expect(notePath('thoughts', '雨天')).toBe('thoughts/雨天.md')
    expect(notePath('', '雨天')).toBe('雨天.md')
    expect(notePath('a', '   ')).toBe('a/未命名.md')
  })

  it('folderPath 不带后缀', () => {
    expect(folderPath('', '读书')).toBe('读书')
  })

  it('withSameExt 沿用旧后缀', () => {
    expect(withSameExt('新名', 'a/旧名.md')).toBe('新名.md')
    expect(withSameExt('新名.md', 'a/旧名.md')).toBe('新名.md')
  })
})

describe('uniquePath', () => {
  const existsOf = (set: string[]) => (p: string) => set.includes(p)

  it('不撞名就原样返回', () => {
    expect(uniquePath('a/未命名.md', existsOf([]))).toBe('a/未命名.md')
  })

  it('撞名加 -2，再撞 -3', () => {
    const exists = existsOf(['a/未命名.md', 'a/未命名-2.md'])
    expect(uniquePath('a/未命名.md', exists)).toBe('a/未命名-3.md')
  })

  it('目录没有后缀，加在末尾', () => {
    expect(uniquePath('读书', existsOf(['读书']))).toBe('读书-2')
  })
})
