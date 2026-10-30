import { describe, expect, it } from 'vitest'
import { MATH_GROUPS, mathContextAt, placeCaret, searchMath } from '../../src/core/markdown/mathPanel'

describe('placeCaret', () => {
  it('有 $0 就把光标放那儿，且不把 $0 写进文档', () => {
    expect(placeCaret('\\frac{$0}{}')).toEqual({ text: '\\frac{}{}', caret: 6 })
  })

  it('没有 $0 就停在末尾', () => {
    expect(placeCaret('\\alpha')).toEqual({ text: '\\alpha', caret: 6 })
  })

  it('$0 在最前面也对（\\sqrt[$0]{} 这种）', () => {
    expect(placeCaret('\\sqrt[$0]{}')).toEqual({ text: '\\sqrt[]{}', caret: 6 })
  })
})

describe('mathContextAt', () => {
  it('行内：光标在两个 $ 之间', () => {
    const t = '质能方程 $E = mc^2$ 是著名的'
    expect(mathContextAt(t, t.indexOf('mc'))).toEqual({ kind: 'inline' })
  })

  it('行内：光标在 $ 外面就是 null', () => {
    const t = '质能方程 $E = mc^2$ 是著名的'
    expect(mathContextAt(t, 0)).toBeNull()
    expect(mathContextAt(t, t.length)).toBeNull()
  })

  it('块公式：光标在 $$ … $$ 中间（跨行）', () => {
    const t = '前面\n$$\n\\int_0^1 x\\,dx\n$$\n后面'
    expect(mathContextAt(t, t.indexOf('\\int'))).toEqual({ kind: 'block' })
  })

  it('块公式闭合之后就不再算了', () => {
    const t = '$$\nx\n$$\n后面的正文'
    expect(mathContextAt(t, t.length)).toBeNull()
  })

  it('跨行的行内 $ 不算 —— 行内公式本来不能换行', () => {
    const t = '一 $ 二\n三'
    expect(mathContextAt(t, t.length)).toBeNull()
  })

  it('转义的 \\$ 不算公式起点', () => {
    const t = '价格 \\$5 到 \\$10'
    expect(mathContextAt(t, t.indexOf('$5') + 1)).toBeNull()
  })

  it('两个 $ 并排（$$）不会把行内判成开着', () => {
    const t = '$$x$$ 后面'
    expect(mathContextAt(t, t.indexOf('x'))).toEqual({ kind: 'block' })
    expect(mathContextAt(t, t.length)).toBeNull()
  })
})

describe('公式目录', () => {
  it('六个分组都有内容', () => {
    expect(MATH_GROUPS).toHaveLength(6)
    for (const g of MATH_GROUPS) expect(g.items.length).toBeGreaterThan(5)
  })

  it('每条都有 tex 和 label', () => {
    for (const g of MATH_GROUPS) {
      for (const it of g.items) {
        expect(it.tex.trim().length).toBeGreaterThan(0)
        expect(it.label.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('搜「分数」能找到分式，搜「求和」能找到 ∑', () => {
    const a = searchMath('分数').flatMap((x) => x.items.map((i) => i.tex))
    expect(a.some((t) => t.includes('frac'))).toBe(true)
    const b = searchMath('求和').flatMap((x) => x.items.map((i) => i.label))
    expect(b).toContain('∑')
  })

  it('搜不到就空着，不硬塞', () => {
    expect(searchMath('zzzz')).toEqual([])
  })
})
