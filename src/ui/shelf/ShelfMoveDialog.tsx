/*
 * 换书架目录时的三选一。
 *
 * 规矩：**不悄悄清空旧书架、不自动覆盖新目录**。
 * 所以先探一下新目录里有什么，再决定能提供哪几个选项：
 *   · 新目录已有一份书架 → 只能"用它"，不给"搬迁"（会覆盖）
 *   · 新目录是空的       → 搬迁 / 直接用它 / 取消
 *   · 新目录有别的文件   → 只能用（搬迁需要空目录），并说明
 */
type Props = {
  where: string
  books: number
  empty: boolean
  hasLibrary: boolean
  busy: boolean
  onMove: () => void
  onUse: () => void
  onCancel: () => void
}

export function ShelfMoveDialog({ where, books, empty, hasLibrary, busy, onMove, onUse, onCancel }: Props) {
  const canMove = empty && !hasLibrary
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/25 p-6" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="更换书架位置"
        className="w-[420px] rounded-xl border border-line bg-surface p-4 shadow-[0_18px_44px_rgba(16,35,28,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[13.5px] font-medium text-ink">把书架放到这里？</p>
        <p className="mt-1.5 font-mono text-[11px] break-all text-ink-3">{where}</p>

        <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-2">
          {hasLibrary ? (
            <>
              这个目录里已经有一份书架（<b>{books} 本</b>）。可以切过去用它；当前书架不会被动。
            </>
          ) : empty ? (
            <>这个目录是空的。可以把现在的书架搬过去，也可以直接当一个新书架用。</>
          ) : (
            <>这个目录里已经有别的文件（{books} 本 EPUB）。搬迁需要空目录，所以只能直接用它 ——
              书会按目录里的文件重新登记，不会删任何东西。</>
          )}
        </p>

        <div className="mt-4 flex flex-col gap-1.5">
          {canMove ? (
            <button
              type="button"
              disabled={busy}
              onClick={onMove}
              className="rounded-lg bg-green px-3 py-2 text-left text-[12.5px] text-white hover:bg-green-deep disabled:opacity-50"
            >
              搬迁书架到新位置
              <span className="mt-0.5 block text-[10.5px] text-white/80">复制全部书籍和阅读进度；旧目录保留不删</span>
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
              {hasLibrary ? '保留这里原有的一切，直接切过去' : '不复制旧内容，从这里的文件重建索引'}
            </span>
          </button>
          <button type="button" onClick={onCancel} disabled={busy} className="mt-1 rounded-lg px-3 py-1.5 text-[12px] text-ink-3 hover:bg-surface-2">
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
