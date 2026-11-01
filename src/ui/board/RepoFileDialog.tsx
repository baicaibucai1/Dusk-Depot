/*
 * 「引用仓库里的文件」选择器。
 *
 * 为什么不用系统的文件对话框：**引用**要的是仓库内的相对路径。
 * 系统对话框只给一个 File / 绝对路径，写进白板以后换台机器就找不到了。
 * 所以这里只列仓库里已有的文件 —— 选中的那一刻，路径就已经是仓库相对路径。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { kindOf } from '../../core/model/fileKind'
import { FileGlyph } from '../fileIcon'

type Props = {
  files: { path: string; label: string }[]
  onPick: (path: string) => void
  onClose: () => void
}

const KIND_HINT: Record<string, string> = {
  md: '笔记',
  pdf: 'PDF',
  image: '图片',
  board: '白板',
  text: '文本',
  code: '代码',
  sheet: '表格',
}

export function RepoFileDialog({ files, onPick, onClose }: Props) {
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

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const hits = needle ? files.filter((f) => f.path.toLowerCase().includes(needle)) : files
    return hits.slice(0, 300)
  }, [files, q])

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/25 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="引用仓库里的文件"
        className="flex max-h-[70vh] w-[480px] flex-col rounded-xl border border-line bg-surface shadow-[0_18px_44px_rgba(16,35,28,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-line px-4 py-3">
          <p className="text-[13px] font-medium text-ink">引用仓库里已有的文件</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-3">
            只记相对路径，不复制文件。原文件改名或删掉后，这张卡片会显示失效并提供重新选择。
          </p>
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="按路径过滤…"
            className="mt-2 h-8 w-full rounded-md border border-line bg-surface px-2 text-[12px] text-ink outline-none placeholder:text-ink-3/60 focus:border-green/50"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {files.length === 0 ? (
            <p className="px-3 py-6 text-center text-[11.5px] leading-relaxed text-ink-3">
              这个仓库里还没有可以引用的文件（笔记、PDF、图片、白板）。
            </p>
          ) : list.length === 0 ? (
            <p className="px-3 py-6 text-center text-[11.5px] text-ink-3">没有匹配「{q}」的文件</p>
          ) : (
            list.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => onPick(f.path)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
              >
                <FileGlyph path={f.path} size={15} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-ink">{f.label}</span>
                  <span className="block truncate font-mono text-[10px] text-ink-3">{f.path}</span>
                </span>
                <span className="shrink-0 text-[10px] text-ink-3">{KIND_HINT[kindOf(f.path)] ?? ''}</span>
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
