/*
 * 删除一块白板之前的确认。
 *
 * 为什么不能沿用文件树里那个"删掉就没了"的小确认框：
 * 白板可能被 `.note` 的引用块指着，里面还可能装着复制进来的附件。
 * 这两件事**都不能悄悄处理** —— 所以这里把影响面列清楚，再让用户决定。
 *
 * 默认**不删附件**：删除是不可逆的，默认值必须是"少删"。
 */
import { useState } from 'react'
import { AlertTriangle, Link2, Paperclip } from 'lucide-react'

type Props = {
  title: string
  path: string
  state: 'checking' | 'ready' | 'error'
  refs: { noteDir: string; noteTitle: string }[]
  assets: number
  error?: string
  onCancel: () => void
  onConfirm: (removeAssets: boolean) => void
}

export function BoardDeleteDialog({ title, path, state, refs, assets, error, onCancel, onConfirm }: Props) {
  const [removeAssets, setRemoveAssets] = useState(false)

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/25 p-6" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="删除白板"
        className="w-[460px] rounded-xl border border-line bg-surface p-4 shadow-[0_18px_44px_rgba(16,35,28,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[13.5px] font-medium text-ink">删除这块白板？</p>
        <p className="mt-1 break-all font-mono text-[11px] text-ink-3">{path}</p>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
          「{title}」的文件会从磁盘上删掉。这个动作不可撤销。
        </p>

        <div className="mt-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2">
          {state === 'checking' ? (
            <p className="text-[11.5px] text-ink-3">正在检查有哪些笔记引用了它…</p>
          ) : refs.length > 0 ? (
            <>
              <p className="flex items-center gap-1.5 text-[11.5px] text-[#7a5b18]">
                <AlertTriangle className="size-3.5 shrink-0" />
                有 {refs.length} 篇笔记引用了它
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
                删掉之后，那些引用块会显示「白板找不到」，需要你在笔记里重新定位。
                笔记本身不会被改动。
              </p>
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {refs.slice(0, 4).map((r) => (
                  <li key={`${r.noteDir}-${r.noteTitle}`} className="truncate text-[11px] text-ink-2">
                    · {r.noteTitle}
                    <span className="ml-1 font-mono text-[10px] text-ink-3">{r.noteDir}</span>
                  </li>
                ))}
                {refs.length > 4 ? (
                  <li className="text-[10.5px] text-ink-3">还有 {refs.length - 4} 篇…</li>
                ) : null}
              </ul>
            </>
          ) : (
            <p className="flex items-center gap-1.5 text-[11.5px] text-ink-2">
              <Link2 className="size-3.5 shrink-0 text-ink-3" />
              没有笔记引用它
            </p>
          )}
        </div>

        {error ? (
          <p className="mt-2 rounded-md border border-[#f0e2c4] bg-[#fdf8ec] px-2.5 py-1.5 text-[11px] leading-relaxed text-[#7a5b18]">
            {error}
          </p>
        ) : null}

        {assets > 0 ? (
          <label className="mt-2.5 flex items-start gap-2 rounded-lg border border-line px-3 py-2">
            <input
              type="checkbox"
              checked={removeAssets}
              onChange={(e) => setRemoveAssets(e.target.checked)}
              className="mt-[3px] size-[13px] shrink-0 accent-[var(--color-green)]"
            />
            <span className="min-w-0 text-[11px] leading-relaxed text-ink-2">
              <span className="flex items-center gap-1 font-medium text-ink">
                <Paperclip className="size-3" />
                同时删掉复制进白板的 {assets} 个附件
              </span>
              <span className="mt-0.5 block text-ink-3">
                不勾选的话，这些附件会留在仓库的 <span className="font-mono">.dusk/board/</span> 里（不再被任何白板使用）。
                只记路径、没有复制的文件永远不会被删。
              </span>
            </span>
          </label>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surface-2"
          >
            先不删
          </button>
          <button
            type="button"
            onClick={() => onConfirm(removeAssets)}
            className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-paper hover:opacity-90"
          >
            删除白板
          </button>
        </div>
      </div>
    </div>
  )
}
