/*
 * `.board` 的**无限画布**。
 *
 * 和 `.note` 的纵向块画布不是一回事：
 *   · `.note` 是文档 —— 块按顺序竖着排，顺序就是阅读顺序；
 *   · `.board` 是空间 —— 每块有自己的坐标，用户想放哪儿放哪儿，画布能平移缩放。
 *
 * ## 这一层只管"看和摆"
 *
 * 文档（块、连接、保存、撤销）都在 BoardEditor 里；这里只负责：
 *   ① 视口：平移（拖空白 / 空格 / 中键）、缩放（Ctrl+滚轮 / 按钮 / 适合内容）；
 *   ② 把每块按 `layout.pos` 绝对定位，拖动改坐标、拖右边缘改宽度；
 *   ③ 连接画成贝塞尔曲线（世界坐标，随画布一起缩放）；
 *   ④ 点阵背景 —— 缩放时跟着变密变疏，"无限空间"得看得见。
 *
 * ## 三条手感规矩
 *
 *   ① **拖动只改坐标**，不改顺序、不改内容；松手才落一次盘（拖动过程中不写历史）。
 *   ② **工具条不跟着缩放**：它是屏幕空间的，缩到 50% 时按钮还是按钮的大小。
 *   ③ 在块里打字、点按钮，都不会误触发拖动（只从卡片空白处和边开始拖）。
 */
import type { Editor } from '@tiptap/core'
import { ArrowLeftRight, Copy, Link2, Minus, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  type AnchorSide,
  type BoardBlock,
  type BoardBlockType,
  type BoardFileDoc,
  type Pos,
  ANCHOR_SIDES,
  LINK_TYPES,
  defaultWidth,
  layoutOf,
} from '../../core/board/file'
import type { Host } from '../../core/ports/host'
import { BoardBlockBody } from './BoardBlockCard'

export type Viewport = { x: number; y: number; z: number }
type Size = { w: number; h: number }
type Rect = { x: number; y: number; w: number; h: number }

const MIN_Z = 0.25
const MAX_Z = 2.5
const FIT_PAD = 80
/** 新块离已有块的最小间距（找空位时往外蹭的步子） */
const NUDGE = 28

export type CanvasApi = {
  /** 在视口中心加一个块 */
  addAtCenter: (type: BoardBlockType) => void
  /** 视口中心附近的一块空地（给"从菜单里加"这种没有落点的场景用） */
  nextSpot: (type: BoardBlockType) => Pos
  /** 缩放到能装下全部块 */
  fit: () => void
  setZoom: (z: number) => void
  /** 把某一块挪到视口中间（连接面板点条目时用） */
  centerOn: (id: string) => void
}

type Props = {
  doc: BoardFileDoc
  host: Host
  selected: string | null
  selectedLink: string | null
  focusId: string | null
  /** 当前"活"着的那一块（内容能点、能编辑）；null = 全都只是卡片 */
  active: string | null
  /** 正在"点谁连谁"的源块；null = 不在这个模式 */
  linkPick: string | null
  /** 哪些块还在等图片/文件读完（不影响布局，只影响卡片内容） */
  onSelect: (id: string | null) => void
  onSelectLink: (id: string | null) => void
  onActivate: (id: string | null) => void
  /** 「点谁连谁」：选目标块；null = 取消。sides 是两端该从哪条边出/入 */
  onPickTarget: (
    id: string | null,
    sides?: { from: AnchorSide; to: AnchorSide | null },
  ) => void
  onMove: (id: string, pos: Pos) => void
  onChange: (id: string, patch: Partial<BoardBlock>) => void
  onMenu: (id: string, x: number, y: number) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onConnect: (id: string) => void
  /** 从某个锚点拖到另一块松手：直接建立连接（不用再走对话框） */
  onCreateLink: (from: string, to: string, fromSide: AnchorSide, toSide: AnchorSide | null) => void
  onEditLink: (id: string) => void
  onReverseLink: (id: string) => void
  onDeleteLink: (id: string) => void
  /** 加一个块到世界坐标（afterId 非空时插在它后面） */
  onAdd: (at: { x: number; y: number }, type: BoardBlockType, afterId: string | null) => void
  onEditor: (id: string, ed: Editor | null) => void
  onDropFiles: (files: File[], at: { x: number; y: number }) => void
  onReferencePath: (path: string, at: { x: number; y: number }) => void
  onOpenFile: (path: string) => void
  onNotice: (text: string) => void
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

const LINK_LABEL = Object.fromEntries(LINK_TYPES.map((t) => [t.id, t.label])) as Record<string, string>

/**
 * 连接锚点：**浮在卡片外面**，不进卡片矩形。
 *
 * 这是刻意的：卡片内部整块都是"按住拖动"，锚点只要压到边上（哪怕只压 1px），
 * 拖卡片时就会误拉出一条线来 —— 两个手势抢同一块像素，怎么调都别扭。
 * 放到外面 6px 的空气里（12px 的圆点占 18~6px），命中区物理上不重叠，
 * 就不存在"点错了"这回事。
 */
const PORT_POS: Record<AnchorSide, string> = {
  top: 'left-1/2 -top-[18px] -translate-x-1/2',
  bottom: 'left-1/2 -bottom-[18px] -translate-x-1/2',
  left: 'top-1/2 -left-[18px] -translate-y-1/2',
  right: 'top-1/2 -right-[18px] -translate-y-1/2',
}

/**
 * 锚点到卡片边的那 6px 小竖线（/ 小横线）。
 * 没有它，圆点飘在点阵背景里就像一颗背景点，看不出它属于哪张卡。
 */
const PORT_TICK: Record<AnchorSide, string> = {
  top: "after:absolute after:top-full after:left-1/2 after:h-1.5 after:w-px after:-translate-x-1/2 after:bg-ink-3/35 after:content-['']",
  bottom:
    "after:absolute after:bottom-full after:left-1/2 after:h-1.5 after:w-px after:-translate-x-1/2 after:bg-ink-3/35 after:content-['']",
  left: "after:absolute after:left-full after:top-1/2 after:h-px after:w-1.5 after:-translate-y-1/2 after:bg-ink-3/35 after:content-['']",
  right:
    "after:absolute after:right-full after:top-1/2 after:h-px after:w-1.5 after:-translate-y-1/2 after:bg-ink-3/35 after:content-['']",
}

const SIDE_LABEL: Record<AnchorSide, string> = {
  top: '上边',
  right: '右边',
  bottom: '下边',
  left: '左边',
}

function viewKey(boardId: string) {
  return `dusk.boardview.v1:${boardId}`
}

function loadView(boardId: string): Viewport | null {
  try {
    const raw = localStorage.getItem(viewKey(boardId))
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<Viewport>
    const x = Number(v.x)
    const y = Number(v.y)
    const z = Number(v.z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    return { x, y, z: clamp(z, MIN_Z, MAX_Z) }
  } catch {
    return null
  }
}

const rectOf = (pos: Pos | undefined, size: Size | undefined): Rect | null => {
  if (!pos) return null
  return { x: pos.x, y: pos.y, w: pos.w ?? size?.w ?? 320, h: size?.h ?? 120 }
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** 一个锚点：边上的中点，加上"朝外"的单位法线（曲线从这儿垂直出线） */
type Port = { x: number; y: number; nx: number; ny: number }

const centerOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

function portOf(r: Rect, side: AnchorSide): Port {
  switch (side) {
    case 'top':
      return { x: r.x + r.w / 2, y: r.y, nx: 0, ny: -1 }
    case 'bottom':
      return { x: r.x + r.w / 2, y: r.y + r.h, nx: 0, ny: 1 }
    case 'left':
      return { x: r.x, y: r.y + r.h / 2, nx: -1, ny: 0 }
    default:
      return { x: r.x + r.w, y: r.y + r.h / 2, nx: 1, ny: 0 }
  }
}

/** 目标卡片上"朝着 from 这一点"的那条边 —— 拖线松手时用它吸附 */
function sideFacing(r: Rect, from: { x: number; y: number }): AnchorSide {
  const c = centerOf(r)
  // 按半宽/半高归一化：宽卡片上左右更容易够得着，否则总会吸到上下边
  const dx = (from.x - c.x) / (r.w / 2 + 1)
  const dy = (from.y - c.y) / (r.h / 2 + 1)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/** 没记锚边时的自动选边：横向距离更大就左右接，否则上下接 */
function autoSides(a: Rect, b: Rect): [AnchorSide, AnchorSide] {
  const ac = centerOf(a)
  const bc = centerOf(b)
  const dx = bc.x - ac.x
  const dy = bc.y - ac.y
  if (Math.abs(dx) >= Math.abs(dy) * 0.8) return dx >= 0 ? ['right', 'left'] : ['left', 'right']
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom']
}

/**
 * 两个锚点之间画一条三次贝塞尔：两端都沿着所在边的法线出/入。
 *
 * `bow` 把两个控制点往同侧推一点，用来给"上下正对着的两块"制造弧度 ——
 * 不加的话线就是一根直棍，看着像分隔线，不像连接。
 */
function curveBetween(a: Port, b: Port, bow = { x: 0, y: 0 }): string {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  const c = Math.max(28, Math.min(200, dist * 0.45))
  /*
   * 控制距离要看法线是不是"背对"对方：
   * 从卡片右边拖向左上角时，若仍按 0.45 倍距离往外推，线会先向右兜一大圈再折回来
   * （在窄画布里直接绕出视野，看着像线断了）。背对时缩短到三成，回环就只是个小弯。
   */
  const awayFromA = (b.x - a.x) * a.nx + (b.y - a.y) * a.ny < 0
  const awayFromB = (a.x - b.x) * b.nx + (a.y - b.y) * b.ny < 0
  const ca = awayFromA ? Math.max(14, c * 0.3) : c
  const cb = awayFromB ? Math.max(14, c * 0.3) : c
  return `M${a.x} ${a.y} C ${a.x + a.nx * ca + bow.x} ${a.y + a.ny * ca + bow.y}, ${b.x + b.nx * cb + bow.x} ${b.y + b.ny * cb + bow.y}, ${b.x} ${b.y}`
}

/** 两块正交对位时往一侧鼓多少（方向跟着两块的相对位置走） */
function bowFor(a: Port, b: Port): { x: number; y: number } {
  const dist = Math.hypot(b.x - a.x, b.y - a.y)
  const amt = Math.min(46, Math.max(14, dist * 0.12))
  const vertical = Math.abs(a.ny) === 1 && Math.abs(b.ny) === 1
  const horizontal = Math.abs(a.nx) === 1 && Math.abs(b.nx) === 1
  if (vertical) return { x: (b.x >= a.x ? 1 : -1) * amt, y: 0 }
  if (horizontal) return { x: 0, y: (b.y >= a.y ? 1 : -1) * amt }
  return { x: 0, y: 0 }
}

/**
 * 一条连接的路径。
 *
 * 记了锚边就照锚边画 —— 用户是从那个圆点拉出来的，线就该一直从那儿出发，而且走直线：
 * 那是他亲手点的位置，不该被"自动弧度"挪走感觉。
 * 没记（老数据 / 从菜单建的）就按两块相对位置自动选边，并加一点弧度好认。
 */
function linkPath(a: Rect, b: Rect, fromSide?: AnchorSide, toSide?: AnchorSide): string {
  const auto = autoSides(a, b)
  const sSide = fromSide ?? auto[0]
  // 起点边是显式给的，终点就不能再用 autoSides 推（它可能推回起点那侧，线会绕一圈）
  const tSide = toSide ?? (fromSide ? sideFacing(b, centerOf(a)) : auto[1])
  const s = portOf(a, sSide)
  const t = portOf(b, tSide)
  return curveBetween(s, t, fromSide || toSide ? { x: 0, y: 0 } : bowFor(s, t))
}

/** 拖线时的终点：光标没有落在卡片上，就朝光标方向收线 */
function loosePort(at: { x: number; y: number }, from: Port): Port {
  const dx = at.x - from.x
  const dy = at.y - from.y
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: at.x, y: at.y, nx: dx >= 0 ? -1 : 1, ny: 0 }
    : { x: at.x, y: at.y, nx: 0, ny: dy >= 0 ? -1 : 1 }
}

export const BoardCanvas = forwardRef<CanvasApi, Props>(function BoardCanvas(props, ref) {
  const { doc, host, selected, selectedLink, focusId, active, linkPick } = props

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<Viewport>(() => loadView(doc.boardId) ?? { x: 160, y: 120, z: 1 })
  /* 拖线的回调是在 window 上跑的，读 state 会读到旧值 —— 用 ref 拿"此刻"的视图 */
  const viewRef = useRef(view)
  viewRef.current = view
  const [size, setSize] = useState<Size>({ w: 1200, h: 800 })
  const [sizes, setSizes] = useState<Record<string, Size>>({})
  const [drag, setDrag] = useState<{ id: string; pos: Pos } | null>(null)
  const [resizing, setResizing] = useState<{ id: string; w: number } | null>(null)
  const [panning, setPanning] = useState(false)
  const [spaceDown, setSpaceDown] = useState(false)
  const [hoverLink, setHoverLink] = useState<string | null>(null)
  /** 正在从某个锚点拖出的一条线 */
  const [wire, setWire] = useState<{
    from: string
    side: AnchorSide
    at: { x: number; y: number }
    over: string | null
    overSide: AnchorSide | null
  } | null>(null)
  /** 「点谁连谁」：线头此刻跟着鼠标的位置（世界坐标） */
  const [pickAt, setPickAt] = useState<{ x: number; y: number } | null>(null)
  /** 最后一次指针位置。点完按钮鼠标还没动时，预览线要从这儿长出来，不能是空的 */
  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  const fitted = useRef<string | null>(null)

  const layout = useMemo(() => layoutOf(doc), [doc])

  const posNow = useCallback(
    (id: string): Pos => {
      if (drag?.id === id) return drag.pos
      const base = layout[id] ?? { x: 0, y: 0 }
      if (resizing?.id === id) return { ...base, w: resizing.w }
      return base
    },
    [drag, layout, resizing],
  )

  const rects = useMemo(() => {
    const out: Record<string, Rect> = {}
    for (const id of doc.layout.order) if (doc.blocks[id]) {
      const r = rectOf(posNow(id), sizes[id])
      if (r) out[id] = r
    }
    return out
  }, [doc.layout.order, doc.blocks, posNow, sizes])
  /* 指针回调里要按当前矩形算吸附点，同样不能读可能过期的闭包 */
  const rectsRef = useRef<Record<string, Rect>>(rects)
  rectsRef.current = rects
  const blocksRef = useRef(doc.blocks)
  blocksRef.current = doc.blocks

  /* ── 视口 ── */

  const zoomAt = useCallback((factor: number, sx: number, sy: number) => {
    setView((v) => {
      const z = clamp(v.z * factor, MIN_Z, MAX_Z)
      if (z === v.z) return v
      const k = z / v.z
      return { z, x: sx - (sx - v.x) * k, y: sy - (sy - v.y) * k }
    })
  }, [])

  const panBy = useCallback((dx: number, dy: number) => {
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
  }, [])

  const zoomHere = (factor: number) => zoomAt(factor, size.w / 2, size.h / 2)

  const fit = useCallback(() => {
    const all = Object.values(rects)
    if (all.length === 0) {
      setView({ x: size.w / 2, y: size.h / 2, z: 1 })
      return
    }
    const minX = Math.min(...all.map((r) => r.x))
    const minY = Math.min(...all.map((r) => r.y))
    const maxX = Math.max(...all.map((r) => r.x + r.w))
    const maxY = Math.max(...all.map((r) => r.y + r.h))
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    // 上限 100%：内容很少时"适合内容"不该把两块放大到糊在眼前
    const z = clamp(Math.min((size.w - FIT_PAD * 2) / bw, (size.h - FIT_PAD * 2) / bh), MIN_Z, 1)
    setView({
      z,
      x: (size.w - bw * z) / 2 - minX * z,
      y: (size.h - bh * z) / 2 - minY * z,
    })
  }, [rects, size])

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const box = viewportRef.current?.getBoundingClientRect()
    const v = viewRef.current
    if (!box) return { x: 0, y: 0 }
    return { x: (clientX - box.left - v.x) / v.z, y: (clientY - box.top - v.y) / v.z }
  }, [])

  /** 给新块找个不压住别人的位置：从目标点开始往右下蹭 */
  const freeSpot = useCallback(
    (at: { x: number; y: number }, w: number, h = 96): Pos => {
      let p = { x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2) }
      for (let i = 0; i < 14; i++) {
        const probe = { x: p.x, y: p.y, w, h }
        const hit = Object.values(rects).some((r) => overlaps(probe, r))
        if (!hit) return p
        p = { x: p.x + NUDGE, y: p.y + NUDGE }
      }
      return p
    },
    [rects],
  )

  useImperativeHandle(
    ref,
    () => ({
      addAtCenter: (type) => {
        const w = defaultWidth(type)
        const at = {
          x: (size.w / 2 - view.x) / view.z,
          y: (size.h / 2 - view.y) / view.z,
        }
        props.onAdd(freeSpot(at, w), type, null)
      },
      nextSpot: (type) =>
        freeSpot(
          { x: (size.w / 2 - view.x) / view.z, y: (size.h / 2 - view.y) / view.z },
          defaultWidth(type),
        ),
      fit,
      setZoom: (z) => {
        const next = clamp(z, MIN_Z, MAX_Z)
        zoomAt(next / view.z, size.w / 2, size.h / 2)
      },
      centerOn: (id) => {
        const r = rects[id]
        if (!r) return
        setView((v) => ({
          ...v,
          x: size.w / 2 - (r.x + r.w / 2) * v.z,
          y: size.h / 2 - (r.y + r.h / 2) * v.z,
        }))
      },
    }),
    [freeSpot, fit, props, rects, size, view, zoomAt],
  )

  /* 视口尺寸：适合内容、居中、点阵都要 */
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  /* 滚轮：Ctrl/⌘ + 滚 = 缩放（跟光标），否则平移 */
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {})
  wheelRef.current = (e: WheelEvent) => {
    const el = viewportRef.current
    if (!el) return
    e.preventDefault()
    const box = el.getBoundingClientRect()
    if (e.ctrlKey || e.metaKey) {
      zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - box.left, e.clientY - box.top)
      return
    }
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.height : 1
    panBy(-e.deltaX * unit, -e.deltaY * unit)
  }
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const fn = (e: WheelEvent) => wheelRef.current(e)
    el.addEventListener('wheel', fn, { passive: false })
    return () => el.removeEventListener('wheel', fn)
  }, [])

  /* 空格 = 抓手（打字时不抢键） */
  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      Boolean((t as HTMLElement | null)?.closest?.('.ProseMirror, input, textarea, [contenteditable="true"]'))
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e.target) || e.repeat) return
      setSpaceDown(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', () => setSpaceDown(false))
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  /*
   * 「点谁连谁」：工具栏的连接按钮按下后，一条线跟着鼠标，点哪块就连哪块。
   * 鼠标位置在世界坐标里记 —— 视图被平移缩放时线才会跟着地走。
   */
  const pickTargetRef = useRef(props.onPickTarget)
  pickTargetRef.current = props.onPickTarget
  useEffect(() => {
    if (!linkPick) {
      setPickAt(null)
      return
    }
    // 鼠标还停在按钮上：先从那儿拉一条线出来，别等用户先动一下才看得见
    const at = lastPointer.current
    if (at) setPickAt(toWorld(at.x, at.y))
    const move = (e: PointerEvent) => setPickAt(toWorld(e.clientX, e.clientY))
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      pickTargetRef.current(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('keydown', key)
    }
  }, [linkPick, toWorld])

  /* 视口记在本机（纯 UI 状态，不进仓库文件） */
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(viewKey(doc.boardId), JSON.stringify(view))
      } catch {
        /* 存不了就这一次生效 */
      }
    }, 300)
    return () => window.clearTimeout(t)
  }, [view, doc.boardId])

  /* 第一次打开：没存过视口、又已经有内容，就"适合内容"一次 */
  useEffect(() => {
    if (fitted.current === doc.boardId) return
    const ids = doc.layout.order.filter((id) => doc.blocks[id])
    if (ids.length === 0) {
      fitted.current = doc.boardId
      return
    }
    if (!ids.every((id) => sizes[id])) return
    fitted.current = doc.boardId
    if (!loadView(doc.boardId)) fit()
  }, [doc.boardId, doc.layout.order, doc.blocks, sizes, fit])

  /* ── 拖动 / 平移 / 调宽 ── */

  const beginPan = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    const start = { x: e.clientX, y: e.clientY }
    setPanning(true)
    document.body.style.userSelect = 'none'
    const move = (ev: PointerEvent) => {
      // ⚠️ 先把差值算出来再更新 start：setView 的函数式更新可能延后执行，
      //    若在它里面读 start，那时 start 已经被下面的赋值改掉了，位移永远是 0。
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      start.x = ev.clientX
      start.y = ev.clientY
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      setPanning(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const beginDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return
    const base = layout[id]
    if (!base) return
    e.preventDefault()
    e.stopPropagation()
    props.onSelect(id)
    const z = view.z
    const start = { x: e.clientX, y: e.clientY }
    let last = { x: base.x, y: base.y }
    let moved = false
    document.body.style.userSelect = 'none'
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return
      moved = true
      last = { x: Math.round(base.x + dx / z), y: Math.round(base.y + dy / z) }
      setDrag({ id, pos: { ...base, x: last.x, y: last.y } })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      setDrag(null)
      if (moved) props.onMove(id, { ...base, x: last.x, y: last.y })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const beginResize = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return
    const base = layout[id]
    if (!base) return
    e.preventDefault()
    e.stopPropagation()
    props.onSelect(id)
    const z = view.z
    const startX = e.clientX
    const startW = base.w ?? sizes[id]?.w ?? defaultWidth(doc.blocks[id]?.type ?? 'paragraph')
    let last = startW
    document.body.style.userSelect = 'none'
    const move = (ev: PointerEvent) => {
      last = Math.round(clamp(startW + (ev.clientX - startX) / z, 200, 760))
      setResizing({ id, w: last })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      setResizing(null)
      if (last !== startW) props.onMove(id, { ...base, w: last })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * 从卡片边上的圆点拉一条线出去。
   *
   * 松手时用 `elementFromPoint` 判"落到了哪张卡"——不是靠卡片自己的 pointerenter：
   * 拖拽期间 pointer 事件被 window 接管，子元素收不到 enter/leave。
   */
  const beginWire = (e: React.PointerEvent, id: string, side: AnchorSide) => {
    if (e.button !== 0) return
    const box = rectsRef.current[id]
    if (!box) return
    e.preventDefault()
    e.stopPropagation()
    props.onSelect(id)
    props.onSelectLink(null)
    const start = portOf(box, side)
    const press = { x: e.clientX, y: e.clientY }
    setWire({ from: id, side, at: start, over: null, overSide: null })
    document.body.style.userSelect = 'none'

    /*
     * 拖到画布边上就自己平移 —— 无限画布上要能连到视野外的那块，
     * 否则用户得先松手、平移、再重来一遍。
     */
    const edge = { x: 0, y: 0 }
    let lastClient = { x: e.clientX, y: e.clientY }
    let raf = 0
    const glide = () => {
      raf = 0
      if (!edge.x && !edge.y) return
      setView((v) => ({ ...v, x: v.x + edge.x * 11, y: v.y + edge.y * 11 }))
      // 视图动了，光标的世界坐标也跟着动（画面要跟着手）
      setWire((w) => (w ? { ...w, at: toWorld(lastClient.x, lastClient.y) } : w))
      raf = requestAnimationFrame(glide)
    }
    const trackEdge = (ev: PointerEvent) => {
      lastClient = { x: ev.clientX, y: ev.clientY }
      const vp = viewportRef.current?.getBoundingClientRect()
      if (!vp) return
      const m = 56
      edge.x = ev.clientX < vp.left + m ? 1 : ev.clientX > vp.right - m ? -1 : 0
      edge.y = ev.clientY < vp.top + m ? 1 : ev.clientY > vp.bottom - m ? -1 : 0
      if (!raf && (edge.x || edge.y)) raf = requestAnimationFrame(glide)
    }

    const hitAt = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const card = el?.closest('[data-dd-card]') as HTMLElement | null
      const hit = card?.dataset.ddCard ?? null
      if (!hit || hit === id || !blocksRef.current[hit]) return { over: null, overSide: null }
      const tr = rectsRef.current[hit]
      return { over: hit, overSide: tr ? sideFacing(tr, start) : null }
    }

    const move = (ev: PointerEvent) => {
      trackEdge(ev)
      const { over, overSide } = hitAt(ev)
      setWire({ from: id, side, at: toWorld(ev.clientX, ev.clientY), over, overSide })
    }

    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', onKey)
      document.body.style.userSelect = ''
      edge.x = 0
      edge.y = 0
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }

    const up = (ev: PointerEvent) => {
      stop()
      const { over, overSide } = hitAt(ev)
      const moved = Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 6
      setWire(null)
      if (over) {
        props.onCreateLink(id, over, side, overSide)
        return
      }
      if (moved) props.onNotice('没连上：线要拖到另一张卡片上再松手')
    }

    // 拖到一半反悔：Esc 收线，什么都不建
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      stop()
      setWire(null)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('keydown', onKey)
  }

  const reportSize = useCallback((id: string, w: number, h: number) => {
    setSizes((prev) => {
      const cur = prev[id]
      if (cur && Math.abs(cur.w - w) < 1 && Math.abs(cur.h - h) < 1) return prev
      return { ...prev, [id]: { w, h } }
    })
  }, [])

  /* ── 渲染 ── */

  const dot = 24 * view.z
  const step = dot < 14 ? dot * 2 : dot
  const selRect = selected ? rects[selected] : null
  const hoverHot = hoverLink ?? selectedLink

  /* 拖线中的预览：起点是按下那个锚点，终点吸附到目标边或跟着光标 */
  const wireFrom = wire ? rects[wire.from] : null
  const wireStart = wire && wireFrom ? portOf(wireFrom, wire.side) : null
  const wireOver = wire?.over ? rects[wire.over] : null
  const wireEnd =
    wire && wireStart
      ? wire.overSide && wireOver
        ? portOf(wireOver, wire.overSide)
        : loosePort(wire.at, wireStart)
      : null
  const wireD = wireStart && wireEnd ? curveBetween(wireStart, wireEnd) : ''

  /* 「点谁连谁」的预览线：从源块朝向鼠标的那条边出去，方便看出会连到哪一侧 */
  const pickLine = (() => {
    if (!linkPick || !pickAt) return null
    const src = rects[linkPick]
    if (!src) return null
    const from = portOf(src, sideFacing(src, pickAt))
    return { d: curveBetween(from, loosePort(pickAt, from)), from }
  })()

  /* 选中一条连接时的小工具条：贴在曲线中点上方（屏幕空间，不跟着缩放变小） */
  const selLink = selectedLink ? doc.links.find((l) => l.id === selectedLink) : null
  const linkMidOf = (l: { from: string; to: string }) => {
    const a = rects[l.from]
    const b = rects[l.to]
    return a && b ? midpointOf(a, b) : null
  }
  const selLinkMid = selLink ? linkMidOf(selLink) : null

  return (
    <div className="relative h-full min-h-0 flex-1 overflow-hidden bg-paper">
      <div
        ref={viewportRef}
        data-dd-board-scroll
        data-dd-board-canvas
        className={[
          'absolute inset-0 touch-none',
          wire || linkPick
            ? 'cursor-crosshair'
            : spaceDown
              ? panning
                ? 'cursor-grabbing'
                : 'cursor-grab'
              : panning
                ? 'cursor-grabbing'
                : 'cursor-default',
        ].join(' ')}
        style={{
          backgroundImage:
            'radial-gradient(circle, color-mix(in srgb, var(--color-ink-3) 38%, transparent) 1px, transparent 1px)',
          backgroundSize: `${step}px ${step}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerMove={(e) => {
          lastPointer.current = { x: e.clientX, y: e.clientY }
        }}
        onPointerDown={(e) => {
          // 「点谁连谁」：点空白 = 取消，别顺手开始平移
          if (linkPick) {
            props.onPickTarget(null)
            return
          }
          const el = e.target as HTMLElement
          if (el.closest('[data-dd-card]') || el.closest('[data-dd-canvas-ui]')) return
          props.onSelect(null)
          props.onSelectLink(null)
          props.onActivate(null)
          beginPan(e)
        }}
        onDoubleClick={(e) => {
          const el = e.target as HTMLElement
          if (el.closest('[data-dd-card]') || el.closest('[data-dd-canvas-ui]')) return
          const at = toWorld(e.clientX, e.clientY)
          props.onAdd(freeSpot(at, defaultWidth('paragraph')), 'paragraph', null)
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            return
          }
          if (e.dataTransfer.types.includes('text/plain')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'link'
          }
        }}
        onDrop={(e) => {
          const at = toWorld(e.clientX, e.clientY)
          if (e.dataTransfer.files.length > 0) {
            e.preventDefault()
            props.onDropFiles([...e.dataTransfer.files], at)
            return
          }
          const p = e.dataTransfer.getData('text/plain')
          if (p) {
            e.preventDefault()
            props.onReferencePath(p, at)
          }
        }}
      >
        {/* 世界层：所有块和连接都在这里面，整体平移+缩放 */}
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
        >
          <svg
            aria-hidden
            data-dd-board-links
            className="pointer-events-none absolute top-0 left-0 overflow-visible"
            width="1"
            height="1"
          >
            {doc.links.map((l) => {
              const a = rects[l.from]
              const b = rects[l.to]
              if (!a || !b) return null
              const hot = hoverHot === l.id
              const on = selectedLink === l.id
              const d = linkPath(a, b, l.fromSide, l.toSide)
              const mid = midpointOf(a, b)
              return (
                <g key={l.id} data-dd-board-link={l.id}>
                  {/* 宽的透明命中区：细线也要点得中 */}
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16}
                    className="pointer-events-auto cursor-pointer"
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      props.onSelect(null)
                      props.onSelectLink(l.id)
                    }}
                    // 端点常常压在卡片边上、被卡片盖住，所以线本身也给一条双击断开的入口
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      props.onDeleteLink(l.id)
                    }}
                    onPointerEnter={() => setHoverLink(l.id)}
                    onPointerLeave={() => setHoverLink((cur) => (cur === l.id ? null : cur))}
                  />
                  <path
                    d={d}
                    fill="none"
                    stroke={on ? 'var(--color-green)' : 'var(--color-ink-3)'}
                    strokeWidth={on || hot ? 2 : 1.4}
                    strokeOpacity={on ? 1 : hot ? 0.9 : 0.45}
                    strokeLinecap="round"
                    // 缩到 25% 时线不该细得看不见；放大到 250% 也不该粗成一条带子
                    vectorEffect="non-scaling-stroke"
                  />
                  {/*
                    两端的小圆点：既是"这条线从哪条边出去的"的可视标记，
                    也是这条连接的把手 —— 双击它就断开（比先点线再找删除按钮快）。
                    透明命中圆半径 9：视觉只有 2.6，手上得够得着。
                  */}
                  {[
                    portOf(a, l.fromSide ?? autoSides(a, b)[0]),
                    portOf(b, l.toSide ?? autoSides(a, b)[1]),
                  ].map((pt, i) => (
                    <g key={i} data-dd-link-end={l.id}>
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={9}
                        fill="transparent"
                        className="pointer-events-auto cursor-pointer"
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          props.onDeleteLink(l.id)
                        }}
                        onClick={(e) => {
                          e.stopPropagation()
                          props.onSelect(null)
                          props.onSelectLink(l.id)
                        }}
                      >
                        <title>双击断开这条连接</title>
                      </circle>
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={on || hot ? 3.4 : 2.6}
                        fill={on ? 'var(--color-green)' : 'var(--color-paper)'}
                        stroke={on ? 'var(--color-green)' : 'var(--color-ink-3)'}
                        strokeOpacity={on || hot ? 1 : 0.72}
                        strokeWidth={1.2}
                        className="pointer-events-none"
                      />
                    </g>
                  ))}
                  {l.label ? (
                    <text
                      x={mid.x}
                      y={mid.y}
                      textAnchor="middle"
                      className="pointer-events-none select-none"
                      style={{
                        fontSize: 11,
                        fill: 'var(--color-ink-2)',
                        paintOrder: 'stroke',
                        stroke: 'var(--color-paper)',
                        strokeWidth: 4,
                        strokeLinejoin: 'round',
                      }}
                    >
                      {l.label}
                    </text>
                  ) : null}
                </g>
              )
            })}
          </svg>

          {doc.layout.order.map((id) => {
            const block = doc.blocks[id]
            if (!block) return null
            const p = posNow(id)
            return (
              <CanvasCard
                key={id}
                host={host}
                block={block}
                pos={p}
                selected={selected === id}
                active={active === id}
                linkPick={Boolean(linkPick)}
                hot={wire?.over === id}
                focusId={focusId}
                dragging={drag?.id === id}
                resizing={resizing?.id === id}
                onSelect={props.onSelect}
                onActivate={(bid) => props.onActivate(bid)}
                onPickTarget={(bid) => {
                  const src = linkPick ? rects[linkPick] : null
                  const dst = rects[bid]
                  props.onPickTarget(
                    bid,
                    src && dst
                      ? {
                          from: sideFacing(src, centerOf(dst)),
                          to: sideFacing(dst, centerOf(src)),
                        }
                      : undefined,
                  )
                }}
                onBeginDrag={beginDrag}
                onBeginResize={beginResize}
                onBeginWire={beginWire}
                onChange={props.onChange}
                onMenu={props.onMenu}
                onEditor={props.onEditor}
                onSize={reportSize}
                onEnterEnd={(bid) => {
                  const r = rects[bid]
                  const at = r ? { x: r.x + 20, y: r.y + r.h + 18 } : toWorld(0, 0)
                  props.onAdd(freeSpot(at, defaultWidth('paragraph')), 'paragraph', bid)
                }}
                onBackspaceEmpty={props.onDelete}
                onOpenFile={props.onOpenFile}
                onNotice={props.onNotice}
              />
            )
          })}

          {/* 正在拖的那条线画在所有卡片之上 —— 手指压着卡片时，线不该被卡片盖住 */}
          {wire && wireStart && wireEnd ? (
            <svg
              aria-hidden
              data-dd-board-wire
              className="pointer-events-none absolute top-0 left-0 z-40 overflow-visible"
              width="1"
              height="1"
            >
              <path
                d={wireD}
                fill="none"
                stroke="var(--color-green)"
                strokeWidth={wire.over ? 2.2 : 1.6}
                strokeDasharray={wire.over ? undefined : '7 5'}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={wireStart.x} cy={wireStart.y} r={3.5} fill="var(--color-green)" />
              {/* 吸附住了就画个明显的落点环，让人知道"松手就连这里" */}
              {wire.over ? (
                <circle
                  cx={wireEnd.x}
                  cy={wireEnd.y}
                  r={7}
                  fill="var(--color-green)"
                  fillOpacity={0.16}
                  stroke="var(--color-green)"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                <circle cx={wireEnd.x} cy={wireEnd.y} r={2.5} fill="var(--color-green)" />
              )}
            </svg>
          ) : null}

          {/* 「点谁连谁」：线头跟着鼠标，点中哪块就连哪块 */}
          {pickLine ? (
            <svg
              aria-hidden
              data-dd-board-pick
              className="pointer-events-none absolute top-0 left-0 z-40 overflow-visible"
              width="1"
              height="1"
            >
              <path
                d={pickLine.d}
                fill="none"
                stroke="var(--color-green)"
                strokeWidth={1.8}
                strokeDasharray="7 5"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={pickLine.from.x} cy={pickLine.from.y} r={3.5} fill="var(--color-green)" />
            </svg>
          ) : null}
        </div>

        {/* 选中连接的小工具条：贴在曲线中点上方 */}
        {selLink && selLinkMid ? (
          <div
            data-dd-canvas-ui
            data-dd-link-toolbar
            className="absolute z-20 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-lg border border-line bg-surface px-1 py-0.5 shadow-[0_8px_24px_rgba(16,35,28,0.14)]"
            style={{
              left: view.x + selLinkMid.x * view.z,
              top: view.y + selLinkMid.y * view.z - 8,
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span className="px-1 text-[10.5px] whitespace-nowrap text-ink-3">
              {LINK_LABEL[selLink.type] ?? selLink.type}
            </span>
            <ToolBtn label="编辑这条连接" onClick={() => props.onEditLink(selLink.id)}>
              <Pencil className="size-3.5" />
            </ToolBtn>
            <ToolBtn label="反转方向" onClick={() => props.onReverseLink(selLink.id)}>
              <ArrowLeftRight className="size-3.5" />
            </ToolBtn>
            <span className="mx-0.5 h-4 w-px bg-line" />
            <ToolBtn label="删除这条连接" danger onClick={() => props.onDeleteLink(selLink.id)}>
              <Trash2 className="size-3.5" />
            </ToolBtn>
          </div>
        ) : null}

        {/* 选中块的工具条：屏幕空间，缩放不影响它的大小 */}
        {selected && selRect ? (
          <div
            data-dd-canvas-ui
            data-dd-board-toolbar
            className="absolute z-20 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-lg border border-line bg-surface px-1 py-0.5 shadow-[0_8px_24px_rgba(16,35,28,0.14)]"
            style={{
              left: view.x + (selRect.x + selRect.w / 2) * view.z,
              top: view.y + selRect.y * view.z - 8,
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <ToolBtn label="复制这个块" onClick={() => props.onDuplicate(selected)}>
              <Copy className="size-3.5" />
            </ToolBtn>
            <ToolBtn label="连接到…" onClick={() => props.onConnect(selected)}>
              <Link2 className="size-3.5" />
            </ToolBtn>
            <ToolBtn
              label="块菜单"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                props.onMenu(selected, r.left - 60, r.bottom + 4)
              }}
            >
              <span className="px-0.5 text-[13px] leading-none">⋯</span>
            </ToolBtn>
            <span className="mx-0.5 h-4 w-px bg-line" />
            <ToolBtn label="删除这个块" danger onClick={() => props.onDelete(selected)}>
              <Trash2 className="size-3.5" />
            </ToolBtn>
          </div>
        ) : null}

        {/* 缩放 */}
        <div
          data-dd-canvas-ui
          data-dd-zoom
          className="absolute right-4 bottom-4 z-20 flex items-center gap-0.5 rounded-lg border border-line bg-surface px-1 py-0.5 shadow-[0_8px_24px_rgba(16,35,28,0.12)]"
        >
          <ToolBtn label="缩小" onClick={() => zoomHere(1 / 1.2)}>
            <Minus className="size-3.5" />
          </ToolBtn>
          <button
            type="button"
            onClick={() => zoomAt(1 / view.z, size.w / 2, size.h / 2)}
            title="回到 100%"
            className="min-w-[46px] rounded px-1 text-[11px] tabular-nums text-ink-2 hover:bg-surface-2"
          >
            {Math.round(view.z * 100)}%
          </button>
          <ToolBtn label="放大" onClick={() => zoomHere(1.2)}>
            <Plus className="size-3.5" />
          </ToolBtn>
          <span className="mx-0.5 h-4 w-px bg-line" />
          <button
            type="button"
            onClick={fit}
            title="缩放到能看见全部块"
            className="rounded px-1.5 py-1 text-[11px] text-ink-2 hover:bg-surface-2"
          >
            适合内容
          </button>
        </div>

        {doc.layout.order.length === 0 ? (
          <div data-dd-canvas-ui className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="pointer-events-auto w-[360px] rounded-2xl border border-dashed border-line bg-surface/85 px-6 py-7 text-center backdrop-blur-sm">
              <p className="text-[14px] text-ink-2">这块白板还是空的</p>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
                双击空白处加一块。块可以拖到任意位置；<b className="font-medium text-ink-2">双击块</b>
                才进入编辑，滚轮平移、Ctrl+滚轮缩放。
              </p>
              <div className="mt-3 flex justify-center gap-1.5">
                {(['paragraph', 'todo', 'image'] as BoardBlockType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      const at = { x: (size.w / 2 - view.x) / view.z, y: (size.h / 2 - view.y) / view.z }
                      props.onAdd(freeSpot(at, defaultWidth(t)), t, null)
                    }}
                    className="rounded-lg border border-line px-2.5 py-1 text-[11.5px] text-ink-2 hover:border-green/40 hover:bg-green-soft hover:text-green"
                  >
                    {t === 'paragraph' ? '文字' : t === 'todo' ? '待办' : '图片'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
})

function ToolBtn({
  label,
  children,
  onClick,
  danger,
}: {
  label: string
  children: React.ReactNode
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={[
        'grid size-7 place-items-center rounded-md transition-colors',
        danger
          ? 'text-ink-3 hover:bg-[#fdf0ef] hover:text-[#8f1d17]'
          : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

type CardProps = {
  host: Host
  block: BoardBlock
  pos: Pos
  selected: boolean
  /** 处于"可交互"状态：内容能点、能编辑。默认不激活，整块只负责拖动 */
  active: boolean
  /** 画布正在"点谁连谁"模式 */
  linkPick: boolean
  /** 拖线时线头悬在这张卡上（就是松手会连上的那张） */
  hot: boolean
  focusId: string | null
  dragging: boolean
  resizing: boolean
  onSelect: (id: string) => void
  onActivate: (id: string) => void
  onPickTarget: (id: string) => void
  onBeginDrag: (e: React.PointerEvent, id: string) => void
  onBeginResize: (e: React.PointerEvent, id: string) => void
  onBeginWire: (e: React.PointerEvent, id: string, side: AnchorSide) => void
  onChange: (id: string, patch: Partial<BoardBlock>) => void
  onMenu: (id: string, x: number, y: number) => void
  onEditor: (id: string, ed: Editor | null) => void
  onSize: (id: string, w: number, h: number) => void
  onEnterEnd: (id: string) => void
  onBackspaceEmpty: (id: string) => void
  onOpenFile: (path: string) => void
  onNotice: (text: string) => void
}

function CanvasCard(props: CardProps) {
  const { block, pos, selected, hot, dragging, resizing } = props
  const ref = useRef<HTMLDivElement | null>(null)
  const { onSize } = props

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const report = () => onSize(block.id, Math.round(el.offsetWidth), Math.round(el.offsetHeight))
    const ro = new ResizeObserver(report)
    ro.observe(el)
    report()
    return () => ro.disconnect()
  }, [block.id, onSize])

  const bare = block.type === 'heading1' || block.type === 'heading2'

  return (
    <div
      ref={ref}
      data-dd-card={block.id}
      data-dd-board-block={block.id}
      data-block-type={block.type}
      data-selected={selected ? 'true' : undefined}
      data-active={props.active ? 'true' : undefined}
      className={[
        'dd-board-card group absolute rounded-xl',
        dragging
          ? 'z-30 cursor-grabbing'
          : props.active
            ? 'cursor-default'
            : props.linkPick
              ? 'cursor-crosshair'
              : 'cursor-grab',
        bare ? '' : 'bg-surface',
        hot
          ? 'ring-2 ring-green/70'
          : props.active
            ? 'ring-2 ring-green/55'
            : selected
              ? 'ring-1 ring-green/45'
              : bare
                ? 'hover:ring-1 hover:ring-line'
                : 'ring-1 ring-line/70 hover:ring-line',
        // 没有底色的块（标题）不加投影 —— 影子会透过透明背景糊在纸面上，看着像脏了
        bare
          ? ''
          : dragging || selected || props.active
            ? 'shadow-[0_12px_32px_rgba(16,35,28,0.16)]'
            : 'shadow-[0_1px_2px_rgba(16,35,28,0.05)]',
      ].join(' ')}
      style={{ left: pos.x, top: pos.y, width: pos.w ?? 320 }}
      onPointerDown={(e) => {
        // 「点谁连谁」模式：按下哪块就连哪块，不当拖动
        if (props.linkPick) {
          e.preventDefault()
          e.stopPropagation()
          props.onPickTarget(block.id)
          return
        }
        /*
         * 未激活时整块都是拖动区（内容层 pointer-events 已关掉，指针到不了里面）。
         * 激活之后内容会吃指针，这时只有按钮/编辑器之外的地方还能拖。
         */
        if (props.active) {
          const el = e.target as HTMLElement
          if (el.closest('.ProseMirror, input, button, a, [contenteditable="true"], [data-dd-no-drag]')) {
            props.onSelect(block.id)
            return
          }
        }
        props.onBeginDrag(e, block.id)
      }}
      onDoubleClick={(e) => {
        // 双击 = 让这块"活过来"；别冒泡给画布（画布的双击是新建一块）
        e.stopPropagation()
        props.onActivate(block.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        props.onMenu(block.id, e.clientX, e.clientY)
      }}
    >
      {/* 未激活时整层不接指针：这是"整块都能拖"的前提 */}
      <div
        data-dd-card-body
        className={[
          bare ? 'px-2 py-1' : 'px-4 py-3',
          props.active ? '' : 'pointer-events-none select-none',
        ].join(' ')}
      >
        <BoardBlockBody
          host={props.host}
          block={block}
          autoFocus={props.focusId === block.id}
          onChange={props.onChange}
          onEnterEnd={props.onEnterEnd}
          onBackspaceEmpty={props.onBackspaceEmpty}
          onEditor={props.onEditor}
          onOpenFile={props.onOpenFile}
          onNotice={props.onNotice}
        />
      </div>

      {/*
        四个连接锚点：浮在四边中点外侧 6px 的空中，悬停或选中时出现。
        从这里拖出去就是连线 —— 不用先选中、再点按钮、再在对话框里挑目标。
        位置在卡片**外面**，所以卡片里随便按哪儿都是拖动，不会误拉出一条线；
        拖动卡片的过程中也把锚点收起，免得手上带着四个点跑。
      */}
      {ANCHOR_SIDES.map((side) => (
        <span
          key={side}
          role="button"
          tabIndex={-1}
          aria-label={`从${SIDE_LABEL[side]}拖出连接`}
          title="拖到另一块，建立连接"
          data-dd-port={side}
          data-dd-no-drag
          onPointerDown={(e) => props.onBeginWire(e, block.id, side)}
          className={[
            'absolute z-10 size-3 cursor-crosshair rounded-full border-[1.5px] border-ink-3/70 bg-surface',
            // 纸色外圈：把圆点从点阵背景里"抠"出来，不然会跟背景点混在一起
            'ring-2 ring-paper shadow-[0_1px_3px_rgba(16,35,28,0.18)]',
            // 视觉 10px，手上 18px。别扩到贴住卡片边：那样"点边缘"又变成拉线了
            "before:absolute before:-inset-1 before:content-['']",
            PORT_TICK[side],
            'transition-[transform,opacity,background-color,border-color] duration-100',
            'hover:scale-150 hover:border-green hover:bg-green',
            PORT_POS[side],
            dragging
              ? 'pointer-events-none opacity-0'
              : selected
                ? 'opacity-100'
                : // 藏着的时候别吃指针：不然点卡片边上那圈空气会莫名拉出一条线
                  'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100',
          ].join(' ')}
        />
      ))}

      {/*
        拖动条：**激活之后**内容会吃指针，所以顶上留一条专门拖。
        未激活时它是透明的、也不接指针 —— 那时整张卡都能拖，用不着它。
      */}
      <span
        aria-hidden
        data-dd-no-drag
        data-dd-card-grip
        title="按住拖动这块"
        onPointerDown={(e) => props.onBeginDrag(e, block.id)}
        className={[
          'absolute inset-x-1 top-0 z-10 h-2.5 rounded-t-xl transition-colors',
          props.active
            ? 'cursor-grab hover:bg-line/60 active:cursor-grabbing'
            : 'pointer-events-none',
        ].join(' ')}
      />

      {/* 调宽：只改宽度，高度跟着内容走。放右下角，和右边中点的连接锚点错开 */}
      <span
        aria-hidden
        data-dd-no-drag
        title="拖动调整宽度"
        className={[
          'absolute -right-1.5 -bottom-1.5 size-3 cursor-ew-resize rounded-full border transition-colors',
          resizing
            ? 'border-green bg-green'
            : 'border-line bg-surface opacity-0 group-hover:opacity-100',
        ].join(' ')}
        onPointerDown={(e) => props.onBeginResize(e, block.id)}
      />
    </div>
  )
}

/** 连接标签的位置：两框中心的中点 */
function midpointOf(a: Rect, b: Rect) {
  return {
    x: (a.x + a.w / 2 + b.x + b.w / 2) / 2,
    y: (a.y + a.h / 2 + b.y + b.h / 2) / 2,
  }
}
