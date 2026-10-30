/*
 * 引用选择弹窗：挑一篇（再挑一节）插成 `[[路径]]` / `[[路径#小节]]`。
 *
 * 和表格编辑器、公式编辑器同一个壳：居中、遮罩、取消/应用。
 * 左边选篇、右边选小节 —— 分两栏是因为"哪一篇"和"这一篇的哪一节"
 * 是两个决定，塞进一层列表里就得来回滚。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LinkTarget } from '../core/markdown/linkComplete'

type Props = {
  targets: LinkTarget[]
  onApply: (insert: string) => void
  onCancel: () => void
}

export function LinkDialog({ targets, onApply, onCancel }: Props) {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<LinkTarget | null>(null)
  const [hq, setHq] = useState('')
  const search = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    search.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const docs = useMemo(() => {
    const t = q.trim()
    return targets.filter((x) => !t || x.title.includes(t) || x.path.includes(t))
  }, [q, targets])

  const heads = useMemo(() => {
    if (!picked) return []
    const t = hq.trim()
    return picked.headings.filter((h) => !t || h.includes(t))
  }, [hq, picked])

  return (
    <div
      data-dd-link-dialog
      className="fixed inset-0 z-50 grid place-items-center bg-ink/25 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="flex h-[420px] w-[620px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_24px_60px_-16px_rgba(16,35,28,0.4)]">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
          <span className="text-[13px] font-medium text-ink">引用</span>
          <span className="text-[11px] text-ink-3">选一篇，再选它的一节</span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="关闭"
            className="ml-auto grid size-6 cursor-pointer place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink-2"
          >
            ×
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* 左：哪一篇 */}
          <div className="flex w-[300px] shrink-0 flex-col border-r border-line">
            <div className="p-2">
              <label className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-2 text-ink-3 focus-within:border-green/50">
                <span aria-hidden className="text-[12px]">
                  ⌕
                </span>
                <input
                  ref={search}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="搜标题或路径"
                  aria-label="搜要引用的篇"
                  className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none"
                />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {docs.length === 0 ? (
                <p className="py-6 text-center text-[12px] text-ink-3">没有匹配的篇</p>
              ) : (
                docs.map((d) => (
                  <button
                    key={d.path}
                    type="button"
                    data-dd-link-doc={d.path}
                    onClick={() => {
                      setPicked(d)
                      setHq('')
                    }}
                    className={`flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left transition-colors ${
                      picked?.path === d.path ? 'bg-green-soft' : 'hover:bg-surface-2'
                    }`}
                  >
                    <span
                      className={`truncate text-[12.5px] ${
                        picked?.path === d.path ? 'font-medium text-green-deep' : 'text-ink'
                      }`}
                    >
                      {d.title}
                    </span>
                    <span className="ml-auto shrink-0 text-[10.5px] text-ink-3">
                      {d.headings.length > 0 ? `${d.headings.length} 节` : ''}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* 右：这一篇的哪一节 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {!picked ? (
              <p className="grid flex-1 place-items-center px-6 text-center text-[12px] leading-relaxed text-ink-3">
                左边选一篇。
                <br />
                想引整篇就不用再选小节。
              </p>
            ) : (
              <>
                <div className="p-2">
                  <label className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-2 text-ink-3 focus-within:border-green/50">
                    <span aria-hidden className="text-[12px]">
                      #
                    </span>
                    <input
                      value={hq}
                      onChange={(e) => setHq(e.target.value)}
                      placeholder="搜小节（可留空）"
                      aria-label="搜小节"
                      className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none"
                    />
                  </label>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                  <button
                    type="button"
                    data-dd-link-whole
                    onClick={() => onApply(`[[${picked.path}]]`)}
                    className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-surface-2"
                  >
                    <span className="text-[12.5px] text-ink">整篇</span>
                    <span className="ml-auto font-mono text-[10.5px] text-ink-3">
                      [[{picked.path}]]
                    </span>
                  </button>
                  {heads.map((h) => (
                    <button
                      key={h}
                      type="button"
                      data-dd-link-head={h}
                      onClick={() => onApply(`[[${picked.path}#${h}]]`)}
                      className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-surface-2"
                    >
                      <span className="text-green/50">#</span>
                      <span className="truncate text-[12.5px] text-ink">{h}</span>
                    </button>
                  ))}
                  {heads.length === 0 && picked.headings.length > 0 ? (
                    <p className="px-2 py-3 text-[11.5px] text-ink-3">没有匹配的小节</p>
                  ) : null}
                  {picked.headings.length === 0 ? (
                    <p className="px-2 py-3 text-[11.5px] text-ink-3">这篇没有小节标题</p>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>

        <footer className="flex h-12 shrink-0 items-center gap-2 border-t border-line px-4">
          <span className="mr-auto text-[11px] text-ink-3">写出去是标准双链，双击就能跳</span>
          <button
            type="button"
            onClick={onCancel}
            className="h-8 cursor-pointer rounded-lg px-3 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-2"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!picked}
            onClick={() => picked && onApply(`[[${picked.path}]]`)}
            className="h-8 cursor-pointer rounded-lg bg-green px-3.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            插入整篇
          </button>
        </footer>
      </div>
    </div>
  )
}
