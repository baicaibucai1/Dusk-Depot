import { describe, expect, it } from 'vitest'
import {
  GAP,
  MIN_W,
  canvasHeight,
  clampPlacement,
  layoutBlocks,
  moveBy,
  nextSlot,
  resizeTo,
} from '../../src/core/note/layout'

describe('clampPlacement：不出界、不太窄', () => {
  it('宽度夹在 15..100', () => {
    expect(clampPlacement({ x: 0, y: 0, w: 5 }).w).toBe(MIN_W)
    expect(clampPlacement({ x: 0, y: 0, w: 140 }).w).toBe(100)
  })

  it('右边缘不许越界', () => {
    expect(clampPlacement({ x: 90, y: 0, w: 40 })).toEqual({ x: 60, y: 0, w: 40 })
  })

  it('x / y 不为负', () => {
    expect(clampPlacement({ x: -20, y: -30, w: 50 })).toEqual({ x: 0, y: 0, w: 50 })
  })
})

describe('layoutBlocks：摆过的用摆过的，没摆过的往下堆', () => {
  it('全新文档：按顺序竖向排开，各占整行', () => {
    const out = layoutBlocks([
      { height: 100 },
      { height: 80 },
      { height: 60 },
    ])
    expect(out).toEqual([
      { x: 0, y: 0, w: 100 },
      { x: 0, y: 100 + GAP, w: 100 },
      { x: 0, y: 100 + GAP + 80 + GAP, w: 100 },
    ])
  })

  it('摆过的位置原样保留（自由排版的核心）', () => {
    const out = layoutBlocks([
      { layout: { x: 0, y: 0, w: 40 }, height: 200 },
      { layout: { x: 60, y: 30, w: 35 }, height: 120 },
      { layout: { x: 0, y: 220, w: 40 }, height: 90 },
    ])
    expect(out).toEqual([
      { x: 0, y: 0, w: 40 },
      { x: 60, y: 30, w: 35 },
      { x: 0, y: 220, w: 40 },
    ])
  })

  it('摆过的和没摆过的混着：没摆的接在最低点下面', () => {
    const out = layoutBlocks([
      { layout: { x: 10, y: 50, w: 30 }, height: 100 },
      { height: 60 },
    ])
    expect(out[0]).toEqual({ x: 10, y: 50, w: 30 })
    expect(out[1]).toEqual({ x: 0, y: 150, w: 100 })
  })

  it('左右并排的两块可以共用同一段纵向空间（不再被挤到下一行）', () => {
    const out = layoutBlocks([
      { layout: { x: 0, y: 0, w: 34 }, height: 300 },
      { layout: { x: 34, y: 0, w: 27 }, height: 160 },
      { layout: { x: 61, y: 0, w: 39 }, height: 420 },
    ])
    expect(out.map((p) => p.y)).toEqual([0, 0, 0])
  })

  it('删除一块后，自动堆放的块会收拢（不留空洞）', () => {
    const before = layoutBlocks([{ height: 100 }, { height: 80 }, { height: 60 }])
    expect(before[2]?.y).toBe(100 + GAP + 80 + GAP)
    // 删掉中间那块
    const after = layoutBlocks([{ height: 100 }, { height: 60 }])
    expect(after[1]?.y).toBe(100 + GAP)
  })
})

describe('canvasHeight / nextSlot', () => {
  it('画布高度按最低的块算，再多留一截', () => {
    const h = canvasHeight(
      [
        { x: 0, y: 0, w: 50 },
        { x: 50, y: 40, w: 50 },
      ],
      [200, 300],
      100,
    )
    expect(h).toBe(40 + 300 + 100)
  })

  it('新块落在所有块下面', () => {
    const slot = nextSlot([
      { layout: { x: 0, y: 0, w: 100 }, height: 120 },
      { layout: { x: 0, y: 200, w: 50 }, height: 90 },
    ])
    expect(slot).toEqual({ x: 0, y: 200 + 90 + GAP, w: 100 })
  })
})

describe('moveBy / resizeTo', () => {
  it('拖动按位移走，仍然夹住范围', () => {
    expect(moveBy({ x: 20, y: 100, w: 40 }, 10, -30)).toEqual({ x: 30, y: 70, w: 40 })
    expect(moveBy({ x: 0, y: 0, w: 40 }, -50, -10)).toEqual({ x: 0, y: 0, w: 40 })
  })

  it('改宽度不影响位置，也不越界', () => {
    expect(resizeTo({ x: 60, y: 20, w: 30 }, 50)).toEqual({ x: 50, y: 20, w: 50 })
    expect(resizeTo({ x: 0, y: 0, w: 30 }, 5).w).toBe(MIN_W)
  })
})