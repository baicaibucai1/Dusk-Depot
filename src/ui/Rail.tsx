import { IconNotes, IconSearch, IconSliders, IconTag } from './icons'

export type Section = 'notes' | 'search' | 'tags'

type Props = {
  section: Section
  onChange: (s: Section) => void
  /** 打开设置面板 */
  onSettings: () => void
}

const ITEMS: { id: Section; label: string; Icon: typeof IconNotes }[] = [
  { id: 'notes', label: '笔记', Icon: IconNotes },
  { id: 'search', label: '搜索', Icon: IconSearch },
  { id: 'tags', label: '标签', Icon: IconTag },
]

/** 最左边那一条。只放"去哪一栏"，不放任何操作 */
export function Rail({ section, onChange, onSettings }: Props) {
  return (
    <nav
      aria-label="主功能区"
      className="flex w-14 shrink-0 flex-col items-center gap-1 bg-paper py-3"
    >
      {ITEMS.map(({ id, label, Icon }) => {
        const active = section === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            title={label}
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            className={[
              'grid size-9 place-items-center rounded-[10px] transition-colors',
              active
                ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(16,35,28,0.10)]'
                : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
            ].join(' ')}
          >
            <Icon />
          </button>
        )
      })}

      <div className="flex-1" />

      <button
        type="button"
        onClick={onSettings}
        title="设置"
        aria-label="设置"
        className="grid size-9 place-items-center rounded-[10px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
      >
        <IconSliders />
      </button>

      <div
        className="mt-1 grid size-7 place-items-center rounded-full bg-green-bright/30 text-[10px] font-semibold text-green-deep"
        title="本机"
      >
        DD
      </div>
    </nav>
  )
}
