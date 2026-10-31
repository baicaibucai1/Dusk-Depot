/*
 * EPUB 阅读器。
 *
 * 用 epub.js 的内核（BSD-2-Clause，许可证见 THIRD-PARTY-LICENSES.md），
 * 它负责三件难事：解包、CFI、分页排版。我们只负责"外壳"：
 * 目录、翻页键、主题、书签、进度回写。
 *
 * 几条纪律：
 *   · iframe 里**不许跑脚本**（allowScriptedContent: false）；
 *   · 书里的外链不直接打开，先问一句；
 *   · 卸载时销毁 rendition / book，并断开所有监听。
 */
import type { Book as EpubBook, Contents } from 'epubjs'
import type { Rendition } from 'epubjs'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type TocItem, classifyEpubError, epubErrorMessage, openEpub } from '../../core/shelf/epub'
import type { Book } from '../../core/shelf/library'
import type { Shelf } from '../../core/shelf/store'

export type ReaderTheme = 'light' | 'sepia' | 'dark'

export type ReaderSettings = {
  fontSize: number
  lineHeight: number
  /** 正文宽度 px */
  width: number
  theme: ReaderTheme
}

export type ReaderLocation = { cfi: string; percent: number; label: string; chapter: number }

export type ReaderApi = {
  next: () => void
  prev: () => void
  /** 跳到某个 href / CFI */
  goTo: (href: string) => void
  /** 按全书百分比跳（CFI 丢了时的后备） */
  goToPercent: (p: number) => void
}

type Props = {
  shelf: Shelf
  book: Book
  settings: ReaderSettings
  onToc: (toc: TocItem[]) => void
  onLocation: (loc: ReaderLocation) => void
  onError: (message: string) => void
  onApi: (api: ReaderApi | null) => void
  onExternal: (href: string) => void
  onBack: () => void
  onRetry: () => void
}

export function EpubReader({
  shelf,
  book,
  settings,
  onToc,
  onLocation,
  onError,
  onApi,
  onExternal,
  onBack,
  onRetry,
}: Props) {
  const host = useRef<HTMLDivElement | null>(null)
  const rendition = useRef<Rendition | null>(null)
  const epub = useRef<EpubBook | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /* relocated 回调是挂载时注册的，读不到后来的 state —— 用一个 ref 记"位置表好了没" */
  const locReadyRef = useRef(false)
  /** 鼠标停在左/右翻页区时给一个文字提示（只是提示，点击由 iframe 内监听处理） */
  const [zone, setZone] = useState<'left' | 'right' | null>(null)
  const zoneRef = useRef<'left' | 'right' | null>(null)
  const setZoneSafe = useCallback((next: 'left' | 'right' | null) => {
    if (zoneRef.current === next) return
    zoneRef.current = next
    setZone(next)
  }, [])
  /** 外层留白上滚轮的节流时间戳（必须在任何提前 return 之前，hooks 顺序不能变） */
  const wheelAcc = useRef(0)

  const themeRef = useRef(settings.theme)
  themeRef.current = settings.theme

  const applyTheme = useCallback(() => {
    const r = rendition.current
    if (!r) return
    try {
      r.themes.register('dd-light', { body: { background: '#ffffff', color: '#10231c' } })
      r.themes.register('dd-sepia', { body: { background: '#f6efe0', color: '#3b2f1f' } })
      r.themes.register('dd-dark', { body: { background: '#14201b', color: '#d9e4de' } })
      r.themes.select(`dd-${settings.theme}`)
      r.themes.fontSize(`${settings.fontSize}px`)
      r.themes.override('body', `line-height: ${settings.lineHeight};`)
      r.themes.override('a', `color: ${settings.theme === 'dark' ? '#2acb95' : '#0e9b66'};`)
    } catch {
      /* 主题失败不影响阅读 */
    }
  }, [settings.theme, settings.fontSize, settings.lineHeight])

  /* 打开书 + 渲染 */
  useEffect(() => {
    let alive = true
    let opened: Awaited<ReturnType<typeof openEpub>> | null = null

    void (async () => {
      setLoading(true)
      setError(null)
      // ⚠️ 位置表是**按书**生成的：不重置的话，第二本书会拿第一本的位置表算百分比
      locReadyRef.current = false
      try {
        const bytes = await shelf.host.read(book.file)
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

        opened = await openEpub(buf)
        if (opened.encryption === 'drm') {
          throw new Error('DRM protected (encryption.xml)')
        }
        if (!alive) {
          opened.destroy()
          return
        }
        epub.current = opened.book
        onToc(opened.toc)

        const el = host.current
        if (!el) return

        const r = opened.book.renderTo(el, {
          width: '100%',
          height: '100%',
          flow: 'paginated',
          spread: 'none',
          allowScriptedContent: false,
        })
        rendition.current = r

        r.on('relocated', (loc: unknown) => {
          const l = loc as {
            start?: { cfi?: string; index?: number; percentage?: number; href?: string }
          }
          const cfi = String(l.start?.cfi ?? '')
          const chapter = Number(l.start?.index ?? 0)
          const pct = locReadyRef.current && cfi && epub.current?.locations
            ? safePct(epub.current.locations.percentageFromCfi(cfi))
            : safePct(Number(l.start?.percentage ?? 0))
          const label = labelFor(opened?.toc ?? [], String(l.start?.href ?? ''))
          onLocation({ cfi, percent: pct, label, chapter })
        })

        r.on('linkClicked', (href: string, event: Event) => {
          event?.preventDefault?.()
          const h = String(href)
          // 只有真的"出站"链接才交给系统浏览器；书内锚点自己跳，别把读者困住
          if (/^(https?:|mailto:)/i.test(h)) {
            onExternal(h)
            return false
          }
          void r.display(h).catch(() => {})
          return false
        })

        // 键盘：iframe 里的按键不会冒泡到父窗口，必须在 rendition 上再挂一次
        const onKey = (event: KeyboardEvent) => {
          const t = event.target as HTMLElement | null
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
          if (event.ctrlKey || event.metaKey || event.altKey) return
          if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
            event.preventDefault()
            void r.next()
          } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
            event.preventDefault()
            void r.prev()
          }
        }
        r.on('keydown', onKey)

        /*
         * 鼠标翻页。
         *
         * 书页在 iframe 里，父窗口收不到里面的 click / wheel，所以挂在
         * `hooks.content` 上 —— 每次加载新章节都会重新执行一次，监听跟着新文档走。
         *
         * 三条规矩：
         *   · 点链接、按钮、输入框不翻页（那是书自己的交互）；
         *   · 刚才在选字（mousedown 时选区非空）就不翻，避免选到一半跳页；
         *   · 滚轮翻页要节流 —— 触控板一次滑动会连发几十个 wheel 事件。
         */
        r.hooks.content.register((contents: Contents) => {
          const win = contents.window
          const doc = contents.document
          if (!win || !doc) return

          let hadSelection = false
          let lastWheel = 0

          const widthOf = () => win.innerWidth || doc.documentElement.clientWidth || 0

          const onDown = () => {
            try {
              hadSelection = Boolean(win.getSelection()?.toString().trim())
            } catch {
              hadSelection = false
            }
          }

          const onMove = (e: MouseEvent) => {
            const w = widthOf()
            if (!w) return
            setZoneSafe(e.clientX < w * 0.3 ? 'left' : e.clientX > w * 0.7 ? 'right' : null)
          }

          const onLeave = () => setZoneSafe(null)

          const onClick = (e: MouseEvent) => {
            const t = e.target as HTMLElement | null
            if (t?.closest?.('a, button, input, textarea, select, label')) return
            if (hadSelection) return
            const w = widthOf()
            if (!w) return
            if (e.clientX < w * 0.3) {
              setZoneSafe(null)
              void r.prev()
            } else if (e.clientX > w * 0.7) {
              setZoneSafe(null)
              void r.next()
            }
          }

          const onWheel = (e: WheelEvent) => {
            if (e.ctrlKey || e.metaKey) return
            const dy = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
            if (Math.abs(dy) < 8) return
            e.preventDefault()
            const now = Date.now()
            if (now - lastWheel < 420) return
            lastWheel = now
            setZoneSafe(null)
            if (dy > 0) void r.next()
            else void r.prev()
          }

          doc.addEventListener('mousedown', onDown, true)
          doc.addEventListener('mousemove', onMove, { passive: true })
          doc.addEventListener('mouseleave', onLeave, { passive: true })
          doc.addEventListener('click', onClick)
          doc.addEventListener('wheel', onWheel, { passive: false })
        })

        // 先按 CFI 恢复；CFI 失效就退回章节，再退回百分比
        let shown = false
        if (book.cfi) {
          try {
            await r.display(book.cfi)
            shown = true
          } catch {
            shown = false
          }
        }
        if (!shown && book.locator) {
          try {
            const section = opened.book.spine.get(book.locator.chapter)
            if (section?.href) {
              await r.display(section.href)
              shown = true
            }
          } catch {
            shown = false
          }
        }
        if (!shown && book.percent > 0) {
          try {
            const cfi = opened.book.locations.length()
              ? opened.book.locations.cfiFromPercentage(book.percent)
              : null
            await r.display(cfi || undefined)
            shown = true
          } catch {
            shown = false
          }
        }
        if (!shown) await r.display()

        applyTheme()

        // 生成位置表（后台跑）。没有它也能读，只是百分比粗一点
        void opened.book.locations
          .generate(1400)
          .then(() => {
            locReadyRef.current = true
          })
          .catch(() => {})

        if (alive) setLoading(false)
      } catch (e) {
        if (!alive) return
        const kind = classifyEpubError(e)
        setError(epubErrorMessage(kind))
        onError(epubErrorMessage(kind))
        setLoading(false)
      }
    })()

    return () => {
      alive = false
      try {
        rendition.current?.destroy()
      } catch {
        /* ignore */
      }
      rendition.current = null
      try {
        opened?.destroy()
      } catch {
        /* ignore */
      }
      epub.current = null
    }
    // 换书 = 重开；设置变化走下面单独的效果
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, book.file, shelf.where])

  /* 显示偏好变化 */
  useEffect(() => {
    applyTheme()
  }, [applyTheme])

  /* 宽度变了要重新分页 */
  useEffect(() => {
    const r = rendition.current
    if (!r) return
    const t = window.setTimeout(() => {
      try {
        ;(r as unknown as { resize: () => void }).resize()
      } catch {
        /* ignore */
      }
    }, 80)
    return () => window.clearTimeout(t)
  }, [settings.width, settings.fontSize, settings.lineHeight])

  /* 翻页键（焦点在阅读器外壳 / 工具条上时走这一条） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault()
        void rendition.current?.next()
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        void rendition.current?.prev()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* 把翻页/跳转交给外层（右栏目录、工具条用） */
  useEffect(() => {
    onApi({
      next: () => void rendition.current?.next(),
      prev: () => void rendition.current?.prev(),
      goTo: (href: string) => void rendition.current?.display(href),
      goToPercent: (p: number) => {
        const b = epub.current
        if (!b) return
        try {
          const cfi = b.locations.length() ? b.locations.cfiFromPercentage(Math.min(1, Math.max(0, p))) : null
          if (cfi) void rendition.current?.display(cfi)
        } catch {
          /* 位置表还没生成完就算了 */
        }
      },
    })
    return () => onApi(null)
  }, [onApi])

  if (error) {
    return (
      <div className="grid h-full place-items-center px-8">
        <div className="max-w-[380px] text-center">
          <p className="text-[13px] leading-relaxed text-ink-2">{error}</p>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg bg-green px-3 py-1.5 text-[12px] text-white hover:bg-green-deep"
            >
              重试打开
            </button>
            <button
              type="button"
              onClick={onBack}
              className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surface-2"
            >
              返回书架
            </button>
          </div>
          <p className="mt-3 text-[10.5px] leading-relaxed text-ink-3">
            如果反复失败，这本书可能损坏或带 DRM；换一本正常书不会保留这个提示。
          </p>
        </div>
      </div>
    )
  }

  /** 外壳上的滚轮（阅读区两侧的留白）：iframe 里的滚轮不会冒泡到这里，互不冲突 */
  const onShellWheel = (e: React.WheelEvent) => {
    const now = Date.now()
    if (now - wheelAcc.current < 420) return
    const dy = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
    if (Math.abs(dy) < 8) return
    wheelAcc.current = now
    if (dy > 0) void rendition.current?.next()
    else void rendition.current?.prev()
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-surface">
      <div
        className="flex min-h-0 flex-1 justify-center overflow-hidden"
        data-dd-reader
        onWheel={onShellWheel}
      >
        <div
          ref={host}
          className="h-full w-full"
          style={{ maxWidth: settings.width, background: settings.theme === 'sepia' ? '#f6efe0' : settings.theme === 'dark' ? '#14201b' : '#fff' }}
        />
      </div>
      {zone ? (
        <div
          aria-hidden
          data-dd-turn-zone={zone}
          className={[
            'pointer-events-none absolute inset-y-0 z-10 flex w-14 items-center justify-center',
            zone === 'left' ? 'left-0' : 'right-0',
          ].join(' ')}
        >
          <span className="grid size-9 place-items-center rounded-full bg-ink/5 text-ink-3 backdrop-blur-[1px]">
            {zone === 'left' ? <ChevronLeft className="size-5" /> : <ChevronRight className="size-5" />}
          </span>
        </div>
      ) : null}

      {loading ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-surface/70 text-[12.5px] text-ink-3">
          正在打开《{book.title}》…
        </div>
      ) : null}
    </div>
  )
}

function safePct(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

function labelFor(toc: TocItem[], href: string): string {
  if (!href) return ''
  const clean = href.split('#')[0]
  const hit = toc.find((t) => t.href.split('#')[0] === clean)
  return hit?.label ?? ''
}

/** 主题色板给外壳用（页面底色要跟 iframe 一致，别露白边） */
export function themeBg(theme: ReaderTheme): string {
  return theme === 'sepia' ? '#f6efe0' : theme === 'dark' ? '#14201b' : '#ffffff'
}

export function themeInk(theme: ReaderTheme): string {
  return theme === 'sepia' ? '#3b2f1f' : theme === 'dark' ? '#d9e4de' : '#10231c'
}
