/*
 * 自由排版。
 *
 * 画布是**左右有界、上下无界的白板**：每块自己记着"我落在哪、多宽"，不去挤别人。
 * 这是 Freeform / Milanote 那一类模型，不是文档流，也不是栅格。
 *
 * 坐标约定：
 *   x  0..100  左边缘在画布宽度里的百分比（窗口变宽时跟着走，跑不出界）
 *   y  像素    距画布顶部。用像素是因为"上下无界"——内容长高就往下长
 *   w  15..100 宽度占画布宽度的百分比
 *
 * 没记过位置的块（新建的、老文件的）**按文档顺序往下堆**，各占整行 ——
 * 这样打开旧笔记不会所有块叠在左上角，而且"在某块下面插入"依然是接在它下面。
 */

export type Placement = { x: number; y: number; w: number }

/** 最窄不能少于这么宽，否则放不下正文 */
export const MIN_W = 15
/** 自动堆放时块之间的缝 */
export const GAP = 14

function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0
}

/** 夹进合法范围：不出画布、不太窄、不为负 */
export function clampPlacement(p: Placement): Placement {
  const w = Math.min(100, Math.max(MIN_W, round1(p.w)))
  const x = Math.min(100 - w, Math.max(0, round1(p.x)))
  const y = Math.max(0, Math.round(p.y))
  return { x, y, w }
}

export type LayoutItem = {
  /** 存过的位置；undefined = 还没摆过 */
  layout?: Placement
  /** 量出来的高度 */
  height: number
}

/**
 * 每块最终落在哪。
 * 摆过的用摆过的；没摆过的排在"当前最低点"下面，整行宽。
 */
export function layoutBlocks(items: LayoutItem[], gap = GAP): Placement[] {
  const out: Placement[] = []
  let bottom = 0

  for (const it of items) {
    if (it.layout) {
      const p = clampPlacement(it.layout)
      out.push(p)
      bottom = Math.max(bottom, p.y + it.height)
      continue
    }

    const p: Placement = { x: 0, y: bottom, w: 100 }
    out.push(p)
    bottom = p.y + it.height + gap
  }

  return out
}

/** 画布要留多高才装得下所有块（底部再留点空白，方便继续往下拖） */
export function canvasHeight(placements: Placement[], heights: number[], pad = 140): number {
  let max = 0
  placements.forEach((p, i) => {
    max = Math.max(max, p.y + (heights[i] ?? 0))
  })
  return Math.ceil(max + pad)
}

/** 拖动：像素位移 → 新位置（dxPct 是换算好的百分比） */
export function moveBy(p: Placement, dxPct: number, dyPx: number): Placement {
  return clampPlacement({ x: p.x + dxPct, y: p.y + dyPx, w: p.w })
}

/** 拖右边缘改宽度 */
export function resizeTo(p: Placement, wPct: number): Placement {
  return clampPlacement({ x: p.x, y: p.y, w: wPct })
}

/** 新块该放哪：所有块的最底部之下 */
export function nextSlot(items: LayoutItem[], gap = GAP): Placement {
  const placements = layoutBlocks(items, gap)
  let bottom = 0
  placements.forEach((p, i) => {
    bottom = Math.max(bottom, p.y + (items[i]?.height ?? 0))
  })
  return { x: 0, y: bottom + gap, w: 100 }
}