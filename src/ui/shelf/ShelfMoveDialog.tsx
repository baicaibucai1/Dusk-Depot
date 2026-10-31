/*
 * 换书架目录时的选择页。
 *
 * 规矩：**不悄悄清空旧书架、不自动覆盖新目录**。
 * 所以先由 `inspectTarget` 探好目标里有什么，这里只负责把事实列清楚，
 * 再让用户明确选一个动作。搬迁失败时对话框**不关**，错误就地显示、可以重试。
 */
import type { MoveProgress, TargetInspection } from '../../core/shelf/migrate'
import type { ShelfTarget } from '../../core/shelf/store'

type Props = {
  target: ShelfTarget
  info: TargetInspection
  busy: boolean
  error: string | null
  progress: MoveProgress | null
  onMove: () => void
  onUse: () => void
  onCancel: () => void
}

const PHASE: Record<MoveProgress['phase'], string> = {
  copy: '正在复制',
  verify: '正在校验',
  commit: '正在落位',
  clean: '正在清理',
}

export function ShelfMoveDialog({ target, info, busy, error, progress, onMove, onUse, onCancel }: Props) {
  const canMove = info.ok && info.empty && !info.error
  const hasStuff = !info.empty

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-ink/25 p-6"
      onClick={() => {
        if (!busy) onCancel()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="更换书架位置"
        className="w-[460px] rounded-xl border border-line bg-surface p-4 shadow-[0_18px_44px_rgba(16,35,28,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[13.5px] font-medium text-ink">把书架放到这里？</p>
        <p className="mt-1.5 font-mono text-[11px] break-all text-ink-3">{target.label || '（未命名目录）'}</p>
        {target.nameOnly ? (
          <p className="mt-1 text-[10.5px] text-ink-3">
            浏览器拿不到完整路径，这里显示的是目录名称；实际位置以你刚在系统选择器里选的那个为准。
          </p>
        ) : null}

        <div className="mt-3 rounded-lg border border-line bg-surface-2/50 p-2.5">
          <p className="text-[11px] font-medium text-ink-2">目标目录现状</p>
          {info.error ? (
            <p className="mt-1 text-[11.5px] leading-relaxed text-[#8f1d17]">{info.error}</p>
          ) : info.empty ? (
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">空目录（没有文件，也没有子目录）。</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-[11.5px] leading-relaxed text-ink-2">
              <li>
                {info.files} 个文件、{info.dirs} 个子目录
              </li>
              <li>{info.hasLibrary ? '里面已经有一份书架清单（library.json）' : '没有书架清单，只有普通文件'}</li>
              <li className="text-ink-3">搬迁不会覆盖这里的东西，所以只能选择「使用」或取消。</li>
            </ul>
          )}
        </div>

        {progress ? (
          <div className="mt-3">
            <p className="flex items-center justify-between text-[11px] text-ink-2">
              <span>
                {PHASE[progress.phase]}
                {progress.total ? ` ${progress.done}/${progress.total}` : '…'}
              </span>
              <span className="max-w-[55%] truncate text-ink-3">{progress.current}</span>
            </p>
            <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-green transition-[width]"
                style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
              />
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="mt-3 rounded-lg border border-[#f0c9c5] bg-[#fdf0ef] px-2.5 py-2">
            <p className="text-[11.5px] leading-relaxed break-words text-[#8f1d17]">{error}</p>
            <p className="mt-1 text-[10.5px] text-[#8f1d17]/80">
              当前书架没有被改动，仍然可以正常用。可以再试一次，或者取消。
            </p>
          </div>
        ) : null}

        <div className="mt-4 flex flex-col gap-1.5">
          {canMove ? (
            <button
              type="button"
              disabled={busy}
              onClick={onMove}
              className="rounded-lg bg-green px-3 py-2 text-left text-[12.5px] text-white hover:bg-green-deep disabled:opacity-50"
            >
              搬迁书架到新位置
              <span className="mt-0.5 block text-[10.5px] text-white/80">
                先复制到暂存目录、校验大小和书目，成功后才切过去；旧目录保留不删
              </span>
            </button>
          ) : null}

          <button
            type="button"
            disabled={busy}
            onClick={onUse}
            className={[
              'rounded-lg px-3 py-2 text-left text-[12.5px] disabled:opacity-50',
              canMove ? 'border border-line text-ink-2 hover:bg-surface-2' : 'bg-green text-white hover:bg-green-deep',
            ].join(' ')}
          >
            使用这个位置的书架
            <span className={['mt-0.5 block text-[10.5px]', canMove ? 'text-ink-3' : 'text-white/80'].join(' ')}>
              {info.hasLibrary
                ? '保留这里原有的一切，直接切过去；当前书架不动'
                : hasStuff
                  ? '不复制旧内容，只把这里的 EPUB 登记成新书架'
                  : '不复制旧内容，从一个空书架开始'}
            </span>
          </button>

          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="mt-1 rounded-lg px-3 py-1.5 text-[12px] text-ink-3 hover:bg-surface-2 disabled:opacity-50"
          >
            取消（当前书架不变）
          </button>
        </div>
      </div>
    </div>
  )
}
