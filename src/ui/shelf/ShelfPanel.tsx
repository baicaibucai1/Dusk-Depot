/*
 * 书架左栏：搜索、筛选、排序、书目列表。
 *
 * 列表只读 `library.json`（磁盘上的书 + 已缓存的元数据），**不会**逐本打开 EPUB ——
 * 书架里有五十本书时，首屏要立刻出来。
 */
import { AlertTriangle, BookOpen, MoreHorizontal, Plus, RotateCw, Search, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type Book, filterBooks, formatWhen, percentLabel, sortBooks } from '../../core/shelf/library'
import { setHighlight } from '../dnd'
import { ContextMenu } from '../ContextMenu'
import type { ShelfApi } from './useShelf'

type Props = {
  api: ShelfApi
  activeId: string | null
  onPick: (id: string) => void
  onAdd: () => void
  onChooseDir: () => void
  onRetry: () => void
  onRegrant: () => void
  onRescan: () => void
  width: number
  resizer?: React.ReactNode
}

type View = 'all' | 'reading' | 'trash'
type Sort = 'recent' | 'title'

export function ShelfPanel({
  api,
  activeId,
  onPick,
  onAdd,
  onChooseDir,
  onRetry,
  onRegrant,
  onRescan,
  width,
  resizer,
}: Props) {
  const [q, setQ] = useState('')
  const [view, setView] = useState<View>('all')
  const [sort, setSort] = useState<Sort>('recent')
  const [menu, setMenu] = useState<{ x: number; y: number; book: Book } | null>(null)
  const [pending, setPending] = useState<{ book: Book; purge: boolean } | null>(null)

  const source = view === 'trash' ? api.trashBooks : api.books
  const books = useMemo(
    () => sortBooks(filterBooks(source, q, view === 'reading' ? 'reading' : 'all'), sort),
    [source, q, view, sort],
  )

  const busy = api.progress !== null
  const counts = useMemo(() => {
    const results = api.report ?? []
    return {
      ok: results.filter((r) => r.ok && !r.duplicate).length,
      dup: results.filter((r) => r.duplicate).length,
      bad: results.filter((r) => !r.ok).length,
    }
  }, [api.report])

  /* 重复导入时把人带到原来那条 */
  useEffect(() => {
    if (!api.locateId) return
    setView('all')
    const el = document.querySelector(`[data-book-id="${api.locateId}"]`)
    el?.scrollIntoView({ block: 'nearest' })
    const t = window.setTimeout(() => api.clearLocate(), 2600)
    return () => window.clearTimeout(t)
  }, [api.locateId, api])

  return (
    <aside
      data-dd-shelf
      className="relative flex min-h-0 shrink-0 flex-col border-r border-line bg-surface"
      style={{ width }}
    >
      <div className="flex h-[34px] shrink-0 items-center gap-1 border-b border-line pr-2 pl-3">
        <BookOpen className="size-3.5 text-ink-3" />
        <span className="font-mono text-[11px] text-ink-3">{api.books.length} 本</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onRescan}
          disabled={api.status !== 'ready' || busy}
          title="重新扫描目录（补登记新书、标出缺失）"
          aria-label="重新扫描书架目录"
          className="grid size-7 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2 disabled:opacity-40"
        >
          <RotateCw className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onAdd}
          disabled={api.status !== 'ready' || busy}
          title={busy ? '正在导入，等这一批结束' : '添加 EPUB'}
          aria-label="添加 EPUB"
          className="grid size-7 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2 disabled:opacity-40"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="flex shrink-0 flex-col gap-2 px-3 pt-2.5 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索书名、作者、文件名"
            aria-label="搜索书架"
            className="h-7 w-full rounded-md border border-line bg-surface pr-2 pl-7 text-[12px] text-ink outline-none placeholder:text-ink-3/70 focus:border-green/50"
          />
        </div>

        <div className="flex items-center gap-1">
          <div className="flex rounded-md bg-surface-2 p-0.5" role="group" aria-label="书架筛选">
            {(
              [
                ['all', '全部'],
                ['reading', '最近阅读'],
                ['trash', `回收站${api.trashBooks.length ? ` ${api.trashBooks.length}` : ''}`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                aria-pressed={view === id}
                className={[
                  'rounded-[5px] px-2 py-[3px] text-[11px] transition-colors',
                  view === id ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(16,35,28,0.08)]' : 'text-ink-3 hover:text-ink-2',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            aria-label="排序"
            className="h-6 rounded-md border border-line bg-surface px-1 text-[11px] text-ink-2 outline-none"
          >
            <option value="recent">最近阅读</option>
            <option value="title">书名</option>
          </select>
        </div>
      </div>

      {api.error && api.status !== 'error' && api.status !== 'setup' ? (
        <div role="status" className="shrink-0 border-b border-[#f0e2c4] bg-[#fdf8ec] px-3 py-2">
          <p className="text-[11px] font-medium text-[#7a5b18]">书架目录出了点问题</p>
          <p className="mt-0.5 max-h-[38px] overflow-y-auto text-[10.5px] leading-relaxed break-words text-[#7a5b18]/90">
            {api.error}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {api.errorRegrant ? (
              <button
                type="button"
                onClick={onRegrant}
                className="rounded-md bg-green px-2 py-1 text-[10.5px] text-white hover:bg-green-deep"
              >
                重新授权
              </button>
            ) : null}
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md border border-line px-2 py-1 text-[10.5px] text-ink-2 hover:bg-surface-2"
            >
              重试
            </button>
            <button
              type="button"
              onClick={onChooseDir}
              className="rounded-md border border-line px-2 py-1 text-[10.5px] text-ink-2 hover:bg-surface-2"
            >
              重新选目录
            </button>
            <button
              type="button"
              onClick={api.clearError}
              className="rounded-md px-1.5 py-1 text-[10.5px] text-ink-3 hover:text-ink-2"
            >
              知道了
            </button>
          </div>
        </div>
      ) : null}

      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        data-drop-zone="shelf-list"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files') || busy) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setHighlight({ zone: 'shelf-list', dir: null, el: e.currentTarget })
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setHighlight(null)
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length === 0) return
          e.preventDefault()
          setHighlight(null)
          if (busy) return
          const files = [...e.dataTransfer.files]
          void api.importFiles(files.map((file) => ({ kind: 'file' as const, file })))
        }}
      >
        {api.status === 'loading' ? (
          <p className="px-3 py-6 text-center text-[11.5px] text-ink-3">正在打开书架…</p>
        ) : api.status === 'setup' ? (
          <div className="px-2 py-6 text-center">
            <p className="text-[12.5px] text-ink-2">还没选书架目录</p>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
              书架是独立的目录，跟仓库分开存放。选好之后，书会复制进去，原文件不动。
            </p>
            <button
              type="button"
              onClick={onChooseDir}
              className="mt-3 rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surface-2"
            >
              选一个文件夹
            </button>
          </div>
        ) : api.status === 'error' ? (
          <div className="px-2 py-5">
            <p className="text-[12px] text-ink-2">书架打不开</p>
            <p className="mt-1 text-[11px] leading-relaxed break-words text-ink-3">{api.error}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {api.errorRegrant ? (
                <button
                  type="button"
                  onClick={onRegrant}
                  className="rounded-md bg-green px-2 py-1 text-[11.5px] text-white hover:bg-green-deep"
                >
                  重新授权
                </button>
              ) : null}
              <button type="button" onClick={onRetry} className="rounded-md border border-line px-2 py-1 text-[11.5px] text-ink-2 hover:bg-surface-2">
                重试
              </button>
              <button type="button" onClick={onChooseDir} className="rounded-md border border-line px-2 py-1 text-[11.5px] text-ink-2 hover:bg-surface-2">
                重新选目录
              </button>
            </div>
          </div>
        ) : books.length === 0 ? (
          <EmptyShelf view={view} hasQuery={Boolean(q)} onAdd={onAdd} />
        ) : (
          <ul className="flex flex-col gap-0.5">
            {books.map((b) => (
              <li key={b.id}>
                <div
                  data-book-id={b.id}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, book: b })
                  }}
                  className={[
                    'group flex w-full items-start rounded-lg transition-colors',
                    activeId === b.id
                      ? 'bg-green-soft'
                      : api.locateId === b.id
                        ? 'bg-[#fdf8ec] ring-1 ring-[#e8d9a8]'
                        : 'hover:bg-surface-2',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    onClick={() => onPick(b.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                        e.preventDefault()
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setMenu({ x: r.left + 12, y: r.bottom, book: b })
                      }
                    }}
                    className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-green/30"
                  >
                    <Cover book={b} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{b.title}</span>
                        {b.trashedAt ? (
                          <span className="shrink-0 rounded bg-[#fdf0ef] px-1 text-[9.5px] text-[#8f1d17]">已删除</span>
                        ) : b.broken ? (
                          <span className="flex shrink-0 items-center gap-0.5 rounded bg-[#fdf8ec] px-1 text-[9.5px] text-[#7a5b18]">
                            <AlertTriangle className="size-2.5" />
                            文件缺失
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-ink-3">
                        {b.author || '作者未知'}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 text-[10.5px] text-ink-3">
                        <span className="truncate">{percentLabel(b.percent)}</span>
                        <span className="opacity-50">·</span>
                        <span className="truncate">{formatWhen(b.lastReadAt)}</span>
                      </span>
                      {b.percent > 0 && !b.trashedAt ? (
                        <span className="mt-1 block h-[2px] w-full overflow-hidden rounded-full bg-line">
                          <span
                            className="block h-full rounded-full bg-green"
                            style={{ width: `${Math.round(b.percent * 100)}%` }}
                          />
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`《${b.title}》的菜单`}
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setMenu({ x: r.left - 140, y: r.bottom + 4, book: b })
                    }}
                    className="mt-1.5 mr-1 grid size-6 shrink-0 place-items-center rounded text-ink-3 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-surface"
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 清单写不进去：红条常驻，直到真的写成功 */}
      {api.saveState.kind === 'error' ? (
        <div role="alert" className="shrink-0 border-t border-[#f0c9c5] bg-[#fdf0ef] px-3 py-2">
          <p className="text-[11px] font-medium text-[#8f1d17]">书架清单没有保存</p>
          <p className="mt-0.5 max-h-[42px] overflow-y-auto text-[10.5px] leading-relaxed break-words text-[#8f1d17]/85">
            {api.saveState.message}
          </p>
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10px] text-[#8f1d17]/70">改动还在内存里，关掉程序会丢</span>
            <button
              type="button"
              onClick={() => void api.retrySave()}
              className="rounded-md bg-[#b3261e] px-2 py-1 text-[11px] text-white hover:bg-[#8f1d17]"
            >
              重试保存
            </button>
          </div>
        </div>
      ) : api.saveState.kind === 'dirty' || api.saveState.kind === 'saving' ? (
        <p className="shrink-0 border-t border-line px-3 py-1.5 text-[10.5px] text-ink-3">正在保存书架清单…</p>
      ) : null}

      {busy && api.progress ? (
        <div className="shrink-0 border-t border-line px-3 py-2 text-[11px] text-ink-2">
          <div className="flex items-center justify-between gap-1">
            <span className="truncate">
              导入中 {api.progress.done}/{api.progress.total}
              {api.progress.results.length ? (
                <span className="ml-1 text-ink-3">
                  成功 {api.progress.results.filter((r) => r.ok && !r.duplicate).length}
                  {api.progress.results.some((r) => r.duplicate)
                    ? ` · 已有 ${api.progress.results.filter((r) => r.duplicate).length}`
                    : ''}
                  {api.progress.results.some((r) => !r.ok)
                    ? ` · 失败 ${api.progress.results.filter((r) => !r.ok).length}`
                    : ''}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={api.cancelImport}
              className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10.5px] text-ink-2 hover:bg-surface-2"
            >
              取消
            </button>
          </div>
          <p className="mt-0.5 max-w-full truncate text-[10.5px] text-ink-3">
            {api.progress.phase === 'meta' ? '读取元数据：' : ''}
            {api.progress.current}
          </p>
          <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-green transition-[width]"
              style={{ width: `${Math.round((api.progress.done / Math.max(1, api.progress.total)) * 100)}%` }}
            />
          </div>
        </div>
      ) : null}

      {api.report && !busy ? (
        <div className="shrink-0 border-t border-line bg-surface px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink-2">
              导入结果
              <span className="ml-1 text-ink-3">
                成功 {counts.ok}
                {counts.dup ? ` · 已有 ${counts.dup}` : ''}
                {counts.bad ? ` · 失败 ${counts.bad}` : ''}
              </span>
            </span>
            <button type="button" onClick={api.clearReport} className="text-[10.5px] text-ink-3 hover:text-ink-2">
              知道了
            </button>
          </div>
          <ul className="mt-1 max-h-[104px] overflow-y-auto">
            {(api.report ?? []).slice(0, 12).map((r, i) => (
              <li key={`${r.name}-${i}`} className="flex items-start gap-1.5 py-0.5 text-[10.5px] leading-snug">
                <span
                  className={[
                    'mt-[3px] size-1.5 shrink-0 rounded-full',
                    !r.ok ? 'bg-[#b3261e]' : r.duplicate ? 'bg-[#c99a2e]' : 'bg-green',
                  ].join(' ')}
                />
                <span className="min-w-0 flex-1 break-words text-ink-2">
                  <span className="text-ink-3">{r.name}</span> · {r.message}
                  {r.ok && r.bookId && !r.trashed ? (
                    <button
                      type="button"
                      onClick={() => onPick(r.bookId as string)}
                      className="ml-1 text-[10.5px] text-green underline decoration-green/40"
                    >
                      {r.duplicate ? '打开已有' : '打开'}
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
            {(api.report?.length ?? 0) > 12 ? (
              <li className="py-0.5 text-[10.5px] text-ink-3">还有 {(api.report?.length ?? 0) - 12} 项…</li>
            ) : null}
          </ul>
          {api.failedCount > 0 ? (
            <button
              type="button"
              onClick={() => void api.retryFailed()}
              className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10.5px] text-ink-2 hover:bg-surface-2"
            >
              <RotateCw className="size-3" />
              重试失败的 {api.failedCount} 项
            </button>
          ) : null}
        </div>
      ) : null}

      {menu ? (
        <ShelfMenu
          menu={menu}
          api={api}
          onClose={() => setMenu(null)}
          onPick={(b) => {
            if (b.broken && !b.trashedAt) {
              onRescan()
              return
            }
            onPick(b.id)
          }}
          onDelete={(b) => {
            setMenu(null)
            setPending({ book: b, purge: Boolean(b.trashedAt) })
          }}
          onRestore={(b) => {
            setMenu(null)
            void api.restoreBook(b.id)
          }}
          onForget={(b) => {
            setMenu(null)
            void api.forgetBook(b.id)
          }}
        />
      ) : null}

      {pending ? (
        <ConfirmDelete
          book={pending.book}
          purge={pending.purge}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const job = pending
            setPending(null)
            if (job.purge) void api.purgeBook(job.book.id)
            else void api.removeBook(job.book.id)
          }}
        />
      ) : null}

      {resizer}
    </aside>
  )
}

function Cover({ book }: { book: Book }) {
  if (book.cover && !book.trashedAt) {
    return <img src={book.cover} alt="" className="h-[56px] w-[40px] shrink-0 rounded-[3px] object-cover shadow-[0_1px_3px_rgba(16,35,28,0.18)]" />
  }
  return (
    <span className="grid h-[56px] w-[40px] shrink-0 place-items-center rounded-[3px] border border-line bg-surface-2 text-[15px] text-ink-3">
      {book.trashedAt ? <Trash2 className="size-4" /> : <BookOpen className="size-4" />}
    </span>
  )
}

function EmptyShelf({ view, hasQuery, onAdd }: { view: View; hasQuery: boolean; onAdd: () => void }) {
  const trash = view === 'trash'
  return (
    <div className="px-3 py-8 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-xl border border-dashed border-line text-ink-3">
        {trash ? <Trash2 className="size-5" /> : <BookOpen className="size-5" />}
      </div>
      <p className="mt-3 text-[12.5px] text-ink-2">
        {hasQuery ? '没有匹配的书' : trash ? '回收站是空的' : '书架还是空的'}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
        {hasQuery
          ? '换个关键词试试'
          : trash
            ? '删除的书会先放到这里，确认不要了再彻底删除。'
            : '点下面的按钮添加 EPUB，或把 .epub 文件拖到这里'}
      </p>
      {!hasQuery && !trash ? (
        <button
          type="button"
          onClick={onAdd}
          className="mt-3 inline-flex items-center gap-1 rounded-lg bg-green px-3 py-1.5 text-[12px] text-white hover:bg-green-deep"
        >
          <Plus className="size-3.5" />
          添加 EPUB
        </button>
      ) : null}
    </div>
  )
}

function ShelfMenu({
  menu,
  api,
  onClose,
  onPick,
  onDelete,
  onRestore,
  onForget,
}: {
  menu: { x: number; y: number; book: Book }
  api: ShelfApi
  onClose: () => void
  onPick: (b: Book) => void
  onDelete: (b: Book) => void
  onRestore: (b: Book) => void
  onForget: (b: Book) => void
}) {
  const b = menu.book
  const canReveal = api.shelf?.canReveal ?? false
  const items = b.trashedAt
    ? [
        { label: '还原到书架', onSelect: () => onRestore(b) },
        { label: '复制书架内相对路径', onSelect: () => void api.copyPath(b) },
        { divider: true, label: '', onSelect: () => {} },
        { label: '彻底删除…', danger: true, onSelect: () => onDelete(b) },
      ]
    : [
        { label: b.broken ? '重新扫描目录' : '继续阅读', onSelect: () => onPick(b) },
        { divider: true, label: '', onSelect: () => {} },
        {
          label: '在资源管理器中查看',
          disabled: !canReveal || b.broken,
          reason: !canReveal ? '当前运行环境拿不到真实文件路径' : '文件已经不在书架目录里了',
          onSelect: () => void api.reveal(b),
        },
        { label: '复制书架内相对路径', onSelect: () => void api.copyPath(b) },
        { divider: true, label: '', onSelect: () => {} },
        ...(b.broken
          ? [{ label: '从列表移除（不删文件）', danger: true, onSelect: () => onForget(b) }]
          : [{ label: '删除（移到回收站）…', danger: true, onSelect: () => onDelete(b) }]),
      ]
  return <ContextMenu x={menu.x} y={menu.y} onClose={onClose} items={items} />
}

function ConfirmDelete({
  book,
  purge,
  onCancel,
  onConfirm,
}: {
  book: Book
  purge: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/25 p-6" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={purge ? '确认彻底删除' : '确认删除'}
        className="w-[380px] rounded-xl border border-line bg-surface p-4 shadow-[0_16px_40px_rgba(16,35,28,0.18)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
        }}
      >
        <p className="text-[13px] font-medium text-ink">
          {purge ? `彻底删除《${book.title}》？` : `删除《${book.title}》？`}
        </p>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
          {purge ? '会从书架回收站里删掉这个副本，之后不能恢复。' : '会把这个副本移到书架的回收站，之后可以还原。'}
          <br />
          <span className="font-mono break-all text-ink-2">{book.trashFile ?? book.file}</span>
        </p>
        <p className="mt-2 text-[11.5px] text-ink-3">
          {purge
            ? '你自己的原始文件（当初导入的那份）不受影响。'
            : '你自己的原始文件（当初导入的那份）不受影响；书架里的这个副本会先移走，不会立刻消失。'}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surface-2">
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-1 rounded-lg bg-[#b3261e] px-3 py-1.5 text-[12px] text-white hover:bg-[#8f1d17]"
          >
            {purge ? <Trash2 className="size-3.5" /> : <Undo2 className="size-3.5" />}
            {purge ? '彻底删除' : '移到回收站'}
          </button>
        </div>
      </div>
    </div>
  )
}
