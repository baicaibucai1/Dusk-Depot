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
  onClose: () => void
}

export function WikiPicker({ items, active, x, y, onPick, onHover, onClose }: Props) {
  return (
    <div
      data-dd-linkpicker
      className="absolute z-30 w-[300px] overflow-hidden rounded-xl border border-line bg-surface shadow-[0_16px_40px_-12px_rgba(16,35,28,0.32)]"
      style={{ left: x, top: y }}
      // 点面板别抢焦点，否则光标一移，提示就自己关了
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex h-8 items-center gap-2 border-b border-line px-3">
        <span className="text-[12px] font-medium text-ink">引用到…</span>
        <span className="text-[10.5px] text-ink-3">↑↓ 选 · 回车插入</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="ml-auto grid size-5 cursor-pointer place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink-2"
        >
          ×
        </button>
      </div>

      <div className="max-h-[214px] overflow-y-auto p-1.5">
        {items.map((it, i) => (
          <button
            key={it.insert}
            type="button"
            data-dd-linkitem={it.insert}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(it)}
            className={`relative flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left transition-colors ${
              i === active ? 'bg-green-soft' : 'hover:bg-surface-2'
            }`}
          >
            {/* 选中那条左边一道绿 —— 光靠底色在浅色屏上不够明显 */}
            <span
              aria-hidden
              className={`absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full transition-opacity ${
                i === active ? 'bg-green opacity-100' : 'opacity-0'
              }`}
            />
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={`shrink-0 ${i === active ? 'text-green' : 'text-ink-3'} opacity-70`}
            >
              <path d="M6.5 9.5 9.5 6.5" />
              <path d="M9.8 4.2l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1" />
              <path d="M6.2 11.8l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1" />
            </svg>
            <span
              className={`truncate text-[12.5px] ${
                i === active ? 'font-medium text-green-deep' : 'text-ink'
              }`}
            >
              {it.label}
            </span>
            <span className="ml-auto shrink-0 truncate pl-2 text-[10.5px] text-ink-3">
              {it.detail}
            </span>
          </button>
        ))}
      </div>

      <div className="flex h-6 items-center border-t border-line px-3 text-[10.5px] text-ink-3">
        选完插成 <span className="ml-1 font-mono">[[路径]]</span>
      </div>
    </div>
  )
}
