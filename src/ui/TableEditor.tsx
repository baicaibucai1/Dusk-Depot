import { useEffect, useState } from 'react'
import { buildTable } from '../core/markdown/table'
import type { Align } from '../core/markdown/parse'

/*
 * 表格编辑器：一个真正的网格，不是让你去改一堆竖线。
 *
 * 为什么不做成"在正文里直接点单元格编辑"：那要求把表格变成 CM6 里的原子块，
 * 而原子块会毁掉拖选（踩过一次）。所以做成浮层 —— 从正文反查单元格，
 * 这里改完再按 markdown 重新生成写回去。正文始终是普通文本。
 *
 * 列对齐（左/中/右）在这里循环切，应用时写回分隔行 —— 反查时读到的对齐不会丢。
 */
type Props = {
  cells: string[][]
  align: Align[]
  onApply: (cells: string[][], align: Align[]) => void
  onCancel: () => void
}

const ALIGN_LABEL: Record<'none' | 'left' | 'center' | 'right', string> = {
  none: '默认',
  left: '左',
  center: '中',
  right: '右',
}

export function TableEditor({ cells: initial, align: initialAlign, onApply, onCancel }: Props) {
  const [cells, setCells] = useState<string[][]>(() => initial.map((r) => [...r]))
  const [align, setAlign] = useState<Align[]>(() => {
    if (initialAlign.length > 0) return [...initialAlign]
    return new Array(initial[0]?.length ?? 0).fill(null)
  })
  const rows = cells.length
  const cols = cells[0]?.length ?? 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onApply(cells, align)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, onApply, cells, align])

  const set = (r: number, c: number, v: string) =>
    setCells((prev) => prev.map((row, ri) => (ri === r ? row.map((x, ci) => (ci === c ? v : x)) : row)))

  const addRow = () => setCells((prev) => [...prev, new Array(cols).fill('')])
  const addCol = () => {
    setCells((prev) => prev.map((row) => [...row, '']))
    setAlign((prev) => [...prev, null])
  }
  const delRow = () => setCells((prev) => (prev.length > 2 ? prev.slice(0, -1) : prev))
  const delCol = () => {
    setCells((prev) => (cols > 1 ? prev.map((row) => row.slice(0, -1)) : prev))
    setAlign((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))
  }

  /** 点列头的对齐钮：默认 → 左 → 中 → 右 → 默认 */
  const cycleAlign = (c: number) =>
    setAlign((prev) => {
      const next = [...prev]
      const cur = next[c] ?? 'none'
      next[c] = cur === 'none' ? 'left' : cur === 'left' ? 'center' : cur === 'center' ? 'right' : null
      return next
    })

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/25 p-6">
      <div
        role="dialog"
        aria-label="编辑表格"
        className="flex max-h-[80vh] w-full max-w-[52rem] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_20px_60px_rgba(16,35,28,0.22)]"
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <span className="text-[13.5px] font-semibold">编辑表格</span>
          <span className="text-[12px] text-ink-3">
            {rows - 1} 行 × {cols} 列
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={addRow}
              className="h-7 rounded-md px-2 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-2"
            >
              加行
            </button>
            <button
              type="button"
              onClick={addCol}
              className="h-7 rounded-md px-2 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-2"
            >
              加列
            </button>
            <button
              type="button"
              onClick={delRow}
              className="h-7 rounded-md px-2 text-[12.5px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              删行
            </button>
            <button
              type="button"
              onClick={delCol}
              className="h-7 rounded-md px-2 text-[12.5px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              删列
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {/* 列头：点一下循环切这一列的对齐 */}
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: `repeat(${Math.max(cols, 1)}, minmax(6rem, 1fr))` }}
          >
            {Array.from({ length: cols }, (_, c) => (
              <button
                key={c}
                type="button"
                onClick={() => cycleAlign(c)}
                title={`第 ${c + 1} 列对齐：${ALIGN_LABEL[(align[c] ?? 'none') as 'none']}（点击切换）`}
                className={[
                  'mb-1 flex h-6 items-center justify-center gap-1 rounded-md border text-[11.5px] transition-colors',
                  align[c]
                    ? 'border-green/50 bg-green-soft/60 text-green-deep'
                    : 'border-line/70 bg-surface-2/40 text-ink-3 hover:text-ink-2',
                ].join(' ')}
              >
                {align[c] === 'left' ? '⬅' : align[c] === 'center' ? '↔' : align[c] === 'right' ? '➡' : '—'}
                {ALIGN_LABEL[(align[c] ?? 'none') as 'none']}
              </button>
            ))}
          </div>
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: `repeat(${Math.max(cols, 1)}, minmax(6rem, 1fr))` }}
          >
            {cells.map((row, r) =>
              row.map((v, c) => (
                <input
                  key={`${r}-${c}`}
                  value={v}
                  onChange={(e) => set(r, c, e.target.value)}
                  placeholder={r === 0 ? `列 ${c + 1}` : ''}
                  className={[
                    'h-8 w-full rounded-md border px-2 text-[13px] outline-none transition-colors',
                    r === 0
                      ? 'border-line bg-surface-2/60 font-medium text-ink'
                      : 'border-line/70 bg-surface text-ink-2',
                    'focus:border-green/50 focus:bg-surface',
                  ].join(' ')}
                />
              )),
            )}
          </div>
        </div>

        <footer className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-line px-4">
          <span className="mr-auto text-[11.5px] text-ink-3">第一行是表头 · Ctrl+Enter 应用</span>
          <button
            type="button"
            onClick={onCancel}
            className="h-8 rounded-lg px-3 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-2"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onApply(cells, align)}
            className="h-8 rounded-lg bg-green px-3.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
          >
            应用
          </button>
        </footer>
      </div>
    </div>
  )
}

/** 供文档预览用：把单元格拼回 markdown（导出/调试时方便） */
export const tableSource = buildTable
