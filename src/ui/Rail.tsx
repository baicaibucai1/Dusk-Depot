import type { ReactElement } from 'react'
import { Files as FilesIcon } from 'lucide-react'
import { IconSliders } from './icons'

/*
 * 最左侧的功能导航条（48px）。
 *
 * 现在只有「文件」一个入口：工具页去掉了（那一页大半是"待接"的空壳，
 * 与其摆着不如先收起来）。等真有工具接上数据再加回来。
 *
 * 为什么又有这条轨：2026-10-26 把那时的图标轨删了，把「文件 / 工具」
 * 塞进目录栏顶部当页签；现在的桌面布局要求导航和内容分开 ——
 * 导航常驻、窄，内容栏可以被折叠/拖宽而不影响导航。
 */

type Props = {
  /** 目录栏收起时也留着导航，点一下就能再展开 */
  treeOpen: boolean
  onToggleTree: () => void
  onSettings: () => void
}

const ITEMS: { label: string; render: (cls: string) => ReactElement }[] = [
  { label: '文件', render: (cls) => <FilesIcon className={cls} /> },
]

export function Rail({ treeOpen, onToggleTree, onSettings }: Props) {
  return (
    <nav
      aria-label="功能导航"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface-2/40 py-2"
    >
      {ITEMS.map(({ label, render }) => {
        const on = treeOpen
        return (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={on}
            onClick={onToggleTree}
            className={[
              'relative grid size-9 place-items-center rounded-lg transition-colors',
              on
                ? 'bg-surface text-green shadow-[0_1px_2px_rgba(16,35,28,0.10)] ring-1 ring-line'
                : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
            ].join(' ')}
          >
            {on ? (
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
