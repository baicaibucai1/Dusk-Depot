/*
 * 书架没就绪时，仓库里的 `.epub` 落到这一页。
 *
 * 正常情况下在文件树里点 `.epub` 就是**直接开始读**：自动把副本放进书架、
 * 切到书架工作区打开（见 App 的 openRepoEpub）。只有书架还没选目录 / 打不开时，
 * 才需要这一页来解释"为什么点不开"并给出口。
 *
 * 电子书仍然不按文本打开、不把书和进度写进仓库。
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
          这本书在仓库里。读它需要往书架目录复制一份 —— 仓库里的原文件不会移动，也不会被改写。
        </p>
        <p className="mt-1 text-[10.5px] leading-relaxed text-ink-3">
          书架负责目录、翻页、书签和阅读进度；这些都不会写进仓库。
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
            开始阅读
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
