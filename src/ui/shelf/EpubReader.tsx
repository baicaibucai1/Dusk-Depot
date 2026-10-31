/*
 * EPUB 阅读器。
 *
 * 用 epub.js 的内核（BSD-2-Clause，许可证见 THIRD-PARTY-LICENSES.md），
 * 它负责三件难事：解包、CFI、分页排版。我们只负责"外壳"：
 * 目录、翻页、主题、书签、进度回写。
 *
 * 几条纪律：
 *   · iframe 里**不许跑脚本**（allowScriptedContent: false）；
 *   · 书里的外链不直接打开，先问一句；
 *   · 卸载时销毁 rendition / book，并断开所有监听。
 *
 * 排版的一条教训：`themes.override(name, value)` 里的 name 是 **CSS 属性名**，
 * 不是选择器 —— 写成 `override('body', 'line-height: 1.8')` 只会静默失败。
 * 而真正要压住"书自带 CSS"必须用样式表 + `!important`，否则
 * `p { line-height: .8 }` 这种书会把字叠在一起，用户调行距也毫无反应。
 */
import type { Book as EpubBook, Contents } from 'epubjs'
import type { Rendition } from 'epubjs'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type TocItem, classifyEpubError, epubErrorMessage, openEpub } from '../../core/shelf/epub'
import type { Book } from '../../core/shelf/library'
import type { Shelf } from '../../core/shelf/store'

export type ReaderTheme = 'light' | 'sepia' | 'dark'

/** 翻页方式：分页（左右翻） / 滚动（一条长页） */
export type ReaderFlow = 'paged' | 'scroll'

export type ReaderSettings = {
  fontSize: number
  lineHeight: number
  /** 正文宽度 px */
  width: number
  theme: ReaderTheme
  flow: ReaderFlow
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
  /** 阅读区外层（滚动模式下滚的是它，不是 iframe） */
  const scrollBox = useRef<HTMLDivElement | null>(null)
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
  /** 最近一次落位：切"分页 / 滚动"时用它把位置接上 */
  const posRef = useRef('')
  const lastBook = useRef('')
  /** 最近一次的位置标签（locations 生成完要拿它补算百分比） */
  const lastLocRef = useRef<{ label: string; chapter: number }>({ label: '', chapter: 0 })

  const flow = settings.flow

  const themeRef = useRef(settings.theme)
  themeRef.current = settings.theme

  /**
   * 字号 / 行距 / 配色。
   *
   * 直接往每章的 iframe 里塞一个 `<style id="dd-typography">`。
   * 为什么不走 `themes.override` / `registerRules`：
   *   · `override(name, value)` 的 name 是 **CSS 属性名**，不是选择器，
   *     写成 `override('body', ...)` 只会静默失败；
   *   · `registerRules` + `select` 只在"该主题还没注入过"时才重新下发，
   *     改字号/行距后常常不生效（得等换章）。
   * 自己写 <style> 之后，改一次立刻见效，换章时 hooks.content 会重新塞一遍。
   *
   * 必须带 `!important`：不少书的 CSS 写了 `p { line-height: .8 }`，
   * 不加就压不住 —— 那正是"字全叠在一起"的来源。
   */
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const applyTypography = useCallback((contents: Contents) => {
    const doc = contents.document
    if (!doc) return
    const head = doc.head ?? doc.querySelector('head')
    if (!head) return
    const s2 = settingsRef.current
    const dark = s2.theme === 'dark'
    const bg = themeBg(s2.theme)
    const ink = themeInk(s2.theme)
    const lh = String(s2.lineHeight)
    const fs = `${s2.fontSize}px`
    const link = dark ? '#2acb95' : '#0e9b66'

    const css = `
      html { font-size: ${fs} !important; line-height: ${lh} !important; color: ${ink}; background-color: ${bg}; }
      body { font-size: 1em !important; line-height: ${lh} !important; color: ${ink}; background-color: ${bg}; box-sizing: border-box; padding: 0 8px; }
      p, li, dd, dt, blockquote, td, th, div { font-size: 1em !important; line-height: ${lh} !important; }
      h1, h2, h3, h4, h5, h6 { line-height: 1.35 !important; }
      a { color: ${link}; }
      img { max-width: 100% !important; height: auto !important; }
    `

    let el = doc.getElementById('dd-typography') as HTMLStyleElement | null
    if (!el) {
      el = doc.createElement('style')
      el.id = 'dd-typography'
      head.appendChild(el)
    }
    el.textContent = css
  }, [])

  const applyTheme = useCallback(() => {
    const r = rendition.current
    if (!r) return
    try {
      // epub.js 的类型把 getContents() 写成返回单个 Contents，实际是数组
      const list = r.getContents() as unknown as Contents[]
      for (const c of list) applyTypography(c)
    } catch {
      /* 还没渲染出内容就算了，hooks 会补 */
    }
  }, [applyTypography])

  /* 打开书 + 渲染 */
  useEffect(() => {
    let alive = true
    let opened: Awaited<ReturnType<typeof openEpub>> | null = null

    void (async () => {
      setLoading(true)
      setError(null)
      // ⚠️ 位置表是**按书**生成的：不重置的话，第二本书会拿第一本的位置表算百分比
      locReadyRef.current = false
      // 换书才清位置；切"分页 / 滚动"要沿用当前读到哪儿
      if (lastBook.current !== book.id) {
        lastBook.current = book.id
        posRef.current = ''
      }
      const startCfi = posRef.current || book.cfi
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
          // 给像素宽度而不是 '100%'：epub.js 会把 '100%' 解释成**父级**宽度，
          // 也就是整个阅读区（1440），iframe 于是比正文宽一倍
          width: settings.width,
          height: '100%',
          // 滚动模式交给 epub.js 的连续管理器：一条长页，不再分栏
          flow: flow === 'scroll' ? 'scrolled' : 'paginated',
          manager: flow === 'scroll' ? 'continuous' : 'default',
          spread: 'none',
          allowScriptedContent: false,
        })
        rendition.current = r

        r.on('relocated', (loc: unknown) => {
          const l = loc as {
            start?: { cfi?: string; index?: number; percentage?: number; href?: string }
          }
          const cfi = String(l.start?.cfi ?? '')
          if (cfi) posRef.current = cfi
          const chapter = Number(l.start?.index ?? 0)
          const pct = locReadyRef.current && cfi && epub.current?.locations
            ? safePct(epub.current.locations.percentageFromCfi(cfi))
            : safePct(Number(l.start?.percentage ?? 0))
          const label = labelFor(opened?.toc ?? [], String(l.start?.href ?? ''))
          lastLocRef.current = { label, chapter }
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
          // 滚动模式交给浏览器自己滚，别抢 PageDown
          if (flow === 'scroll') return
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
         * 鼠标翻页（只对分页模式）。
         *
         * 书页在 iframe 里，父窗口收不到里面的 click / wheel，所以挂在
         * `hooks.content` 上 —— 每次加载新章节都会重新执行一次，监听跟着新文档走。
         *
         * ⚠️ 判定要用 **body 的列宽和左边**，不能用 `window.innerWidth`：
         *    epub.js 的 iframe 元素常常比正文宽（实测 1440 vs 720），
         *    按 iframe 宽度算会让正文右半边落在"中间区域"，点了不翻页 ——
         *    这就是"左右点击基本没反应"的真正原因。
         *
         * 三条规矩：点链接/按钮不翻、正在选字不翻、滚轮要节流。
         */
        // 每章加载后先把排版塞进去（字号/行距/配色）
        r.hooks.content.register((contents: Contents) => applyTypography(contents))

        r.hooks.content.register((contents: Contents) => {
          const win = contents.window
          const doc = contents.document
          if (!win || !doc) return

          let hadSelection = false
          let lastWheel = 0

          /** 正文那一列的矩形（分栏后 body 就是"一栏"） */
          const column = () => {
            const b = doc.body
            if (!b) return null
            const rect = b.getBoundingClientRect()
            const w = b.clientWidth || rect.width
            if (!w) return null
            return { left: rect.left, w }
          }

          const onDown = () => {
            try {
              hadSelection = Boolean(win.getSelection()?.toString().trim())
            } catch {
              hadSelection = false
            }
          }

          const onMove = (e: MouseEvent) => {
            if (flow === 'scroll') return
            const c = column()
            if (!c) return
            const x = e.clientX - c.left
            if (x < 0 || x > c.w) {
              setZoneSafe(null)
              return
            }
            setZoneSafe(x < c.w * 0.3 ? 'left' : x > c.w * 0.7 ? 'right' : null)
          }

          const onLeave = () => setZoneSafe(null)

          const onClick = (e: MouseEvent) => {
            if (flow === 'scroll') return
            const t = e.target as HTMLElement | null
            if (t?.closest?.('a, button, input, textarea, select, label')) return
            if (hadSelection) return
            const c = column()
            if (!c) return
            const x = e.clientX - c.left
            if (x < c.w * 0.3) {
              setZoneSafe(null)
              void r.prev()
            } else if (x > c.w * 0.7) {
              setZoneSafe(null)
              void r.next()
            }
          }

          const onWheel = (e: WheelEvent) => {
            if (e.ctrlKey || e.metaKey) return
            const dy = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
            if (Math.abs(dy) < 8) return

            // 滚动模式：iframe 里的滚轮不会自动传给父级（滚动链在 iframe 边界断掉），
            // 这里自己滚 epub.js 的容器 —— 它监听着这个容器的 scroll，
            // 所以进度、目录高亮都会跟着走
            if (flow === 'scroll') {
              const box = scrollBox.current?.querySelector('.epub-container') as HTMLElement | null
              if (!box) return
              e.preventDefault()
              box.scrollTop += e.deltaY
              return
            }

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
        if (startCfi) {
          try {
            await r.display(startCfi)
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

        /*
         * 滚动模式：把滚动交给 epub.js 自己的 `.epub-container`。
         * 它只监听这个容器的 scroll 来算"读到哪儿"，如果我们在外层再包一层滚动，
         * 它永远以为还停在第一页 —— 切回分页就会跳回开头。
         */
        if (flow === 'scroll') {
          const box = el.querySelector('.epub-container') as HTMLElement | null
          if (box) {
            box.style.height = '100%'
            box.style.overflowY = 'auto'
            box.style.overflowX = 'hidden'
          }
        }

        // 生成位置表（后台跑）。没有它也能读，只是百分比粗一点
        void opened.book.locations
          .generate(1400)
          .then(() => {
            locReadyRef.current = true
            /*
             * 位置表生成之前报的百分比是 0（epub.js 那时还不知道全书多长）。
             * 生成完用当前 CFI 重算一次，否则书架列表的进度条会一直停在 0。
             */
            const cfi = posRef.current
            const loc = epub.current?.locations
            if (!alive || !cfi || !loc) return
            try {
              onLocation({
                cfi,
                percent: safePct(loc.percentageFromCfi(cfi)),
                label: lastLocRef.current.label,
                chapter: lastLocRef.current.chapter,
              })
            } catch {
              /* 这本书算不出百分比就算了 */
            }
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
    // 换书 / 切翻页方式 = 重开；其余设置走下面单独的效果
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, book.file, shelf.where, flow])

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
        const box = host.current
        ;(r as unknown as { resize: (w?: number, h?: number) => void }).resize(
          settings.width,
          box?.clientHeight,
        )
      } catch {
        /* ignore */
      }
    }, 80)
    return () => window.clearTimeout(t)
  }, [settings.width, settings.fontSize, settings.lineHeight])

  /* 翻页键（焦点在阅读器外壳 / 工具条上时走这一条） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (flow === 'scroll') return
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
  }, [flow])

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

  /** 外壳上的滚轮（阅读区两侧的留白）：iframe 里的滚轮不会冒泡到这里，互不冲突 */
  const onShellWheel = (e: React.WheelEvent) => {
    if (flow === 'scroll') return
    const now = Date.now()
    if (now - wheelAcc.current < 420) return
    const dy = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
    if (Math.abs(dy) < 8) return
    wheelAcc.current = now
    if (dy > 0) void rendition.current?.next()
    else void rendition.current?.prev()
  }

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

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-surface">
      <div
        className={[
          // 滚动交给 epub.js 的 .epub-container，这里只负责裁边
          'flex min-h-0 flex-1 justify-center overflow-hidden',
        ].join(' ')}
        ref={scrollBox}
        data-dd-reader
        data-flow={flow}
        onWheel={onShellWheel}
      >
        <div
          ref={host}
          className="h-full"
          style={{
            // 明确给 px 宽度：`w-full + max-width` 时 epub.js 会按父级 100% 算 iframe，
            // 结果 iframe 比正文宽一倍（点击判定就全错位了）
            width: settings.width,
            maxWidth: '100%',
            background: themeBg(settings.theme),
          }}
        />
      </div>

      {zone && flow === 'paged' ? (
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
