import { useEffect, useRef } from 'react'

export type MenuItem = {
  label: string
  onSelect: () => void
  /** 危险动作（删除）单独一档 */
  danger?: boolean
  /** 一条分隔线 */
  divider?: boolean
  /** 这个环境做不了 —— 灰掉并说明原因，别给一个点了没反应的按钮 */
  disabled?: boolean
  /** 灰掉时鼠标悬停的说明 */
  reason?: string
}

type Props = { x: number; y: number; items: MenuItem[]; onClose: () => void }

const WIDTH = 184
const ITEM_H = 30

/** 贴光标的右键菜单。Esc / 点外面 / 滚动 / 失焦都关，贴边会翻转 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const height = items.length * ITEM_H + 8
  const left = Math.max(8, Math.min(x, window.innerWidth - WIDTH - 8))
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8))

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top, width: WIDTH }}
      className="fixed z-50 rounded-lg border border-line bg-surface py-1 shadow-[0_8px_24px_rgba(16,35,28,0.12)]"
    >
      {items.map((item, i) =>
        item.divider ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 分隔线没有身份
          <div key={`d${i}`} className="my-1 h-px bg-line" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            title={item.disabled ? item.reason : undefined}
            onClick={() => {
              if (item.disabled) return
              item.onSelect()
              onClose()
            }}
            className={[
              'flex h-[30px] w-full items-center px-3 text-left text-[13px] transition-colors',
              item.disabled
                ? 'cursor-not-allowed text-ink-3/60'
                : item.danger
                  ? 'text-ink hover:bg-surface-2'
                  : 'text-ink-2 hover:bg-surface-2',
            ].join(' ')}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  )
}
