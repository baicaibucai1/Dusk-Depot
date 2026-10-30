import type { ReactElement } from 'react'
import { Files as FilesIcon } from 'lucide-react'
import { IconSliders, IconTool } from './icons'

/*
 * 最左侧的功能导航条（48px）。
 *
 * 它只做一件事：决定**紧挨着它的那一栏**显示什么。不承载别的功能，
 * 也不放"以后会有"的按钮 —— 每个图标点下去都得真的切到一栏东西。
 *
 * 为什么又有这条轨：2026-10-26 把那时的图标轨删了，把「文件 / 工具」
 * 塞进目录栏顶部当页签；现在的桌面布局要求导航和内容分开 ——
 * 导航常驻、窄，内容栏可以被折叠/拖宽而不影响导航。
 */

export type Section = 'files' | 'tools'

type Props = {
  section: Section
  onSection: (s: Section) => void
  /** 目录栏收起时也留着导航，点一下就能再展开 */
  treeOpen: boolean
  onToggleTree: () => void
  onSettings: () => void
}

const ITEMS: { id: Section; label: string; render: (cls: string) => ReactElement }[] = [
  { id: 'files', label: '文件', render: (cls) => <FilesIcon className={cls} /> },
  { id: 'tools', label: '工具', render: (cls) => <IconTool className={cls} /> },
]

export function Rail({ section, onSection, treeOpen, onToggleTree, onSettings }: Props) {
  return (
    <nav
      aria-label="功能导航"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface-2/40 py-2"
    >
      {ITEMS.map(({ id, label, render }) => {
        const on = treeOpen && section === id
        return (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={on}
            onClick={() => {
              // 已经在这一栏且面板开着 → 再点一次收起（和 VS Code 一致）
              if (on) {
                onToggleTree()
                return
              }
              onSection(id)
              if (!treeOpen) onToggleTree()
            }}
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
