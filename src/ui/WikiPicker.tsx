/*
 * 双链提示：输到 `[[` 就贴着光标浮出来，接着打就过滤。
 *
 * 和公式面板同一套做法（自己画浮层），理由写在 core/markdown/linkComplete.ts 顶上。
 * 这个组件只管画，选哪条由 CodeEditor 的键盘处理决定 —— 上下键/回车要能穿透
 * 到编辑器，所以这里不接管键盘。
 */
import type { WikiItem } from '../core/markdown/linkComplete'

type Props = {
  items: WikiItem[]
  /** 当前高亮的第几条（键盘上下键改它） */
  active: number
  x: number
  y: number
  onPick: (item: WikiItem) => void
  /** 鼠标划过就把它设成高亮，免得键鼠各指一条 */
  onHover: (index: number) => void
}

export function WikiPicker({ items, active, x, y, onPick, onHover }: Props) {
  return (
    <div
      data-dd-linkpicker
      className="absolute z-30 w-[268px] overflow-hidden rounded-xl border border-line bg-surface shadow-[0_14px_36px_-10px_rgba(16,35,28,0.3)]"
      style={{ left: Math.max(4, x), top: y }}
      // 点面板别抢焦点，否则光标一移，提示就自己关了
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex h-7 items-center gap-1.5 border-b border-line px-2.5 text-[10.5px] text-ink-3">
        <span className="font-medium text-ink-2">引用</span>
        <span className="ml-auto">↑↓ 选 · 回车插入 · Esc 关</span>
      </div>
      <div className="max-h-[196px] overflow-y-auto p-1">
        {items.map((it, i) => (
          <button
            key={it.insert}
            type="button"
            data-dd-linkitem={it.insert}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(it)}
            className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left ${
              i === active ? 'bg-green-soft' : 'hover:bg-surface-2'
            }`}
          >
            <span
              className={`truncate text-[12.5px] ${
                i === active ? 'text-green-deep' : 'text-ink'
              }`}
            >
              {it.label}
            </span>
            <span className="ml-auto shrink-0 truncate text-[10px] text-ink-3">{it.detail}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
