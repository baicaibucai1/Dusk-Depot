/*
 * 公式快速面板：光标进到 `$…$` / `$$…$$` 里才浮出来。
 *
 * 它只做一件事：把"要背的 LaTeX 命令"变成"能点的按钮"。
 * 插入的仍然是 `\alpha` 这样的纯命令 —— 文件里不留任何专有标记，
 * 换个渲染器（KaTeX / MathJax / GitHub）照样能看。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { MATH_GROUPS, searchMath, type MathGroup } from '../core/markdown/mathPanel'

type Props = {
  /** 选了一个片段。tex 里可能带 `$0` 光标位，由调用方处理 */
  onPick: (tex: string) => void
  /** 浮层贴在编辑器里的坐标（相对编辑器容器） */
  x: number
  y: number
  /** 块公式还是行内 —— 只影响标题那句话 */
  kind: 'inline' | 'block'
  /** 点外面关掉 */
  onClose: () => void
}

export function MathPanel({ onPick, x, y, kind, onClose }: Props) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState<string>(MATH_GROUPS[0]?.id ?? 'greek')
  const box = useRef<HTMLDivElement | null>(null)

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
  const shown: MathGroup | undefined =
    groups.find((g) => g.group.id === active)?.group ?? groups[0]?.group

  return (
    <div
      ref={box}
      data-dd-math-panel
      className="absolute z-30 w-[300px] overflow-hidden rounded-xl border border-line bg-surface shadow-[0_14px_36px_-10px_rgba(16,35,28,0.3)]"
      style={{ left: Math.max(4, x), top: y }}
      // 别让点面板时编辑器丢焦点，否则每点一次光标就跳走
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex h-8 items-center gap-1.5 border-b border-line px-2.5">
        <span className="text-[11.5px] font-medium text-ink">
          公式 <span className="text-ink-3">{kind === 'block' ? '（块）' : '（行内）'}</span>
        </span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜：希腊 / 分数 / 求和"
          aria-label="搜公式片段"
          className="ml-auto h-6 w-[124px] rounded border border-line bg-surface px-1.5 text-[11.5px] text-ink outline-none focus:border-green/50"
        />
      </div>

      <div className="flex gap-1 overflow-x-auto px-2 pt-1.5 pb-1">
        {groups.map((g) => (
          <button
            key={g.group.id}
            type="button"
            onClick={() => setActive(g.group.id)}
            className={`h-[21px] shrink-0 rounded-full px-2 text-[11px] ${
              shown?.id === g.group.id
                ? 'bg-green-soft text-green-deep'
                : 'bg-surface-2 text-ink-3 hover:text-ink-2'
            }`}
          >
            {g.group.title}
          </button>
        ))}
      </div>

      <div className="max-h-[172px] overflow-y-auto px-1.5 pb-2">
        {!shown ? (
          <p className="px-2 py-5 text-center text-[11.5px] text-ink-3">没找到，换个词。</p>
        ) : (
          <div className="grid grid-cols-7 gap-1">
            {shown.items.map((it) => (
              <button
                key={it.tex}
                type="button"
                onClick={() => onPick(it.tex)}
                title={it.hint ? `${it.hint}　${it.tex}` : it.tex}
                className={`grid h-8 place-items-center rounded-md border border-transparent text-[14px] leading-none text-ink hover:border-line hover:bg-surface-2 ${
                  it.label.length > 3 ? 'col-span-2 text-[11.5px]' : ''
                }`}
              >
                {it.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-line px-2.5 py-1 text-[10.5px] text-ink-3">
        插进去的是 LaTeX 命令，不是图片 · Esc 关闭
      </div>
    </div>
  )
}
