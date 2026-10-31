/*
 * 书架中区：空书架欢迎页 / 阅读器外壳（工具条 + 正文 + 显示设置）。
 *
 * 阅读器本体懒加载 —— epub.js 只在真的打开一本书后才下载。
 */
import { ArrowLeft, BookmarkPlus, ChevronLeft, ChevronRight, Minus, Plus, RotateCw, Type } from 'lucide-react'
import { Suspense, lazy, useEffect, useState } from 'react'
import type { TocItem } from '../../core/shelf/epub'
import { setHighlight } from '../dnd'
import { type Book, percentLabel } from '../../core/shelf/library'
import type { ReaderApi, ReaderLocation, ReaderSettings, ReaderTheme } from './EpubReader'
import type { ShelfApi } from './useShelf'

const EpubReader = lazy(() => import('./EpubReader').then((m) => ({ default: m.EpubReader })))

const THEME_LABEL: { id: ReaderTheme; label: string; bg: string }[] = [
  { id: 'light', label: '浅色', bg: '#ffffff' },
  { id: 'sepia', label: '护眼', bg: '#f6efe0' },
  { id: 'dark', label: '深色', bg: '#14201b' },
]

type Props = {
  api: ShelfApi
  book: Book | null
  settings: ReaderSettings
  onSettings: (s: ReaderSettings) => void
  loc: ReaderLocation | null
  readerApi: ReaderApi | null
  onToc: (t: TocItem[]) => void
  onLoc: (bookId: string, loc: ReaderLocation) => void
  onReaderApi: (api: ReaderApi | null) => void
  onBookmark: () => void
  onAdd: () => void
  onChooseDir: () => void
  /** 打开一本书（外层负责先把上一本的进度写回去） */
  onOpenBook: (id: string) => void
  onExternal: (href: string) => void
}

export function ShelfMain({
  api,
  book,
  settings,
  onSettings,
  loc,
  readerApi,
  onToc,
  onLoc,
  onReaderApi,
  onBookmark,
  onAdd,
  onChooseDir,
  onOpenBook,
  onExternal,
}: Props) {
  const [showPrefs, setShowPrefs] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [readerKey, setReaderKey] = useState(0)

  /* 换书就把上一本的错误收掉，别让新书顶着旧报错 */
  useEffect(() => {
    setErr(null)
    setReaderKey((n) => n + 1)
  }, [book?.id])

  if (api.status === 'setup') {
    return <Setup onChooseDir={onChooseDir} />
  }

  if (api.status === 'error') {
    return (
      <main className="grid h-full min-w-0 flex-1 place-items-center bg-paper px-8">
        <div className="max-w-[400px] text-center">
          <p className="text-[14px] font-medium text-ink">书架打不开</p>
          <p className="mt-2 text-[12px] leading-relaxed break-words text-ink-3">{api.error}</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {api.errorRegrant ? (
              <button
                type="button"
                onClick={() => void api.regrant()}
                className="rounded-lg bg-green px-3 py-1.5 text-[12px] text-white hover:bg-green-deep"
              >
                重新授权
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                if (api.config) void api.reload(api.config).catch(() => {})
              }}
              title="重新打开这个目录（不会重新申请浏览器权限）"
              className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surface-2"
            >
              重试
            </button>
            <button
              type="button"
              onClick={onChooseDir}
              className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surface-2"
            >
              重新选目录
            </button>
          </div>
          <p className="mt-3 text-[10.5px] leading-relaxed text-ink-3">
            「重试」只是再打开一次；「重新授权」会请求浏览器重新给读写权限（必须由你点）。
          </p>
        </div>
      </main>
    )
  }

  if (!book) {
    return (
      <Welcome
        onAdd={onAdd}
        count={api.books.length}
        durable={api.shelf?.durable ?? false}
        nameOnly={api.shelf?.nameOnly ?? false}
        where={api.shelf?.where ?? ''}
        onDropEpub={(files) => void importInto(api, files, false, onOpenBook)}
      />
    )
  }

  return (
    <main
      className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface"
      data-dd-reader
      data-drop-zone="reader"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files') || api.importing) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setHighlight({ zone: 'reader', dir: null, el: e.currentTarget })
      }}
      onDragLeave={() => setHighlight(null)}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return
        e.preventDefault()
        setHighlight(null)
        if (api.importing) return
        void importInto(api, [...e.dataTransfer.files], true, onOpenBook)
      }}
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <button
          type="button"
          onClick={() => api.closeBook()}
          title="返回书架"
          aria-label="返回书架"
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-ink-2 hover:bg-surface-2"
        >
          <ArrowLeft className="size-4" />
          书架
        </button>
        <div className="mx-1 h-4 w-px bg-line" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink">{book.title}</p>
          <p className="truncate text-[10.5px] text-ink-3">{book.author || '作者未知'}</p>
        </div>

        <span className="mr-1 hidden text-[10.5px] tabular-nums text-ink-3 sm:block">
          {percentLabel(loc?.percent ?? book.percent)}
        </span>

        <button
          type="button"
          onClick={() => readerApi?.prev()}
          aria-label="上一页"
          title="上一页（←）"
          className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-2"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => readerApi?.next()}
          aria-label="下一页"
          title="下一页（→）"
          className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-2"
        >
          <ChevronRight className="size-4" />
        </button>

        <button
          type="button"
          onClick={onBookmark}
          title="在这里加书签"
          aria-label="加书签"
          className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-surface-2"
        >
          <BookmarkPlus className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => setShowPrefs((v) => !v)}
          aria-pressed={showPrefs}
          title="阅读显示"
          aria-label="阅读显示"
          className={[
            'grid size-7 place-items-center rounded-md hover:bg-surface-2',
            showPrefs ? 'bg-surface-2 text-ink' : 'text-ink-2',
          ].join(' ')}
        >
          <Type className="size-4" />
        </button>
      </header>

      {showPrefs ? <Prefs settings={settings} onChange={onSettings} onClose={() => setShowPrefs(false)} /> : null}

      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="grid h-full place-items-center text-[12.5px] text-ink-3">正在准备阅读器…</div>}>
          <EpubReader
            key={readerKey}
            shelf={api.shelf!}
            book={book}
            settings={settings}
            onToc={onToc}
            onLocation={(loc) => onLoc(book.id, loc)}
            onError={setErr}
            onApi={onReaderApi}
            onExternal={onExternal}
            onBack={() => api.closeBook()}
            onRetry={() => {
              setErr(null)
              setReaderKey((n) => n + 1)
            }}
          />
        </Suspense>
      </div>

      {err ? (
        <p className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-[11px] text-[#b3261e]">
          <span className="min-w-0 flex-1 truncate">{err}</span>
          <button
            type="button"
            onClick={() => {
              setErr(null)
              setReaderKey((n) => n + 1)
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10.5px] text-ink-2 hover:bg-surface-2"
          >
            <RotateCw className="size-3" />
            重试
          </button>
          <button
            type="button"
            onClick={() => api.closeBook()}
            className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10.5px] text-ink-2 hover:bg-surface-2"
          >
            返回书架
          </button>
        </p>
      ) : null}
    </main>
  )
}

/** 拖进来的文件交给书架；阅读页里拖入成功后直接打开第一本 */
async function importInto(api: ShelfApi, files: File[], openFirst: boolean, onOpenBook: (id: string) => void) {
  const results = await api.importFiles(files.map((file) => ({ kind: 'file' as const, file })))
  if (!openFirst) return
  const hit = results.find((r) => r.ok && r.bookId && !r.duplicate)
  if (hit?.bookId) onOpenBook(hit.bookId)
}

function Prefs({
  settings,
  onChange,
  onClose,
}: {
  settings: ReaderSettings
  onChange: (s: ReaderSettings) => void
  onClose: () => void
}) {
  const row = 'flex items-center justify-between gap-3 py-1.5'
  const step = (v: number, d: number, min: number, max: number) => Math.min(max, Math.max(min, v + d))
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div className="absolute top-10 right-2 z-30 w-[236px] rounded-xl border border-line bg-surface p-3 shadow-[0_12px_32px_rgba(16,35,28,0.14)]">
        <div className={row}>
          <span className="text-[11.5px] text-ink-2">翻页方式</span>
          <div className="flex overflow-hidden rounded-md border border-line">
            {(
              [
                { id: 'paged', label: '左右翻页' },
                { id: 'scroll', label: '滚动阅读' },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                aria-label={f.label}
                aria-pressed={settings.flow === f.id}
                onClick={() => onChange({ ...settings, flow: f.id })}
                className={[
                  'px-2 py-0.5 text-[10.5px] transition-colors',
                  settings.flow === f.id ? 'bg-green text-white' : 'text-ink-2 hover:bg-surface-2',
                ].join(' ')}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className={row}>
          <span className="text-[11.5px] text-ink-2">字号</span>
          <div className="flex items-center gap-1">
            <button type="button" aria-label="减小字号" className="grid size-6 place-items-center rounded border border-line text-ink-2" onClick={() => onChange({ ...settings, fontSize: step(settings.fontSize, -1, 13, 24) })}>
              <Minus className="size-3" />
            </button>
            <span className="w-8 text-center text-[11px] tabular-nums text-ink-2">{settings.fontSize}</span>
            <button type="button" aria-label="增大字号" className="grid size-6 place-items-center rounded border border-line text-ink-2" onClick={() => onChange({ ...settings, fontSize: step(settings.fontSize, 1, 13, 24) })}>
              <Plus className="size-3" />
            </button>
          </div>
        </div>
        <div className={row}>
          <span className="text-[11.5px] text-ink-2">行距</span>
          <div className="flex items-center gap-1">
            <button type="button" aria-label="减小行距" className="grid size-6 place-items-center rounded border border-line text-ink-2" onClick={() => onChange({ ...settings, lineHeight: step(settings.lineHeight, -0.1, 1.3, 2.4) })}>
              <Minus className="size-3" />
            </button>
            <span className="w-8 text-center text-[11px] tabular-nums text-ink-2">{settings.lineHeight.toFixed(1)}</span>
            <button type="button" aria-label="增大行距" className="grid size-6 place-items-center rounded border border-line text-ink-2" onClick={() => onChange({ ...settings, lineHeight: step(settings.lineHeight, 0.1, 1.3, 2.4) })}>
              <Plus className="size-3" />
            </button>
          </div>
        </div>
        <div className={row}>
          <span className="text-[11.5px] text-ink-2">版心宽度</span>
          <div className="flex items-center gap-1">
            <button type="button" aria-label="窄一点" className="grid size-6 place-items-center rounded border border-line text-ink-2" onClick={() => onChange({ ...settings, width: step(settings.width, -40, 480, 980) })}>
              <Minus className="size-3" />
            </button>
            <span className="w-10 text-center text-[11px] tabular-nums text-ink-2">{settings.width}</span>
            <button type="button" aria-label="宽一点" className="grid size-6 place-items-center rounded border border-line text-ink-2" onClick={() => onChange({ ...settings, width: step(settings.width, 40, 480, 980) })}>
              <Plus className="size-3" />
            </button>
          </div>
        </div>
        <div className="mt-2 border-t border-line pt-2">
          <span className="text-[11.5px] text-ink-2">主题</span>
          <div className="mt-1.5 flex gap-1.5">
            {THEME_LABEL.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onChange({ ...settings, theme: t.id })}
                aria-pressed={settings.theme === t.id}
                className={[
                  'flex flex-1 items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[11px]',
                  settings.theme === t.id ? 'border-green text-green' : 'border-line text-ink-2 hover:border-ink-3/40',
                ].join(' ')}
              >
                <span className="size-3 rounded-full border border-line" style={{ background: t.bg }} />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

function Welcome({
  onAdd,
  count,
  durable,
  nameOnly,
  where,
  onDropEpub,
}: {
  onAdd: () => void
  count: number
  durable: boolean
  nameOnly: boolean
  where: string
  onDropEpub: (files: File[]) => void
}) {
  return (
    <main
      className="grid h-full min-w-0 flex-1 place-items-center bg-paper px-8"
      data-drop-zone="shelf-welcome"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setHighlight({ zone: 'shelf-welcome', dir: null, el: e.currentTarget })
      }}
      onDragLeave={() => setHighlight(null)}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return
        e.preventDefault()
        setHighlight(null)
        onDropEpub([...e.dataTransfer.files])
      }}
    >
      <div className="max-w-[420px] text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-2xl border border-dashed border-line bg-surface text-ink-3">
          <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z" />
            <path d="M4 5.5V21.5" />
          </svg>
        </div>
        <h2 className="mt-4 text-[16px] font-medium text-ink">{count ? '从左边挑一本' : '书架还是空的'}</h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
          {count
            ? '点书名开始阅读；再点一次工具条上的「书架」可以回来。'
            : '把 .epub 文件拖到这里，或者点下面的按钮添加。书会被复制进书架目录，原文件不动。'}
        </p>
        <button
          type="button"
          onClick={onAdd}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-green px-3.5 py-2 text-[12.5px] text-white hover:bg-green-deep"
        >
          <Plus className="size-4" />
          添加 EPUB
        </button>
        <p className="mt-5 text-[10.5px] leading-relaxed text-ink-3">
          {durable ? (
            <>
              书架位置：<span className="font-mono break-all">{where}</span>
              {nameOnly ? '（浏览器只显示目录名）' : ''}
            </>
          ) : (
            '当前是暂存模式：书只在这次会话里，关掉就没了。'
          )}
        </p>
      </div>
    </main>
  )
}

function Setup({ onChooseDir }: { onChooseDir: () => void }) {
  return (
    <main className="grid h-full min-w-0 flex-1 place-items-center bg-paper px-8">
      <div className="max-w-[400px] text-center">
        <h2 className="text-[15px] font-medium text-ink">先给书架选个位置</h2>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
          书架跟仓库是两套东西：换仓库、搬仓库都不会动它。建议放在应用数据目录或单独的书库文件夹里，
          <b className="font-medium text-ink-2">不要选当前仓库</b>。
        </p>
        <button
          type="button"
          onClick={onChooseDir}
          className="mt-4 rounded-lg bg-green px-3.5 py-2 text-[12.5px] text-white hover:bg-green-deep"
        >
          选一个文件夹
        </button>
      </div>
    </main>
  )
}
