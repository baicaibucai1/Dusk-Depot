import type { ReactElement } from 'react'
import { BookOpen, Files as FilesIcon } from 'lucide-react'
import { IconSliders } from './icons'

/*
 * 最左侧的功能导航条。
 *
 * 「文件」= 仓库（用户的文件夹），「书架」= 本机书库（EPUB）。
 * 两套数据互不相干：书架不写仓库，切仓库也不动书架。
 *
 * 布局：图标 + 小字两行。之前只有图标、间距 4px，两个入口挤成一列小方块，
 * 认不出是干什么的；现在每个入口是一张有标签的"卡片"，顶部入口和底部设置之间
 * 拉一条分隔线，纵向不再粘在一起。
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

/** 入口的统一样式（顶部两个与底部设置共用，避免两套高度对不齐） */
function itemClass(on: boolean): string {
  return [
    'group relative flex w-[52px] flex-col items-center gap-[5px] rounded-xl py-2 transition-colors',
    on ? 'bg-surface text-green shadow-[0_1px_2px_rgba(16,35,28,0.10)] ring-1 ring-line' : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
  ].join(' ')
}

export function Rail({ space, onSpace, treeOpen, onToggleTree, onSettings }: Props) {
  return (
    <nav
      aria-label="功能导航"
      className="flex w-16 shrink-0 flex-col items-center gap-2.5 border-r border-line bg-surface-2/40 py-3"
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
            className={itemClass(on)}
          >
            {on && treeOpen ? (
              <span
                aria-hidden
                className="absolute top-1/2 left-0 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-green"
              />
            ) : null}
            {render('size-5')}
            <span className="text-[10.5px] leading-none tracking-[0.02em]">{label}</span>
          </button>
        )
      })}

      <div className="flex-1" />

      <div aria-hidden className="mb-1 h-px w-7 bg-line" />

      <button type="button" title="设置" aria-label="设置" onClick={onSettings} className={itemClass(false)}>
        <IconSliders className="size-5" />
        <span className="text-[10.5px] leading-none tracking-[0.02em]">设置</span>
      </button>
    </nav>
  )
}
