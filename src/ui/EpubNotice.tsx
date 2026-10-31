/*
 * 仓库里遇到 `.epub` 时显示的东西。
 *
 * 电子书是书架的东西：文件区不解析、不按文本打开、也不把书/进度写进仓库。
 * 但"树里直接看不见"也不行 —— 用户会以为文件丢了。所以收进树，点开给一条
 * 明确的说明 + 两个动作：去书架 / 把这份副本加进书架。
 */
import { BookOpen, FolderOpen } from 'lucide-react'

type Props = {
  path: string
  /** 书架现在能不能接收 */
  canAdd: boolean
  /** 正在导入别的书 */
  busy: boolean
  /** 加不进去的原因（书架没选目录 / 当前是暂存等） */
  reason?: string
  onAdd: () => void
  onOpenShelf: () => void
}

export function EpubNotice({ path, canAdd, busy, reason, onAdd, onOpenShelf }: Props) {
  const name = path.split('/').pop() ?? path
  return (
    <div className="grid h-full place-items-center px-8">
      <div className="max-w-[420px] text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-line bg-surface-2 text-ink-3">
          <BookOpen className="size-6" />
        </div>
        <p className="mt-3 truncate text-[14px] font-medium text-ink" title={name}>
          {name}
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
          文件区不读电子书。EPUB 请交给左侧「书架」—— 那里才有目录、翻页、书签和阅读进度。
        </p>
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink-3">
          加进书架会复制一份到书架目录；仓库里的这个文件不会移动，也不会被改写。
        </p>

        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            disabled={!canAdd || busy}
            title={!canAdd ? reason : busy ? '正在导入，等这一批结束' : undefined}
            onClick={onAdd}
            className="inline-flex items-center gap-1.5 rounded-lg bg-green px-3 py-1.5 text-[12px] text-white hover:bg-green-deep disabled:opacity-45"
          >
            <BookOpen className="size-3.5" />
            添加到书架
          </button>
          <button
            type="button"
            onClick={onOpenShelf}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surface-2"
          >
            <FolderOpen className="size-3.5" />
            去书架
          </button>
        </div>

        {!canAdd && reason ? <p className="mt-2.5 text-[11px] text-[#7a5b18]">{reason}</p> : null}
      </div>
    </div>
  )
}
