import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize2, Minus, Plus, Scan } from 'lucide-react'
import type { Host } from '../../core/ports/host'
import { nameOf } from '../../core/model/path'
import { extOf } from '../../core/model/path'

/*
 * 图片预览（只读）。
 *
 * 三条约定的来源：
 *   ① 仓库里是**字节**，浏览器拿相对路径加载不出来 —— 必须读字节换 Blob URL；
 *   ② 换文件 / 关标签 / 卸载时立刻 revoke，否则一个会话下来能攒出几十个 URL；
 *   ③ 快速连点不同图片时，先发的读取可能后到 —— 用序号把过期结果丢掉，
 *      否则会出现"文件名是 B、画面是 A"。
 */

type Props = {
  host: Host
  path: string
}

/** 缩放档：fit = 适应窗口（CSS 撑满容器），number = 实际像素比例 */
type Zoom = 'fit' | number

const MIN = 0.1
const MAX = 8

export function ImageViewer({ host, path }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [size, setSize] = useState<{ w: number; h: number; bytes: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [zoom, setZoom] = useState<Zoom>('fit')

  /** 只有最新的那次读取能写状态 */
  const seq = useRef(0)
  /** 当前挂着的 Blob URL：cleanup 时按这个 revoke，别 revoke 到新的那个 */
  const live = useRef<string | null>(null)

  useEffect(() => {
    const me = ++seq.current
    let cancelled = false

    setLoading(true)
    setError(null)
    setSize(null)
    setZoom('fit')

    void (async () => {
      try {
        const bytes = await host.read(path)
        if (cancelled || seq.current !== me) return

        // 按扩展名给 MIME：宿主只给字节，没有类型信息
        const ext = extOf(path).toLowerCase()
        const mime =
          ext === '.svg'
            ? 'image/svg+xml'
            : ext === '.png'
              ? 'image/png'
              : ext === '.jpg' || ext === '.jpeg'
                ? 'image/jpeg'
                : ext === '.gif'
                  ? 'image/gif'
                  : ext === '.webp'
                    ? 'image/webp'
                    : ext === '.avif'
                      ? 'image/avif'
                      : ext === '.bmp'
                        ? 'image/bmp'
                        : ext === '.ico'
                          ? 'image/x-icon'
                          : 'application/octet-stream'

        /*
         * ⚠️ SVG 也走 <img>：浏览器对 <img> 里的 SVG **不执行脚本**，
         *    也不让它发请求。直接塞进 DOM（innerHTML）就不安全了。
         */
        const blob = new Blob([bytes as unknown as BlobPart], { type: mime })
        const next = URL.createObjectURL(blob)

        if (live.current) URL.revokeObjectURL(live.current)
        live.current = next

        setUrl(next)
        setLoading(false)
      } catch (e) {
        if (cancelled || seq.current !== me) return
        setError(e instanceof Error ? e.message : '读不出这个文件')
        setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      // 切文件 / 关标签 / 卸载：把这一张的 URL 立刻还回去
      if (live.current) {
        URL.revokeObjectURL(live.current)
        live.current = null
      }
    }
  }, [host, path])

  const onLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    setSize({
      w: img.naturalWidth,
      h: img.naturalHeight,
      bytes: 0,
    })
  }, [])

  const fit = zoom === 'fit'
  const shown = fit ? null : zoom
  const step = (dir: 1 | -1) => {
    const base = fit ? 1 : zoom
    const next = Math.min(MAX, Math.max(MIN, Math.round((base * (dir > 0 ? 1.25 : 0.8)) * 100) / 100))
    setZoom(next)
  }

  const ext = extOf(path).replace('.', '').toUpperCase() || '图片'

  return (
    <div data-dd-image className="flex min-h-0 flex-1 flex-col bg-surface">
      {/* 工具条：文件名 + 尺寸 + 缩放。跟编辑器的格式条同一档高度 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="truncate text-[12.5px] text-ink" title={path}>
          {nameOf(path)}
        </span>
        <span className="shrink-0 text-[11px] text-ink-3">
          {ext}
          {size ? ` · ${size.w} × ${size.h}` : ''}
        </span>

        <span className="flex-1" />

        <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-surface-2 px-0.5 py-0.5">
          <button
            type="button"
            onClick={() => step(-1)}
            title="缩小"
            aria-label="缩小"
            className="grid size-6 place-items-center rounded text-ink-2 transition-colors hover:bg-surface hover:text-ink"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom('fit')}
            title="适应窗口"
            aria-label="适应窗口"
            className={[
              'grid h-6 min-w-11 place-items-center rounded px-1 font-mono text-[11px] tabular-nums transition-colors',
              fit ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(16,35,28,0.1)]' : 'text-ink-2 hover:bg-surface',
            ].join(' ')}
          >
            {fit ? '适应' : `${Math.round((shown ?? 1) * 100)}%`}
          </button>
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
            onClick={() => setZoom(1)}
            title="实际大小（100%）"
            aria-label="实际大小"
            className="grid size-6 place-items-center rounded text-ink-2 transition-colors hover:bg-surface hover:text-ink"
          >
            <Scan className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom('fit')}
            title="适应窗口"
            aria-label="适应窗口按钮"
            className="grid size-6 place-items-center rounded text-ink-2 transition-colors hover:bg-surface hover:text-ink"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto bg-surface-2/30">
        {loading ? (
          <p className="absolute inset-0 grid place-items-center text-[12.5px] text-ink-3">正在读取图片…</p>
        ) : error ? (
          <div className="absolute inset-0 grid place-items-center px-8">
            <div className="max-w-[26rem] text-center">
              <p className="text-[13px] text-ink">这张图打不开。</p>
              <p className="mt-1.5 break-all font-mono text-[11.5px] leading-relaxed text-ink-3">{error}</p>
              <p className="mt-2 text-[11.5px] text-ink-3">{path}</p>
            </div>
          </div>
        ) : url ? (
          <div className={fit ? 'grid h-full w-full place-items-center p-6' : 'p-6'}>
            <img
              src={url}
              alt={nameOf(path)}
              onLoad={onLoad}
              onError={() => setError('这不是一张能显示的图片（文件可能损坏或扩展名不对）')}
              style={
                fit
                  ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
                  : { width: `${(shown ?? 1) * (size?.w ?? 0)}px`, height: 'auto', maxWidth: 'none' }
              }
              className="block rounded-md bg-surface shadow-[0_1px_3px_rgba(16,35,28,0.08)]"
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
