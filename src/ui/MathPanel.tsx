/*
 * 公式快速面板：光标进到 `$…$` / `$$…$$` 里才浮出来。
 *
 * 只做一件事：把"要背的 LaTeX 命令"变成"能点的按钮"。
 * 插入的仍然是 `\alpha` 这样的纯命令 —— 文件里不留任何专有标记，
 * 换个渲染器（KaTeX / MathJax / GitHub）照样能看。
 *
 * 布局分两种，因为两类东西形状不一样：
 *   · 符号（希腊/运算/关系/箭头）→ 方格阵，一格一个字符
 *   · 片段（结构/整式）→ 一行一条，左边名字右边命令，塞进方格会挤成一团
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { MATH_GROUPS, searchMath, type MathItem } from '../core/markdown/mathPanel'

type Props = {
  /** 选了一个片段。tex 里可能带 `$0` 光标位，由调用方处理 */
  onPick: (tex: string) => void
  /** 浮层贴在编辑器里的坐标（相对编辑器容器） */
  x: number
  y: number
  /** 块公式还是行内 —— 只影响标题那句话 */
  kind: 'inline' | 'block'
  onClose: () => void
}

/** 方格阵适合的组：单个字符 */
const GRID_GROUPS = new Set(['greek', 'ops', 'rel', 'arrow'])

export function MathPanel({ onPick, x, y, kind, onClose }: Props) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState<string>(MATH_GROUPS[0]?.id ?? 'greek')
  const box = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const groups = useMemo(() => searchMath(q), [q])
  const shown = groups.find((g) => g.group.id === active)?.group ?? groups[0]?.group
  const isGrid = shown ? GRID_GROUPS.has(shown.id) : true

  const pick = (tex: string) => {
    onPick(tex)
    // 选完把焦点还给搜索框之外的编辑器（insertMath 里已经 focus 了），这里不清空
  }

  return (
    <div
      ref={box}
      data-dd-math-panel
      className="absolute z-30 w-[344px] overflow-hidden rounded-xl border border-line bg-surface shadow-[0_16px_40px_-12px_rgba(16,35,28,0.32)]"
      style={{ left: x, top: y }}
      // 点面板别让编辑器丢焦点，否则每点一次光标就跳走
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex h-9 items-center gap-2 border-b border-line px-3">
        <span className="text-[12.5px] font-medium text-ink">公式</span>
        <span className="rounded-full bg-surface-2 px-1.5 py-px text-[10.5px] text-ink-3">
          {kind === 'block' ? '块' : '行内'}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="ml-auto grid size-5 cursor-pointer place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink-2"
        >
          ×
        </button>
      </div>

      <div className="px-2.5 pt-2">
        <label className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-2 text-ink-3 focus-within:border-green/50">
          <span aria-hidden className="text-[12px]">
            ⌕
          </span>
          <input
            ref={input}
            data-dd-math-search
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜：希腊 / 分数 / 求和"
            aria-label="搜公式片段"
            className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none"
          />
        </label>
      </div>

      {/* 分类：换行铺开，不做成一条要横着滚的窄条 */}
      <div className="flex flex-wrap gap-1 px-2.5 pt-2 pb-1.5">
        {groups.map((g) => (
          <button
            key={g.group.id}
            type="button"
            onClick={() => setActive(g.group.id)}
            className={`h-[22px] cursor-pointer rounded-full px-2 text-[11.5px] transition-colors ${
              shown?.id === g.group.id
                ? 'bg-green-soft text-green-deep'
                : 'bg-surface-2 text-ink-3 hover:text-ink-2'
            }`}
          >
            {g.group.title}
          </button>
        ))}
      </div>

      <div className="max-h-[196px] overflow-y-auto px-2 pb-2">
        {!shown ? (
          <p className="px-2 py-6 text-center text-[12px] text-ink-3">没找到，换个词。</p>
        ) : isGrid ? (
          <div className="grid grid-cols-8 gap-1">
            {shown.items.map((it) => (
              <button
                key={it.tex}
                type="button"
                onClick={() => pick(it.tex)}
                title={it.hint ? `${it.hint}　${it.tex}` : it.tex}
                className="grid h-8 cursor-pointer place-items-center rounded-md border border-transparent text-[15px] leading-none text-ink transition-colors hover:border-line hover:bg-surface-2 active:bg-green-soft"
              >
                {it.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-0.5">
            {shown.items.map((it: MathItem) => (
              <button
                key={it.tex}
                type="button"
                onClick={() => pick(it.tex)}
                title={it.tex}
                className="flex h-[30px] w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-surface-2 active:bg-green-soft"
              >
                <span className="shrink-0 text-[12.5px] text-ink">{it.hint ?? it.label}</span>
                <span className="ml-auto truncate font-mono text-[10.5px] text-ink-3">{it.tex}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex h-6 items-center border-t border-line px-3 text-[10.5px] text-ink-3">
        插进去的是 LaTeX 命令 · Esc 关闭
      </div>
    </div>
  )
}
