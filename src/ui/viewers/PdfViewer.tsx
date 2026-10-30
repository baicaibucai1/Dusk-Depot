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
 * 三件必须做对的事：
 *   ① **按需加载** —— pdfjs 本体和 worker 都是动态 import，没打开 PDF 就不下载；
 *   ② **及时释放** —— 换页取消上一个渲染任务，卸载 / 换文件 destroy 文档
 *      （文档里挂着 worker，不销毁就是一条不回收的线程）；
 *   ③ **快速切换不串页** —— 每次读取带序号，过期的结果直接丢。
 */

type Props = {
  host: Host
  path: string
}

type Zoom = number | 'fit'

const ZOOM_MIN = 0.4
const ZOOM_MAX = 4

export function PdfViewer({ host, path }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pages, setPages] = useState(0)
  const [pageNo, setPageNo] = useState(1)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [size, setSize] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  /** 容器宽度：'fit' 要靠它算缩放 */
  const [boxW, setBoxW] = useState(0)

  const seq = useRef(0)

  // 容器宽度变化（窗口缩放 / 右栏收放 / 分栏）要重新按宽度排版
  useEffect(() => {
    const el = stageRef.current
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
    let live: { destroy: () => Promise<void> } | null = null
    let dead = false

    setLoading(true)
    setError(null)
    setPageError(null)
    setDoc(null)
    setPages(0)
    setPageNo(1)
    setZoom('fit')

    void (async () => {
      try {
        // 动态 import：不打开 PDF 就不会下载解析器
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

        const bytes = await host.read(path)
        if (dead || seq.current !== me) return

        const task = pdfjs.getDocument({ data: bytes })
        live = task
        const loaded = await task.promise
        if (dead || seq.current !== me) {
          void task.destroy()
          return
        }
        setDoc(loaded)
        setPages(loaded.numPages)
        setSize(bytes.byteLength)
        setLoading(false)
      } catch (e) {
        if (dead || seq.current !== me) return
        setError(e instanceof Error ? e.message : '这个 PDF 打不开')
        setLoading(false)
      }
    })()

    return () => {
      dead = true
      // 文档里挂着 worker：不销毁就是一条不回收的线程和一堆页面对象
      if (live) void live.destroy()
    }
  }, [host, path])

  // 渲染当前页：canvas 画内容，叠一层透明文本层负责选择
  useEffect(() => {
    const d = doc
    const canvas = canvasRef.current
    const textBox = textRef.current
    if (!d || !canvas || !textBox || pageNo < 1) return

    let dead = false
    let task: RenderTask | null = null
    let textLayer: { cancel: () => void } | null = null

    void (async () => {
      try {
        const page = await d.getPage(pageNo)
        if (dead) return

        const base = page.getViewport({ scale: 1 })
        const target = zoom === 'fit' ? Math.max(0.1, (boxW - 48) / base.width) : zoom
        const logical = page.getViewport({ scale: target })
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        const hi = page.getViewport({ scale: target * dpr })

        canvas.width = Math.floor(hi.width)
        canvas.height = Math.floor(hi.height)
        canvas.style.width = `${Math.floor(logical.width)}px`
        canvas.style.height = `${Math.floor(logical.height)}px`

        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('这个环境拿不到 canvas 2d 上下文')
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        task = page.render({ canvas, viewport: hi, intent: 'display' })
        await task.promise
        if (dead) return

        textBox.replaceChildren()
        textBox.style.width = `${Math.floor(logical.width)}px`
        textBox.style.height = `${Math.floor(logical.height)}px`
        // pdf.js 的文本层靠这个变量换算字号与位置
        textBox.style.setProperty('--total-scale-factor', String(target))

        const pdfjs = await import('pdfjs-dist')
        if (dead) return
        const layer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textBox,
          viewport: logical,
        })
        textLayer = layer
        await layer.render()
        if (!dead) setPageError(null)
      } catch (e) {
        if (dead) return
        const name = e instanceof Error ? e.name : ''
        // 换页/换缩放时被主动取消，不算错误
        if (name === 'RenderingCancelledException' || name === 'AbortException') return
        setPageError(e instanceof Error ? e.message : '这一页渲染失败')
      }
    })()

    return () => {
      dead = true
      task?.cancel()
      textLayer?.cancel()
    }
  }, [doc, pageNo, zoom, boxW])

  const clamp = (n: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n * 100) / 100))
  const fit = zoom === 'fit'

  return (
    <div data-dd-pdf className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="truncate text-[12.5px] text-ink" title={path}>
          {nameOf(path)}
        </span>
        <span className="shrink-0 text-[11px] text-ink-3">
          PDF{pages > 0 ? ` · ${pages} 页` : ''}
          {size > 0 ? ` · ${Math.max(1, Math.round(size / 1024))} KB` : ''}
        </span>

        <span className="flex-1" />

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setPageNo((n) => Math.max(1, n - 1))}
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
            onClick={() => setPageNo((n) => Math.min(pages, n + 1))}
            disabled={pages === 0 || pageNo >= pages}
            title="下一页"
            aria-label="下一页"
            className="grid size-6 place-items-center rounded text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-35"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>

        <div className="ml-1 flex shrink-0 items-center gap-0.5 rounded-md bg-surface-2 px-0.5 py-0.5">
          <button
            type="button"
            onClick={() => setZoom((z) => clamp((z === 'fit' ? 1 : z) * 0.8))}
            title="缩小"
            aria-label="缩小"
            className="grid size-6 place-items-center rounded text-ink-2 transition-colors hover:bg-surface hover:text-ink"
          >
            <Minus className="size-3.5" />
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
            {fit ? '适合' : `${Math.round((zoom as number) * 100)}%`}
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => clamp((z === 'fit' ? 1 : z) * 1.25))}
            title="放大"
            aria-label="放大"
            className="grid size-6 place-items-center rounded text-ink-2 transition-colors hover:bg-surface hover:text-ink"
          >
            <Plus className="size-3.5" />
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

      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-auto bg-surface-2/30 p-6">
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
        ) : (
          <div className="mx-auto w-fit">
            <div className="relative rounded-md bg-white shadow-[0_1px_4px_rgba(16,35,28,0.14)]">
              <canvas ref={canvasRef} className="block rounded-md" />
              {/* 透明文本层：选中文字靠它，样式见 styles.css 的 .dd-pdf-text */}
              <div ref={textRef} className="dd-pdf-text" data-dd-pdf-text />
            </div>
            {pageError ? (
              <p className="mt-3 max-w-[30rem] text-[11.5px] leading-relaxed text-ink-3">
                这一页的文本层没渲染出来（第 {pageNo} 页）：{pageError}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
