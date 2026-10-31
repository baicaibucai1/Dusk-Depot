/*
 * 书架左栏：搜索、筛选、排序、书目列表。
 *
 * 列表只读 `library.json`（磁盘上的书 + 已缓存的元数据），**不会**逐本打开 EPUB ——
 * 书架里有五十本书时，首屏要立刻出来。
 */
import { BookOpen, MoreHorizontal, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  type Book,
  type ShelfFilter,
  type SortMode,
  filterBooks,
  formatWhen,
  percentLabel,
  sortBooks,
} from '../../core/shelf/library'
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
  width: number
  resizer?: React.ReactNode
}

export function ShelfPanel({ api, activeId, onPick, onAdd, onChooseDir, onRetry, width, resizer }: Props) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<ShelfFilter>('all')
  const [sort, setSort] = useState<SortMode>('recent')
  const [menu, setMenu] = useState<{ x: number; y: number; book: Book } | null>(null)
  const [pending, setPending] = useState<Book | null>(null)

  const books = useMemo(
    () => sortBooks(filterBooks(api.books, q, filter), sort),
    [api.books, q, filter, sort],
  )

  const busy = api.progress !== null

  /* 重复导入时把人带到原来那条 */
  useEffect(() => {
    if (!api.locateId) return
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
          onClick={onAdd}
          disabled={api.status !== 'ready'}
          title="添加 EPUB"
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
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                aria-pressed={filter === id}
                className={[
                  'rounded-[5px] px-2 py-[3px] text-[11px] transition-colors',
                  filter === id ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(16,35,28,0.08)]' : 'text-ink-3 hover:text-ink-2',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            aria-label="排序"
            className="h-6 rounded-md border border-line bg-surface px-1 text-[11px] text-ink-2 outline-none"
          >
            <option value="recent">最近阅读</option>
            <option value="title">书名</option>
          </select>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        data-drop-zone="shelf-list"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
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
          const files = [...e.dataTransfer.files]
          void api.importFiles(files.map((file) => ({ kind: 'file' as const, file })))
        }}
      >
        {api.status === 'setup' ? (
          <div className="px-2 py-6 text-center">
            <p className="text-[12.5px] text-ink-2">还没选书架目录</p>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
              书架是独立的目录，跟仓库分开存放。
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
              <button type="button" onClick={onRetry} className="rounded-md border border-line px-2 py-1 text-[11.5px] text-ink-2 hover:bg-surface-2">
                重试
              </button>
              <button type="button" onClick={onChooseDir} className="rounded-md border border-line px-2 py-1 text-[11.5px] text-ink-2 hover:bg-surface-2">
                重新选目录
              </button>
            </div>
          </div>
        ) : books.length === 0 ? (
          <EmptyShelf hasQuery={Boolean(q) || filter !== 'all'} onAdd={onAdd} />
        ) : (
          <ul className="flex flex-col gap-0.5">
            {books.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  data-book-id={b.id}
                  onClick={() => onPick(b.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, book: b })
                  }}
                  className={[
                    'group flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-green/30',
                    activeId === b.id
                      ? 'bg-green-soft'
                      : api.locateId === b.id
                        ? 'bg-[#fdf8ec] ring-1 ring-[#e8d9a8]'
                        : 'hover:bg-surface-2',
                  ].join(' ')}
                >
                  <Cover book={b} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">{b.title}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-ink-3">
                      {b.author || '作者未知'}
                    </span>
                    <span className="mt-1 flex items-center gap-1.5 text-[10.5px] text-ink-3">
                      <span className="truncate">{percentLabel(b.percent)}</span>
                      <span className="opacity-50">·</span>
                      <span className="truncate">{formatWhen(b.lastReadAt)}</span>
                    </span>
                    {b.percent > 0 ? (
                      <span className="mt-1 block h-[2px] w-full overflow-hidden rounded-full bg-line">
                        <span
                          className="block h-full rounded-full bg-green"
                          style={{ width: `${Math.round(b.percent * 100)}%` }}
                        />
                      </span>
                    ) : null}
                  </span>
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label="书籍菜单"
                    onClick={(e) => {
                      e.stopPropagation()
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      setMenu({ x: r.left, y: r.bottom + 4, book: b })
                    }}
                    className="mt-0.5 grid size-6 shrink-0 place-items-center rounded text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-surface"
                  >
                    <MoreHorizontal className="size-4" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {api.report && !busy ? (
        <div className="shrink-0 border-t border-line bg-surface px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-ink-2">导入结果</span>
            <button
              type="button"
              onClick={api.clearReport}
              className="text-[10.5px] text-ink-3 hover:text-ink-2"
            >
              知道了
            </button>
          </div>
          <ul className="mt-1 max-h-[104px] overflow-y-auto">
            {api.report.slice(0, 12).map((r, i) => (
              <li key={`${r.name}-${i}`} className="flex items-start gap-1.5 py-0.5 text-[10.5px] leading-snug">
                <span
                  className={[
                    'mt-[3px] size-1.5 shrink-0 rounded-full',
                    !r.ok ? 'bg-[#b3261e]' : r.duplicate ? 'bg-[#c99a2e]' : 'bg-green',
                  ].join(' ')}
                />
                <span className="min-w-0 flex-1 break-words text-ink-2">
                  <span className="text-ink-3">{r.name}</span> · {r.message}
                </span>
              </li>
            ))}
            {api.report.length > 12 ? (
              <li className="py-0.5 text-[10.5px] text-ink-3">还有 {api.report.length - 12} 项…</li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {busy && api.progress ? (
        <div className="shrink-0 border-t border-line px-3 py-2 text-[11px] text-ink-2">
          <div className="flex items-center justify-between">
            <span className="truncate">导入中 {api.progress.done}/{api.progress.total}</span>
            <span className="ml-2 max-w-[45%] truncate text-ink-3">{api.progress.current}</span>
          </div>
          <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-green transition-[width]"
              style={{ width: `${Math.round((api.progress.done / Math.max(1, api.progress.total)) * 100)}%` }}
            />
          </div>
        </div>
      ) : null}

      {menu ? (
        <ShelfMenu
          menu={menu}
          api={api}
          onClose={() => setMenu(null)}
          onDelete={(b) => {
            setMenu(null)
            setPending(b)
          }}
        />
      ) : null}

      {pending ? (
        <ConfirmDelete
          book={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const b = pending
            setPending(null)
            void api.removeBook(b.id)
          }}
        />
      ) : null}

      {resizer}
    </aside>
  )
}

function Cover({ book }: { book: Book }) {
  if (book.cover) {
    return <img src={book.cover} alt="" className="h-[56px] w-[40px] shrink-0 rounded-[3px] object-cover shadow-[0_1px_3px_rgba(16,35,28,0.18)]" />
  }
  return (
    <span className="grid h-[56px] w-[40px] shrink-0 place-items-center rounded-[3px] border border-line bg-surface-2 text-[15px] text-ink-3">
      <BookOpen className="size-4" />
    </span>
  )
}

function EmptyShelf({ hasQuery, onAdd }: { hasQuery: boolean; onAdd: () => void }) {
  return (
    <div className="px-3 py-8 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-xl border border-dashed border-line text-ink-3">
        <BookOpen className="size-5" />
      </div>
      <p className="mt-3 text-[12.5px] text-ink-2">{hasQuery ? '没有匹配的书' : '书架还是空的'}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
        {hasQuery ? '换个关键词试试' : '点下面的按钮添加 EPUB，或把 .epub 文件拖到这里'}
      </p>
      {!hasQuery ? (
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
  onDelete,
}: {
  menu: { x: number; y: number; book: Book }
  api: ShelfApi
  onClose: () => void
  onDelete: (b: Book) => void
}) {
  const canReveal = api.shelf?.canReveal ?? false
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      onClose={onClose}
      items={[
        { label: '继续阅读', onSelect: () => api.openBook(menu.book.id) },
        { divider: true, label: '', onSelect: () => {} },
        {
          label: '在资源管理器中查看',
          disabled: !canReveal,
          reason: '当前运行环境拿不到真实文件路径',
          onSelect: () => void api.reveal(menu.book),
        },
        { label: '复制书架内相对路径', onSelect: () => void api.copyPath(menu.book) },
        { divider: true, label: '', onSelect: () => {} },
        { label: '从书架删除…', danger: true, onSelect: () => onDelete(menu.book) },
      ]}
    />
  )
}

function ConfirmDelete({ book, onCancel, onConfirm }: { book: Book; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/25 p-6" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="确认删除"
        className="w-[360px] rounded-xl border border-line bg-surface p-4 shadow-[0_16px_40px_rgba(16,35,28,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[13px] font-medium text-ink">从书架删除《{book.title}》？</p>
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
          会删除书架目录里的这个文件：
          <br />
          <span className="font-mono break-all text-ink-2">{book.file}</span>
        </p>
        <p className="mt-2 text-[11.5px] text-ink-3">删掉之后不能从这里恢复（不会动你自己的原始文件）。</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surface-2">
            取消
          </button>
          <button type="button" onClick={onConfirm} className="rounded-lg bg-[#b3261e] px-3 py-1.5 text-[12px] text-white hover:bg-[#8f1d17]">
            删除
          </button>
        </div>
      </div>
    </div>
  )
}
