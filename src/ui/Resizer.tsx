import { useRef } from 'react'

type Props = {
  side: 'left' | 'right'
  width: number
  min: number
  max: number
  onChange: (w: number) => void
  /** 双击复位到出厂宽度 */
  onReset: () => void
  /** 贴内边缘放（父级 overflow-hidden 时，负偏移会被裁掉） */
  flush?: boolean
}

/**
 * 侧栏的拖拽把手。悬停才显形，拖动时整条变绿。
 *
 * ⚠️ 拖动过程中**只改显示、松手才落盘** —— 每动一像素写一次 localStorage
 *    会把整个文件表序列化上百遍，手感当场变糊。
 */
export function Resizer({ side, width, min, max, onChange, onReset, flush }: Props) {
  const startX = useRef(0)
  const startW = useRef(width)

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? '调整左栏宽度' : '调整右栏宽度'}
      title="拖动调整宽度，双击复位"
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        e.preventDefault()
        startX.current = e.clientX
        startW.current = width
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'

        const move = (ev: PointerEvent) => {
          const delta = side === 'left' ? ev.clientX - startX.current : startX.current - ev.clientX
          onChange(Math.min(max, Math.max(min, Math.round(startW.current + delta))))
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
      className={[
        'group absolute top-0 bottom-0 z-20 w-[5px] cursor-col-resize',
        flush ? (side === 'left' ? 'right-0' : 'left-0') : side === 'left' ? '-right-[3px]' : '-left-[3px]',
      ].join(' ')}
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-green/50" />
    </div>
  )
}
