/*
 * 选一块白板：给 `.note` 的引用块用（插入引用 / 重新定位）。
 *
 * 列表来自 App 的白板索引（路径 + boardId + 标题），所以选中即得到稳定身份，
 * **不是**"按路径猜"。列表空的时候也能新建一块，新建完直接插引用。
 */
import { useEffect, useRef, useState } from 'react'
import type { BoardEntry } from '../../core/board/refs'
import { FileGlyph } from '../fileIcon'

type Props = {
  title: string
  hint?: string
  boards: BoardEntry[]
  /** 当前引用的那一块：列表里标出来 */
  currentId?: string
  onCreate?: () => void
  onPick: (entry: BoardEntry) => void
  onClose: () => void
}

export function BoardPickDialog({ title, hint, boards, currentId, onCreate, onPick, onClose }: Props) {
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const needle = q.trim().toLowerCase()
  const list = needle
    ? boards.filter((b) => b.path.toLowerCase().includes(needle) || b.title.toLowerCase().includes(needle))
    : boards

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/25 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[70vh] w-[460px] flex-col rounded-xl border border-line bg-surface shadow-[0_18px_44px_rgba(16,35,28,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-line px-4 py-3">
          <p className="text-[13px] font-medium text-ink">{title}</p>
          {hint ? <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">{hint}</p> : null}
          <div className="mt-2 flex items-center gap-2">
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="按名字过滤…"
              className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-[12px] text-ink outline-none placeholder:text-ink-3/60 focus:border-green/50"
            />
            {onCreate ? (
              <button
                type="button"
                onClick={onCreate}
                className="h-8 shrink-0 rounded-md bg-green px-2.5 text-[11.5px] text-white hover:bg-green-deep"
              >
                新建白板
              </button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {list.length === 0 ? (
            <p className="px-3 py-6 text-center text-[11.5px] leading-relaxed text-ink-3">
              {boards.length === 0
                ? '这个仓库里还没有白板。点上面的「新建白板」建一块，引用会自动插在当前位置。'
                : `没有匹配「${q}」的白板`}
            </p>
          ) : (
            list.map((b) => (
              <button
                key={b.path}
                type="button"
                onClick={() => onPick(b)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
              >
                <FileGlyph path={b.path} size={15} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] text-ink">{b.title}</span>
                    {currentId && b.boardId === currentId ? (
                      <span className="shrink-0 rounded bg-green-soft px-1 text-[9.5px] text-green">
                        当前引用
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-ink-3">{b.path}</span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="flex shrink-0 justify-end border-t border-line px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surface-2"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
