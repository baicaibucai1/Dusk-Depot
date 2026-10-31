/*
 * 新建一条块间连接：起点固定，选终点、类型，再写一句说明。
 *
 * 说明不是必填 —— 但类型必选。首版不画曲线，连接在右栏里以列表呈现，
 * 点一下跳到目标块；这样不会为了"白板"引入不稳定的坐标拖拽。
 */
import { useEffect, useRef, useState } from 'react'
import { RELATION_TYPES, type RelationType } from '../../core/note/board'

type Props = {
  fromId: string
  blocks: { id: string; label: string }[]
  onSave: (rel: { to: string; type: RelationType; label: string }) => void
  onClose: () => void
}

export function RelationDialog({ fromId, blocks, onSave, onClose }: Props) {
  const targets = blocks.filter((b) => b.id !== fromId)
  const [to, setTo] = useState(targets[0]?.id ?? '')
  const [type, setType] = useState<RelationType>('related')
  const [label, setLabel] = useState('')
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/25 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="新建块间连接"
        className="w-[440px] rounded-xl border border-line bg-surface p-4 shadow-[0_18px_44px_rgba(16,35,28,0.2)]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      >
        <p className="text-[13.5px] font-medium text-ink">连接到另一个块</p>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
          连接是两个块之间的关系，不会移动块，也不会改变顺序。
        </p>

        <div className="mt-3 flex flex-col gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-ink-3">目标块</span>
            <select
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-8 rounded-md border border-line bg-surface px-2 text-[12px] text-ink outline-none focus:border-green/50"
            >
              {targets.length === 0 ? <option value="">没有其它块</option> : null}
              {targets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-ink-3">类型</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as RelationType)}
              className="h-8 rounded-md border border-line bg-surface px-2 text-[12px] text-ink outline-none focus:border-green/50"
            >
              {RELATION_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-ink-3">说明（可选）</span>
            <input
              ref={input}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="比如：这一段依赖上面的数据"
              className="h-8 rounded-md border border-line bg-surface px-2 text-[12px] text-ink outline-none placeholder:text-ink-3/60 focus:border-green/50"
            />
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surface-2"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!to}
            onClick={() => onSave({ to, type, label: label.trim() })}
            className="rounded-lg bg-green px-3 py-1.5 text-[12px] text-white hover:bg-green-deep disabled:opacity-45"
          >
            建立连接
          </button>
        </div>
      </div>
    </div>
  )
}
