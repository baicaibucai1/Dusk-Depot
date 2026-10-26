/*
 * 分栏之间的分隔条。拖动改两栏的宽度比例，双击均分。
 *
 * ⚠️ 跟侧栏那个 Resizer 是两回事：侧栏存**像素**，分栏存**比例**（flex-grow）。
 *    比例的好处是窗口一变宽，几栏一起按比例长，不会有一栏被挤死。
 */
type Props = {
  /** 拖动开始：调用方在这里记一份起始比例 */
  onStart: () => void
  /** 相对按下位置的横向位移（px） */
  onDelta: (dx: number) => void
  onEnd: () => void
  /** 双击：这一组均分 */
  onReset: () => void
}

export function PaneDivider({ onStart, onDelta, onEnd, onReset }: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整分栏宽度"
      title="拖动调整宽度，双击均分"
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        e.preventDefault()
        const x0 = e.clientX
        onStart()
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'

        const move = (ev: PointerEvent) => onDelta(ev.clientX - x0)
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          onEnd()
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
      className="group relative w-[5px] shrink-0 cursor-col-resize bg-line/60 transition-colors hover:bg-green/40"
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-green/60" />
    </div>
  )
}
