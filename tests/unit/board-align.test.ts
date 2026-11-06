import { describe, expect, it } from 'vitest'
import { snapBox, unionBox } from '../../src/core/board/align'

const box = (x: number, y: number, w = 200, h = 100) => ({ x, y, w, h })

describe('snapBox：贴边与中线', () => {
  it('左边差 3px 就吸过去，dx 是差值', () => {
    const r = snapBox(box(103, 500), [box(100, 0)])
    expect(r.dx).toBe(-3)
    expect(r.guides.some((g) => g.axis === 'x' && g.at === 100)).toBe(true)
  })

  it('右边贴到别人的右边', () => {
    // 被拖的块右边 = 305，另一块右边 = 300
    const r = snapBox(box(105, 500), [box(100, 0)])
    expect(r.dx).toBe(-5)
  })

  it('中线对中线（宽度不同，只有中线对得上）', () => {
    // 被拖的块中心 = 200，另一块中心也是 200；左右都差 8，只有中线进容差
    const r = snapBox(box(108, 500, 184), [box(100, 0, 200, 100)])
    expect(r.dx).toBe(0)
    const g = r.guides.find((x) => x.axis === 'x')
    expect(g?.kind).toBe('center')
    expect(g?.at).toBe(200)
  })

  it('超出容差不动', () => {
    const r = snapBox(box(120, 500), [box(100, 0)], 6)
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('x 和 y 各自独立吸', () => {
    const r = snapBox(box(104, 302), [box(100, 300)])
    expect(r.dx).toBe(-4)
    expect(r.dy).toBe(-2)
    expect(r.guides.map((g) => g.axis).sort()).toEqual(['x', 'y'])
  })

  it('没有别的块就不动', () => {
    expect(snapBox(box(10, 10), [])).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('容差 0 等于关掉', () => {
    expect(snapBox(box(103, 500), [box(100, 0)], 0).guides).toEqual([])
  })
})

describe('snapBox：选最近的那条', () => {
  it('两边都在容差内时吸近的', () => {
    // 左边差 5（吸到 a）、右边差 4（吸到 b）—— 取 4
    const a = box(100, 0, 100)
    const b = box(400, 0, 100)
    const r = snapBox(box(105, 300, 291), [a, b], 8)
    expect(r.dx).toBe(4) // 右边 396 -> 400
  })

  it('参考线要把两边的块串起来', () => {
    const target = box(100, 0, 200, 100)
    const r = snapBox(box(100, 400, 200, 100), [target])
    const g = r.guides.find((x) => x.axis === 'x')
    expect(g).toMatchObject({ at: 100, from: 0, to: 500 })
  })
})

describe('snapBox：不该吸的情况', () => {
  it('吸到自己的旧位置会来回跳，调用方必须排除自己 —— 这里验证"排除后就不动"', () => {
    const me = box(100, 100)
    expect(snapBox(box(102, 100), [], 6).dx).toBe(0)
    // 传进去就会被吸回去，说明"排除自己"是调用方的责任
    expect(snapBox(box(102, 100), [me], 6).dx).toBe(-2)
  })
})

describe('unionBox', () => {
  it('空数组给 null', () => {
    expect(unionBox([])).toBeNull()
  })

  it('把几块框成一个', () => {
    expect(unionBox([box(0, 0, 100, 50), box(200, 100, 100, 50)])).toEqual({
      x: 0,
      y: 0,
      w: 300,
      h: 150,
    })
  })

  it('单块就是它自己', () => {
    expect(unionBox([box(7, 9, 30, 40)])).toEqual({ x: 7, y: 9, w: 30, h: 40 })
  })
})
