/*
 * 公式编辑弹窗 —— 和表格编辑器同一套做法：居中、带遮罩、取消/应用。
 *
 * 为什么不做"跟着光标飘的小面板"：那个东西一出现就盖住正文，
 * 而且位置跟着光标乱跑，点起来也不稳。弹窗把"写公式"这件事
 * 变成一个独立动作：上面看效果，中间写命令，下面点符号，写完应用。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { MATH_GROUPS, searchMath, type MathItem } from '../core/markdown/mathPanel'
import { Math as MathView } from './Math'

type Props = {
  /** 初值（编辑已有公式时带进来），空串 = 新建 */
  initial: string
  /** 行内还是块 */
  kind: 'inline' | 'block'
  onApply: (tex: string) => void
  onCancel: () => void
}

/** 方格阵适合的组：单个字符 */
const GRID_GROUPS = new Set(['greek', 'ops', 'rel', 'arrow'])

export function MathDialog({ initial, kind, onApply, onCancel }: Props) {
  const [tex, setTex] = useState(initial)
  const [tab, setTab] = useState<string>(MATH_GROUPS[0]?.id ?? 'greek')
  const [q, setQ] = useState('')
  const area = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    area.current?.focus()
    // 新建时光标放末尾；编辑已有的全选，直接打字就换掉
    if (initial) area.current?.select()
  }, [initial])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onApply(tex)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onApply, onCancel, tex])

  const groups = useMemo(() => searchMath(q), [q])
  const shown = groups.find((g) => g.group.id === tab)?.group ?? groups[0]?.group
  const isGrid = shown ? GRID_GROUPS.has(shown.id) : true

  /** 点符号 = 插到光标处（不是追加到末尾，改一半再补符号才顺手） */
  function insert(snippet: string) {
    const el = area.current
    const at = el ? (el.selectionStart ?? tex.length) : tex.length
    const end = el ? (el.selectionEnd ?? at) : at
    // `$0` 是"插完光标停这儿"的标记
    const cut = snippet.indexOf('$0')
    const text = cut < 0 ? snippet : snippet.slice(0, cut) + snippet.slice(cut + 2)
    const next = tex.slice(0, at) + text + tex.slice(end)
    setTex(next)
    const caret = at + (cut < 0 ? text.length : cut)
    requestAnimationFrame(() => {
      const e2 = area.current
      if (!e2) return
      e2.focus()
      e2.setSelectionRange(caret, caret)
    })
  }

  return (
    <div
      data-dd-math-dialog
      className="fixed inset-0 z-50 grid place-items-center bg-ink/25 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="flex max-h-[86vh] w-[620px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_24px_60px_-16px_rgba(16,35,28,0.4)]">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
          <span className="text-[13px] font-medium text-ink">公式</span>
          <span className="rounded-full bg-surface-2 px-1.5 py-px text-[10.5px] text-ink-3">
            {kind === 'block' ? '块' : '行内'}
          </span>
          <span className="ml-auto text-[11px] text-ink-3">Ctrl+Enter 应用 · Esc 取消</span>
          <button
            type="button"
            onClick={onCancel}
            aria-label="关闭"
            className="ml-1 grid size-6 cursor-pointer place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink-2"
          >
            ×
          </button>
        </header>

        {/* 预览在上：写完先看效果，不用等应用 */}
        <div className="grid min-h-[72px] shrink-0 place-items-center overflow-x-auto border-b border-line bg-surface-2/40 px-4 py-3">
          {tex.trim() ? (
            <MathView tex={tex} block={kind === 'block'} />
          ) : (
            <span className="text-[12px] text-ink-3">下面写点 LaTeX，这里会实时显示</span>
          )}
        </div>

        <div className="shrink-0 px-4 pt-3">
          <textarea
            ref={area}
            data-dd-math-input
            value={tex}
            onChange={(e) => setTex(e.target.value)}
            spellCheck={false}
            rows={3}
            placeholder="\int_a^b f(x)\,dx = F(b) - F(a)"
            aria-label="LaTeX 源码"
            className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink outline-none focus:border-green/50"
          />
        </div>

        <div className="mt-2 flex flex-wrap gap-1 px-4">
          {groups.map((g) => (
            <button
              key={g.group.id}
              type="button"
              onClick={() => setTab(g.group.id)}
              className={`h-[22px] cursor-pointer rounded-full px-2 text-[11.5px] transition-colors ${
                shown?.id === g.group.id
                  ? 'bg-green-soft text-green-deep'
                  : 'bg-surface-2 text-ink-3 hover:text-ink-2'
              }`}
            >
              {g.group.title}
            </button>
          ))}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜符号"
            aria-label="搜公式片段"
            className="ml-auto h-[22px] w-[112px] rounded-full border border-line bg-surface px-2 text-[11px] text-ink outline-none focus:border-green/50"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {!shown ? (
            <p className="py-6 text-center text-[12px] text-ink-3">没找到，换个词。</p>
          ) : isGrid ? (
            <div className="grid grid-cols-12 gap-1">
              {shown.items.map((it) => (
                <button
                  key={it.tex}
                  type="button"
                  onClick={() => insert(it.tex)}
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
                  onClick={() => insert(it.tex)}
                  title={it.tex}
                  className="flex h-[30px] w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-surface-2 active:bg-green-soft"
                >
                  <span className="shrink-0 text-[12.5px] text-ink">{it.hint ?? it.label}</span>
                  <span className="ml-auto truncate font-mono text-[10.5px] text-ink-3">
                    {it.tex}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <footer className="flex h-14 shrink-0 items-center gap-2 border-t border-line px-4">
          <span className="mr-auto text-[11px] text-ink-3">
            插进去的是 LaTeX 命令，别的渲染器也认
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="h-8 cursor-pointer rounded-lg px-3 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-2"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onApply(tex)}
            className="h-8 cursor-pointer rounded-lg bg-green px-3.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
          >
            应用
          </button>
        </footer>
      </div>
    </div>
  )
}
