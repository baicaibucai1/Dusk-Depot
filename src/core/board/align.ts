/*
 * 画布上的**对齐参考线**与**吸附**。
 *
 * 拖一块（或一整个选区）时，把它的左边 / 中线 / 右边，跟画面里其它每一块的三条线
 * 各比一遍：最近的那一对落在容差内就吸过去，并给出一条参考线。
 *
 * 为什么单独一层：吸不吸、吸到哪、线从哪儿画到哪儿，全是可测的算术，
 * 跟 React 和 DOM 无关。画布那层只负责把算出来的结果画出来。
 *
 * 三条规矩：
 *   ① **只在容差内吸**。手一松线就没了 —— 参考线是"顺手扶一下"，不是轨道。
 *   ② **x 和 y 各选一条**。两个方向各自找最近的，互不影响（斜着也能对齐）。
 *   ③ **吸附量对外只暴露 dx / dy**：调用方拿偏移去改坐标，不用关心是怎么算的。
 */

export type Box = { x: number; y: number; w: number; h: number }

/** 一条参考线：`axis: 'x'` 是竖线（x = at），`axis: 'y'` 是横线（y = at） */
export type Guide = {
  axis: 'x' | 'y'
  at: number
  /** 线的一端（另一根轴上的坐标） */
  from: number
  /** 线的另一端 */
  to: number
  /** 边贴边，还是中线对中线（画法不同：中线更淡一点） */
  kind: 'edge' | 'center'
}

export type Snap = { dx: number; dy: number; guides: Guide[] }

/** 认为"就是同一条线"的误差。坐标都是整数，0.5 足够 */
const EPS = 0.5

type Line = { v: number; kind: 'edge' | 'center' }

/** 一块在某个轴上的三条线：起边、中线、止边 */
function linesOf(b: Box, axis: 'x' | 'y'): Line[] {
  if (axis === 'x') {
    return [
      { v: b.x, kind: 'edge' },
      { v: b.x + b.w / 2, kind: 'center' },
      { v: b.x + b.w, kind: 'edge' },
    ]
  }
  return [
    { v: b.y, kind: 'edge' },
    { v: b.y + b.h / 2, kind: 'center' },
    { v: b.y + b.h, kind: 'edge' },
  ]
}

/** 一块在"另一根轴"上占的范围 —— 参考线要够长，得把两边的块都串起来 */
function spanOf(b: Box, axis: 'x' | 'y'): [number, number] {
  return axis === 'x' ? [b.y, b.y + b.h] : [b.x, b.x + b.w]
}

/**
 * 找一个方向上最近的一对线。
 *
 * 距离一样近时**先到先得**（块按 order 排），所以"贴着上一块摆"这种常见动作
 * 会稳定地吸到上一块，而不是每次都换一个目标，看着像是线在自己跳。
 */
function nearest(
  moving: Box,
  others: Box[],
  axis: 'x' | 'y',
  tol: number,
): { delta: number; at: number } | null {
  const mine = linesOf(moving, axis)
  let best: { delta: number; at: number } | null = null
  for (const o of others) {
    for (const b of linesOf(o, axis)) {
      for (const a of mine) {
        const delta = b.v - a.v
        if (Math.abs(delta) > tol) continue
        if (!best || Math.abs(delta) < Math.abs(best.delta) - EPS) best = { delta, at: b.v }
      }
    }
  }
  return best
}

/** 吸附之后，把"真的对上了"的块串成一条线。没对上（只是被拽过去）就不画 */
function guidesAt(snapped: Box, others: Box[], axis: 'x' | 'y', at: number): Guide | null {
  let [from, to] = spanOf(snapped, axis)
  let hit = false
  let allCenter = true
  for (const o of others) {
    const m = linesOf(o, axis).find((l) => Math.abs(l.v - at) < EPS)
    if (!m) continue
    hit = true
    if (m.kind !== 'center') allCenter = false
    const [a, b] = spanOf(o, axis)
    from = Math.min(from, a)
    to = Math.max(to, b)
  }
  if (!hit) return null
  return { axis, at, from, to, kind: allCenter ? 'center' : 'edge' }
}

/**
 * 给正在拖的这块（`moving` = 当前的、没吸附的矩形）算吸附。
 *
 * `others` 要**排除正在拖的那些块自己** —— 否则它会吸到自己的旧位置，怎么拖都弹回去。
 * `tol` 是容差（世界坐标；调用方一般按 `6 / 缩放` 传，让手感在屏幕上一致）。
 */
export function snapBox(moving: Box, others: Box[], tol = 6): Snap {
  if (!(tol > 0) || others.length === 0) return { dx: 0, dy: 0, guides: [] }

  const bx = nearest(moving, others, 'x', tol)
  const by = nearest(moving, others, 'y', tol)
  const dx = bx?.delta ?? 0
  const dy = by?.delta ?? 0
  const snapped: Box = { ...moving, x: moving.x + dx, y: moving.y + dy }

  const guides: Guide[] = []
  const gx = bx ? guidesAt(snapped, others, 'x', bx.at) : null
  if (gx) guides.push(gx)
  const gy = by ? guidesAt(snapped, others, 'y', by.at) : null
  if (gy) guides.push(gy)
  return { dx, dy, guides }
}

/** 一组块的包围盒（多选整体拖动时，拿它去跟别的块对齐） */
export function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
