import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Minus, Plus, Scan } from 'lucide-react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Host } from '../../core/ports/host'
import { nameOf } from '../../core/model/path'

/*
 * PDF 预览（只读，可选文本）。
 *
 * 用 pdf.js：本地渲染，不上传、不依赖任何远端服务。
 * 四件必须做对的事：
 *   ① **按需加载** —— pdfjs 本体和 worker 都是动态 import，没打开 PDF 就不下载；
 *   ② **连续多页** —— 所有页纵向排开，只渲染视口附近那几页；离开视野就释放画布
 *      （几百页全留着像素缓冲会吃掉几百 MB）；
 *   ③ **能缩放** —— 滑块 / 加减 / 适合宽度 / 100%，缩放时滚动位置钉在当前页；
 *   ④ **及时释放** —— 换页取消上一个渲染任务，卸载 / 换文件 destroy 文档
 *      （文档里挂着 worker，不销毁就是一条不回收的线程）。
 */

type Props = {
  host: Host
  path: string
}

type Zoom = number | 'fit'

const ZOOM_MIN = 0.4
const ZOOM_MAX = 3
const ZOOM_STEP = 0.05

/** 页与页之间的间距 + 上下留白，算"适合宽度"时要扣掉 */
const GUTTER = 56

type PageSize = { w: number; h: number }

export function PdfViewer({ host, path }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pages, setPages] = useState(0)
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [pageNo, setPageNo] = useState(1)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState(0)
  /** 视口附近要渲染的页（0-based） */
  const [live, setLive] = useState<Set<number>>(new Set())

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef<(HTMLDivElement | null)[]>([])
  /** 容器宽度：'fit' 要靠它算缩放 */
  const [boxW, setBoxW] = useState(0)

  const seq = useRef(0)

  // 容器宽度变化（窗口缩放 / 右栏收放 / 分栏）要重新按宽度排版
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth))
    ro.observe(el)
    setBoxW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // 读字节 → 打开文档。换文件时把上一份文档彻底销毁
  useEffect(() => {
    const me = ++seq.current
    /** pdf.js v6：释放要调 loadingTask.destroy()（文档代理本身没有 destroy） */
    let liveTask: { destroy: () => Promise<void> } | null = null
    let dead = false

    setLoading(true)
    setError(null)
    setDoc(null)
    setPages(0)
    setSizes([])
    setPageNo(1)
    setLive(new Set())
    setZoom('fit')
    pageRefs.current = []

    void (async () => {
      try {
        // 动态 import：不打开 PDF 就不会下载解析器
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

        const bytes = await host.read(path)
        if (dead || seq.current !== me) return

        const task = pdfjs.getDocument({ data: bytes })
        liveTask = task
        const loaded = await task.promise
        if (dead || seq.current !== me) {
          void task.destroy()
          return
        }

        const total = loaded.numPages
        const first = await loaded.getPage(1)
        const base = first.getViewport({ scale: 1 })

        // 先用第 1 页的尺寸给所有页占位，滚动条长度立刻就对
        const dims: PageSize[] = Array.from({ length: total }, () => ({ w: base.width, h: base.height }))
        dims[0] = { w: base.width, h: base.height }

        setDoc(loaded)
        setPages(total)
        setSizes(dims)
        setSize(bytes.byteLength)
        setLoading(false)

        // 再在后台补齐每页真实尺寸（横向页 / 混排的 PDF 也能排对）
        void (async () => {
          const next = dims.slice()
          for (let i = 2; i <= total; i++) {
            if (dead || seq.current !== me) return
            try {
              const p = await loaded.getPage(i)
              const vp = p.getViewport({ scale: 1 })
              next[i - 1] = { w: vp.width, h: vp.height }
            } catch {
              /* 单页读不出来就保留占位尺寸，不影响别的页 */
            }
            if (i % 8 === 0) {
              if (dead || seq.current !== me) return
              setSizes(next.slice())
            }
          }
          if (!dead && seq.current === me) setSizes(next.slice())
        })()
      } catch (e) {
        if (dead || seq.current !== me) return
        setError(e instanceof Error ? e.message : '这个 PDF 打不开')
        setLoading(false)
      }
    })()

    return () => {
      dead = true
      // 文档里挂着 worker：不销毁就是一条不回收的线程和一堆页面对象
      if (liveTask) void liveTask.destroy()
    }
  }, [host, path])

  /* 哪些页在视口附近。上下各预取 800px，滚动时不会看到空白 */
  useEffect(() => {
    const root = scrollRef.current
    if (!root || !doc || pages === 0) return
    if (typeof IntersectionObserver === 'undefined') {
      setLive(new Set(Array.from({ length: pages }, (_, i) => i)))
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        setLive((prev) => {
          let changed = false
          const next = new Set(prev)
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.pageIndex)
            if (Number.isNaN(i)) continue
            if (e.isIntersecting && !next.has(i)) {
              next.add(i)
              changed = true
            } else if (!e.isIntersecting && next.delete(i)) {
              changed = true
            }
          }
          return changed ? next : prev
        })
      },
      { root, rootMargin: '800px 0px' },
    )
    for (const el of pageRefs.current) if (el) io.observe(el)
    return () => io.disconnect()
  }, [doc, pages, sizes.length])

  /* 滚动时更新"第几页"，并把当前页滚回视口顶部时用得上 */
  useEffect(() => {
    const root = scrollRef.current
    if (!root || pages === 0) return
    let ticking = false
    const measure = () => {
      ticking = false
      const anchor = root.clientHeight * 0.4
      let cur = 1
      const top = root.getBoundingClientRect().top
      for (let i = 0; i < pages; i++) {
        const el = pageRefs.current[i]
        if (!el) continue
        const rel = el.getBoundingClientRect().top - top
        if (rel <= anchor) cur = i + 1
        else break
      }
      setPageNo((prev) => (prev === cur ? prev : cur))
    }
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(measure)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    measure()
    return () => root.removeEventListener('scroll', onScroll)
  }, [pages, sizes.length])

  /* 缩放后把当前页钉在原来的位置，别让人从头找 */
  const lastScale = useRef(0)
  const scaleNow = scaleFor(zoom, sizes, boxW)

  useEffect(() => {
    if (lastScale.current === 0) {
      lastScale.current = scaleNow
      return
    }
    if (lastScale.current === scaleNow) return
    lastScale.current = scaleNow
    const el = pageRefs.current[pageNo - 1]
    if (el) el.scrollIntoView({ block: 'start' })
    // pageNo 故意不进依赖：只有缩放变化时才需要重新钉位置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleNow])

  const clamp = (n: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 100) / 100))
  const fit = zoom === 'fit'
  const pct = Math.round(scaleNow * 100)

  const jump = (n: number) => {
    const target = Math.min(pages, Math.max(1, n))
    setPageNo(target)
    pageRefs.current[target - 1]?.scrollIntoView({ block: 'start' })
  }

  const onSlider = (v: number) => setZoom(clamp(v / 100))
  const step = (dir: 1 | -1) => setZoom(clamp(scaleNow + dir * 0.15))

  return (
    <div data-dd-pdf className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink" title={path}>
          {nameOf(path)}
        </span>
        <span className="hidden shrink-0 text-[11px] text-ink-3 sm:inline">
          PDF{pages > 0 ? ` · ${pages} 页` : ''}
          {size > 0 ? ` · ${Math.max(1, Math.round(size / 1024))} KB` : ''}
        </span>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => jump(pageNo - 1)}
            disabled={pageNo <= 1}
            title="上一页"
            aria-label="上一页"
            className="grid size-6 place-items-center rounded text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-35"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-14 text-center font-mono text-[11px] tabular-nums text-ink-2">
            {pages > 0 ? `${pageNo} / ${pages}` : '— / —'}
          </span>
          <button
            type="button"
            onClick={() => jump(pageNo + 1)}
            disabled={pages === 0 || pageNo >= pages}
            title="下一页"
            aria-label="下一页"
            className="grid size-6 place-items-center rounded text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-35"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>

        <div className="ml-1 flex shrink-0 items-center gap-1 rounded-md bg-surface-2 px-1 py-0.5">
          <button
            type="button"
            onClick={() => step(-1)}
            title="缩小"
            aria-label="缩小"
            className="grid size-6 place-items-center rounded text-ink-2 transition-colors hover:bg-surface hover:text-ink"
          >
            <Minus className="size-3.5" />
          </button>

          {/* 滑动条缩放：拖动直接改倍率；右侧百分比点一下回到"适合宽度" */}
          <input
            type="range"
            min={ZOOM_MIN * 100}
            max={ZOOM_MAX * 100}
            step={ZOOM_STEP * 100}
            value={pct}
            onChange={(e) => onSlider(Number(e.target.value))}
            aria-label="缩放"
            className="dd-range w-[84px]"
            style={{
              background: `linear-gradient(to right, var(--color-green) 0%, var(--color-green) ${
                ((pct - ZOOM_MIN * 100) / ((ZOOM_MAX - ZOOM_MIN) * 100)) * 100
              }%, var(--color-line) ${
                ((pct - ZOOM_MIN * 100) / ((ZOOM_MAX - ZOOM_MIN) * 100)) * 100
              }%, var(--color-line) 100%)`,
            }}
          />

          <button
            type="button"
            onClick={() => step(1)}
            title="放大"
            aria-label="放大"
            className="grid size-6 place-items-center rounded text-ink-2 transition-colors hover:bg-surface hover:text-ink"
          >
            <Plus className="size-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setZoom('fit')}
            title="适合宽度"
            aria-label="适合宽度"
            className={[
              'grid h-6 min-w-11 place-items-center rounded px-1 font-mono text-[11px] tabular-nums transition-colors',
              fit ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(16,35,28,0.1)]' : 'text-ink-2 hover:bg-surface',
            ].join(' ')}
          >
            {fit ? '适合' : `${pct}%`}
          </button>

          <button
            type="button"
            onClick={() => setZoom(1)}
            title="实际大小（100%）"
            aria-label="实际大小"
            className="grid size-6 place-items-center rounded text-ink-2 transition-colors hover:bg-surface hover:text-ink"
          >
            <Scan className="size-3.5" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto bg-surface-2/30">
        {loading ? (
          <p className="absolute inset-0 grid place-items-center text-[12.5px] text-ink-3">正在解析 PDF…</p>
        ) : error ? (
          <div className="absolute inset-0 grid place-items-center px-8">
            <div className="max-w-[26rem] text-center">
              <p className="text-[13px] text-ink">这个 PDF 打不开。</p>
              <p className="mt-1.5 break-all font-mono text-[11.5px] leading-relaxed text-ink-3">{error}</p>
              <p className="mt-2 text-[11.5px] text-ink-3">{path}</p>
            </div>
          </div>
        ) : pages === 0 ? (
          <p className="absolute inset-0 grid place-items-center text-[12.5px] text-ink-3">这份 PDF 里没有页面。</p>
        ) : doc ? (
          <div className="mx-auto w-max min-w-full px-6 pt-5 pb-10">
            {Array.from({ length: pages }, (_, i) => {
              const s = sizes[i] ?? sizes[0]
              if (!s) return null
              return (
                <div
                  key={i}
                  ref={(el) => {
                    pageRefs.current[i] = el
                  }}
                  data-page-index={i}
                  data-page-no={i + 1}
                  className="mx-auto mb-5 w-fit"
                >
                  <PdfPage doc={doc} index={i} width={s.w} height={s.h} scale={scaleNow} active={live.has(i)} />
                  <div className="pt-1.5 text-center font-mono text-[10.5px] tabular-nums text-ink-3">{i + 1}</div>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 当前倍率：'fit' 按第 1 页宽度算（多页混排时不会因为某页更宽而抖） */
function scaleFor(zoom: Zoom, sizes: PageSize[], boxW: number): number {
  if (zoom !== 'fit') return zoom
  const base = sizes[0]?.w ?? 0
  if (!base || boxW <= 0) return 1
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (boxW - GUTTER) / base))
}

/*
 * 一页。
 *
 * 画布可见才渲染；离开视野就把像素缓冲清掉（`canvas.width = 0`），
 * 只留外层那个白底占位框 —— 这样几百页的 PDF 也滚得动。
 */
function PdfPage({
  doc,
  index,
  width,
  height,
  scale,
  active,
}: {
  doc: PDFDocumentProxy
  index: number
  width: number
  height: number
  scale: number
  active: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textRef = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState(false)
  /** 已经按哪个倍率渲染过 —— 重复渲染既慢又会闪 */
  const done = useRef(0)

  const boxW = Math.max(1, Math.floor(width * scale))
  const boxH = Math.max(1, Math.floor(height * scale))

  useEffect(() => {
    const canvas = canvasRef.current
    const textBox = textRef.current
    if (!canvas || !textBox) return

    if (!active) {
      if (canvas.width || canvas.height) {
        canvas.width = 0
        canvas.height = 0
        canvas.style.width = '0px'
        canvas.style.height = '0px'
      }
      textBox.replaceChildren()
      done.current = 0
      return
    }

    if (done.current === scale) return

    let dead = false
    let task: RenderTask | null = null
    let layer: { cancel: () => void } | null = null

    void (async () => {
      try {
        const page = await doc.getPage(index + 1)
        if (dead) return

        const logical = page.getViewport({ scale })
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        const hi = page.getViewport({ scale: scale * dpr })

        canvas.width = Math.max(1, Math.floor(hi.width))
        canvas.height = Math.max(1, Math.floor(hi.height))
        canvas.style.width = `${Math.floor(logical.width)}px`
        canvas.style.height = `${Math.floor(logical.height)}px`

        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('这个环境拿不到 canvas 2d 上下文')
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        task = page.render({ canvas, viewport: hi, intent: 'display' })
        await task.promise
        if (dead) return

        textBox.replaceChildren()
        // pdf.js 的文本层靠这个变量换算字号，也靠它算容器宽度
        textBox.style.setProperty('--total-scale-factor', String(scale))

        const pdfjs = await import('pdfjs-dist')
        if (dead) return
        const l = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textBox,
          viewport: logical,
        })
        layer = l
        /*
         * ⚠️ TextLayer 的构造函数会把容器的 width/height 改成
         *   `round(down, var(--total-scale-factor) * 页宽, var(--scale-round-x))`
         * 这是个 CSS 函数，`--scale-round-x` 没定义时整条声明无效 → 尺寸退化成
         *   "跟随父级"。
         * 而 span 的位置是**百分比**（left/top 百分比），父级高度一变（比如后台补齐
         * 了每页真实尺寸），整层文字就被拉伸，与 canvas 错位 —— 越往下偏得越多，
         * 选中时高亮就和字对不上。
         *
         * 所以这里在构造之后**用 px 覆盖回去**，把文本层的尺寸钉死成和 canvas 一致。
         */
        textBox.style.width = `${Math.floor(logical.width)}px`
        textBox.style.height = `${Math.floor(logical.height)}px`
        await l.render()
        if (dead) return

        done.current = scale
        setFailed(false)
      } catch (e) {
        if (dead) return
        const name = e instanceof Error ? e.name : ''
        // 换页/换缩放时被主动取消，不算错误
        if (name === 'RenderingCancelledException' || name === 'AbortException') return
        // 记下这次倍率，别在同一页上无限重试
        done.current = scale
        setFailed(true)
      }
    })()

    return () => {
      dead = true
      task?.cancel()
      layer?.cancel()
    }
  }, [doc, index, scale, active])

  return (
    <div className="w-fit">
      <div
        className="relative mx-auto overflow-hidden rounded-md bg-white shadow-[0_1px_4px_rgba(16,35,28,0.14)]"
        style={{ width: boxW, height: boxH }}
      >
        <canvas ref={canvasRef} className="block" />
        {/* 透明文本层：选中文字靠它，样式见 styles.css 的 .dd-pdf-text */}
        <div ref={textRef} className="dd-pdf-text" data-dd-pdf-text />
      </div>
      {failed ? (
        <p className="mt-1 max-w-[22rem] text-center text-[10.5px] text-[#b3261e]">第 {index + 1} 页渲染失败</p>
      ) : null}
    </div>
  )
}
