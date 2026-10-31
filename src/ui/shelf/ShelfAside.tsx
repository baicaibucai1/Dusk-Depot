/*
 * 书架右栏：本书的目录、书签、进度。
 *
 * 目录来自 epub.js 解析出的 nav；当前章节按 href 匹配（CFI 只在进度里用）。
 */
import { Bookmark, ChevronRight, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { TocItem } from '../../core/shelf/epub'
import type { Book, Bookmark as Mark } from '../../core/shelf/library'
import { formatWhen, percentLabel } from '../../core/shelf/library'
import type { ReaderLocation } from './EpubReader'

type Props = {
  open: boolean
  width: number
  book: Book | null
  toc: TocItem[]
  loc: ReaderLocation | null
  onGoTo: (href: string) => void
  onGoToMark: (mark: Mark) => void
  onDropMark: (id: string) => void
  onClose: () => void
  resizer?: ReactNode
}

type Tab = 'toc' | 'marks'

export function ShelfAside({ open, width, book, toc, loc, onGoTo, onGoToMark, onDropMark, onClose, resizer }: Props) {
  const [tab, setTab] = useState<Tab>('toc')

  return (
    <aside
      aria-label="书籍目录与书签"
      aria-hidden={!open}
      style={{ width: open ? width : 0 }}
      className={[
        'relative flex shrink-0 overflow-hidden bg-surface transition-[width] duration-200 ease-out',
        open ? 'border-l border-line' : 'pointer-events-none',
      ].join(' ')}
    >
      <div style={{ width }} className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-0.5 border-b border-line px-2">
          {(
            [
              ['toc', '目录'],
              ['marks', '书签'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              className={[
                'rounded-md px-2.5 py-1 text-[12.5px] transition-colors',
                tab === id ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:text-ink-2',
              ].join(' ')}
            >
              {label}
              {id === 'marks' && book?.bookmarks.length ? (
                <span className="ml-1 text-[10.5px] text-ink-3">{book.bookmarks.length}</span>
              ) : null}
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="收起右栏"
            className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink-2"
          >
            ×
          </button>
        </header>

        {!book ? (
          <div className="grid flex-1 place-items-center px-4 text-center text-[11.5px] text-ink-3">
            打开一本书后，这里显示目录和书签
          </div>
        ) : (
          <>
            <div className="shrink-0 border-b border-line px-3 py-2.5">
              <p className="truncate text-[12px] font-medium text-ink">{book.title}</p>
              <p className="mt-0.5 truncate text-[10.5px] text-ink-3">{book.author || '作者未知'}</p>
              <div className="mt-2 flex items-center gap-2">
                <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-surface-2">
                  <span
                    className="block h-full rounded-full bg-green transition-[width]"
                    style={{ width: `${Math.round((loc?.percent ?? book.percent) * 100)}%` }}
                  />
                </span>
                <span className="text-[10.5px] tabular-nums text-ink-3">
                  {percentLabel(loc?.percent ?? book.percent)}
                </span>
              </div>
              {loc?.label ? <p className="mt-1 truncate text-[10.5px] text-ink-3">{loc.label}</p> : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {tab === 'toc' ? (
                toc.length === 0 ? (
                  <p className="px-2 py-4 text-[11.5px] text-ink-3">这本书没有目录信息。</p>
                ) : (
                  <ul className="flex flex-col">
                    {toc.map((t, i) => {
                      const active = Boolean(loc?.label) && loc?.label === t.label
                      return (
                        <li key={`${t.href}-${i}`}>
                          <button
                            type="button"
                            onClick={() => onGoTo(t.href)}
                            style={{ paddingLeft: 8 + t.depth * 12 }}
                            className={[
                              'flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-[12px] transition-colors',
                              active ? 'bg-green-soft text-green-deep' : 'text-ink-2 hover:bg-surface-2',
                            ].join(' ')}
                          >
                            {t.depth > 0 ? <ChevronRight className="size-3 shrink-0 text-ink-3" /> : null}
                            <span className="truncate">{t.label}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )
              ) : book.bookmarks.length === 0 ? (
                <p className="px-2 py-4 text-[11.5px] leading-relaxed text-ink-3">
                  还没有书签。阅读时点工具条上的书签按钮，会记下当前这一页。
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {book.bookmarks.map((m) => (
                    <li key={m.id} className="group flex items-start gap-1 rounded-md hover:bg-surface-2">
                      <button
                        type="button"
                        onClick={() => onGoToMark(m)}
                        className="flex min-w-0 flex-1 items-start gap-1.5 px-2 py-1.5 text-left"
                        title={m.label || `约 ${Math.round(m.percent * 100)}%`}
                      >
                        <Bookmark className="mt-0.5 size-3 shrink-0 text-ink-3" />
                        <span className="min-w-0">
                          <span className="block truncate text-[11.5px] text-ink-2">
                            {m.label || `位置 ${Math.round(m.percent * 100)}%`}
                          </span>
                          <span className="block text-[10px] text-ink-3">
                            {percentLabel(m.percent)} · {formatWhen(m.at)}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label="删除书签"
                        onClick={() => onDropMark(m.id)}
                        className="mt-1.5 mr-1 grid size-5 shrink-0 place-items-center rounded text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-surface hover:text-[#b3261e]"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
      {resizer}
    </aside>
  )
}
