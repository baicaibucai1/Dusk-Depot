import type { ReactElement } from 'react'
import { BookOpen, Files as FilesIcon } from 'lucide-react'
import { IconSliders } from './icons'

/*
 * 最左侧的功能导航条（48px）。
 *
 * 「文件」= 仓库（用户的文件夹），「书架」= 本机书库（EPUB）。
 * 两套数据互不相干：书架不写仓库，切仓库也不动书架。
 *
 * 点击当前入口 = 收起/展开左侧内容栏；点击另一个入口 = 切工作区并展开。
 */

export type Space = 'files' | 'shelf'

type Props = {
  space: Space
  onSpace: (s: Space) => void
  /** 内容栏收起时也留着导航，点一下就能再展开 */
  treeOpen: boolean
  onToggleTree: () => void
  onSettings: () => void
}

const ITEMS: { id: Space; label: string; render: (cls: string) => ReactElement }[] = [
  { id: 'files', label: '文件', render: (cls) => <FilesIcon className={cls} /> },
  { id: 'shelf', label: '书架', render: (cls) => <BookOpen className={cls} /> },
]

export function Rail({ space, onSpace, treeOpen, onToggleTree, onSettings }: Props) {
  return (
    <nav
      aria-label="功能导航"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface-2/40 py-2"
    >
      {ITEMS.map(({ id, label, render }) => {
        const on = space === id
        return (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={on}
            onClick={() => {
              if (on) onToggleTree()
              else onSpace(id)
            }}
            className={[
              'relative grid size-9 place-items-center rounded-lg transition-colors',
              on
                ? 'bg-surface text-green shadow-[0_1px_2px_rgba(16,35,28,0.10)] ring-1 ring-line'
                : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
            ].join(' ')}
          >
            {on && treeOpen ? (
              <span
                aria-hidden
                className="absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-green"
              />
            ) : null}
            {render('size-[18px]')}
          </button>
        )
      })}

      <div className="flex-1" />

      <button
        type="button"
        title="设置"
        aria-label="设置"
        onClick={onSettings}
        className="grid size-9 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
      >
        <IconSliders className="size-[18px]" />
      </button>
    </nav>
  )
}
