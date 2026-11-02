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
import { Copy, Link2, Minus, Plus, Trash2 } from 'lucide-react'
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
  type BoardBlock,
  type BoardBlockType,
  type BoardFileDoc,
  type Pos,
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
  /** 哪些块还在等图片/文件读完（不影响布局，只影响卡片内容） */
  onSelect: (id: string | null) => void
  onSelectLink: (id: string | null) => void
  onMove: (id: string, pos: Pos) => void
  onChange: (id: string, patch: Partial<BoardBlock>) => void
  onMenu: (id: string, x: number, y: number) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onConnect: (id: string) => void
  /** 加一个块到世界坐标（afterId 非空时插在它后面） */
  onAdd: (at: { x: number; y: number }, type: BoardBlockType, afterId: string | null) => void
  onEditor: (id: string, ed: Editor | null) => void
  onDropFiles: (files: File[], at: { x: number; y: number }) => void
  onReferencePath: (path: string, at: { x: number; y: number }) => void
  onOpenFile: (path: string) => void
  onNotice: (text: string) => void
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

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

/** 两个框之间画一条贝塞尔：从朝向对方的那条边出发，横向出线 */
function linkPath(a: Rect, b: Rect): string {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const dx = bc.x - ac.x
  const dy = bc.y - ac.y
  // 横向距离更大：左右出线；否则上下出线
  if (Math.abs(dx) >= Math.abs(dy) * 0.8) {
    const right = dx >= 0
    const x1 = right ? a.x + a.w : a.x
    const x2 = right ? b.x : b.x + b.w
    const c = Math.max(40, Math.abs(x2 - x1) * 0.45)
    return `M${x1} ${ac.y} C ${x1 + (right ? c : -c)} ${ac.y}, ${x2 + (right ? -c : c)} ${bc.y}, ${x2} ${bc.y}`
  }
  const down = dy >= 0
  const dir = down ? 1 : -1
  const y1 = down ? a.y + a.h : a.y
  const y2 = down ? b.y : b.y + b.h
  const c = Math.max(36, Math.abs(y2 - y1) * 0.42)
  // 纵向也往一侧鼓一下：两块左右对齐时纯竖直的线看不出是"连接"，像分隔线
  const bow = (dx >= 0 ? 1 : -1) * Math.min(40, Math.max(16, Math.abs(y2 - y1) * 0.16))
  return `M${ac.x} ${y1} C ${ac.x + bow} ${y1 + dir * c}, ${bc.x + bow} ${y2 - dir * c}, ${bc.x} ${y2}`
}

export const BoardCanvas = forwardRef<CanvasApi, Props>(function BoardCanvas(props, ref) {
  const { doc, host, selected, selectedLink, focusId } = props

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<Viewport>(() => loadView(doc.boardId) ?? { x: 160, y: 120, z: 1 })
  const [size, setSize] = useState<Size>({ w: 1200, h: 800 })
  const [sizes, setSizes] = useState<Record<string, Size>>({})
  const [drag, setDrag] = useState<{ id: string; pos: Pos } | null>(null)
  const [resizing, setResizing] = useState<{ id: string; w: number } | null>(null)
  const [panning, setPanning] = useState(false)
  const [spaceDown, setSpaceDown] = useState(false)
  const [hoverLink, setHoverLink] = useState<string | null>(null)
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

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const box = viewportRef.current?.getBoundingClientRect()
      if (!box) return { x: 0, y: 0 }
      return { x: (clientX - box.left - view.x) / view.z, y: (clientY - box.top - view.y) / view.z }
    },
    [view],
  )

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

  return (
    <div className="relative h-full min-h-0 flex-1 overflow-hidden bg-paper">
      <div
        ref={viewportRef}
        data-dd-board-scroll
        data-dd-board-canvas
        className={[
          'absolute inset-0 touch-none',
          spaceDown ? (panning ? 'cursor-grabbing' : 'cursor-grab') : panning ? 'cursor-grabbing' : 'cursor-default',
        ].join(' ')}
        style={{
          backgroundImage:
            'radial-gradient(circle, color-mix(in srgb, var(--color-ink-3) 38%, transparent) 1px, transparent 1px)',
          backgroundSize: `${step}px ${step}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
        onPointerDown={(e) => {
          const el = e.target as HTMLElement
          if (el.closest('[data-dd-card]') || el.closest('[data-dd-canvas-ui]')) return
          props.onSelect(null)
          props.onSelectLink(null)
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
              const d = linkPath(a, b)
              const mid = midpointOf(a, b)
              return (
                <g key={l.id} data-dd-board-link={l.id}>
                  {/* 宽的透明命中区：细线也要点得中 */}
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    className="pointer-events-auto cursor-pointer"
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      props.onSelect(null)
                      props.onSelectLink(l.id)
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
                  />
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
                focusId={focusId}
                dragging={drag?.id === id}
                resizing={resizing?.id === id}
                onSelect={props.onSelect}
                onBeginDrag={beginDrag}
                onBeginResize={beginResize}
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
        </div>

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
                双击空白处就能写字；元素可以摆在任意位置，滚轮平移、Ctrl+滚轮缩放。
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
  focusId: string | null
  dragging: boolean
  resizing: boolean
  onSelect: (id: string) => void
  onBeginDrag: (e: React.PointerEvent, id: string) => void
  onBeginResize: (e: React.PointerEvent, id: string) => void
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
  const { block, pos, selected, dragging, resizing } = props
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
      className={[
        'group absolute',
        dragging ? 'z-30 cursor-grabbing' : 'cursor-default',
        'rounded-xl',
        bare ? '' : 'bg-surface',
        selected
          ? 'ring-2 ring-green/45'
          : bare
            ? 'hover:ring-1 hover:ring-line'
            : 'ring-1 ring-line/70 hover:ring-line',
        // 没有底色的块（标题）不加投影 —— 影子会透过透明背景糊在纸面上，看着像脏了
        bare
          ? ''
          : dragging || selected
            ? 'shadow-[0_12px_32px_rgba(16,35,28,0.16)]'
            : 'shadow-[0_1px_2px_rgba(16,35,28,0.05)]',
      ].join(' ')}
      style={{ left: pos.x, top: pos.y, width: pos.w ?? 320 }}
      onPointerDown={(e) => {
        const el = e.target as HTMLElement
        // 编辑器 / 按钮 / 输入框自己处理，别把点击变成拖动
        if (el.closest('.ProseMirror, input, button, a, [contenteditable="true"], [data-dd-no-drag]')) {
          props.onSelect(block.id)
          return
        }
        props.onBeginDrag(e, block.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        props.onMenu(block.id, e.clientX, e.clientY)
      }}
    >
      <div className={bare ? 'px-2 py-1' : 'px-4 py-3'}>
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

      {/* 拖动条：悬停时卡片顶上浮出一条小握把。正文里按住拖仍然是选字，互不打架 */}
      <span
        aria-hidden
        data-dd-no-drag
        data-dd-card-grip
        title="按住拖动这块"
        className="absolute -top-1.5 left-1/2 h-2 w-11 -translate-x-1/2 cursor-grab rounded-full bg-ink-3/30 opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
        onPointerDown={(e) => props.onBeginDrag(e, block.id)}
      />

      {/* 调宽：只改宽度，高度跟着内容走 */}
      <span
        aria-hidden
        data-dd-no-drag
        title="拖动调整宽度"
        className={[
          'absolute top-1/2 -right-1 h-10 w-2 -translate-y-1/2 cursor-ew-resize rounded-full transition-colors',
          resizing ? 'bg-green/60' : 'bg-transparent group-hover:bg-line',
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
