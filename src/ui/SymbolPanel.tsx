/*
 * 符号面板：给人挑 emoji 用的那一层。
 *
 * 两处共用同一个组件：
 *   ① 写正文时插一个符号（工具条上的笑脸）
 *   ② 给文件夹换图标（右键 → 设置图标）
 *
 * 为什么不做成"输入 :rocket: 自动替换"：那要求用户记住短码，而这一层是给
 * 不记短码的人用的。要短码是另一件事，别混在一起。
 */
import { useEffect, useRef, useState } from 'react'
import { CATEGORIES, SYMBOLS, searchSymbols, withRecent } from '../core/model/symbols'

const RECENT_KEY = 'dusk.sym.recent'

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    // 存储被禁就只是记不住，不影响用
  }
}

type Props = {
  onPick: (ch: string) => void
  onClose: () => void
  /** 面板顶部那句话，比如「素材 的图标」 */
  title?: string
  /** 当前已选的那个，标出来 */
  current?: string | null
}

export function SymbolPanel({ onPick, onClose, title, current }: Props) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<string>('')
  const [recent, setRecent] = useState<string[]>(() => loadRecent())
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    input.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const hits = searchSymbols(
    cat ? SYMBOLS.filter((s) => s.cat === cat) : SYMBOLS,
    q,
  )

  const pick = (ch: string) => {
    const next = withRecent(recent, ch)
    setRecent(next)
    saveRecent(next)
    onPick(ch)
  }

  return (
    <div
      data-dd-symbols
      className="w-[326px] overflow-hidden rounded-xl border border-line bg-surface shadow-[0_16px_40px_-12px_rgba(16,35,28,0.28)]"
    >
      <div className="flex h-9 items-center gap-2 border-b border-line px-3">
        <span className="text-[12px] font-medium text-ink">{title ?? '符号'}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="ml-auto grid size-5 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink-2"
        >
          ×
        </button>
      </div>

      <label className="mx-2.5 mt-2 flex h-8 items-center gap-1.5 rounded-lg border border-line px-2 text-ink-3">
        <span aria-hidden className="text-[13px]">
          ⌕
        </span>
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜符号：箭 / 星 / 完成 / 提醒"
          aria-label="搜符号"
          className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none"
        />
      </label>

      <div className="flex gap-1 overflow-x-auto px-2.5 pt-2 pb-1.5">
        <button
          type="button"
          onClick={() => setCat('')}
          className={`h-[22px] shrink-0 rounded-full px-2 text-[11.5px] ${
            cat === '' ? 'bg-green-soft text-green-deep' : 'bg-surface-2 text-ink-3 hover:text-ink-2'
          }`}
        >
          全部
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCat(c)}
            className={`h-[22px] shrink-0 rounded-full px-2 text-[11.5px] ${
              cat === c ? 'bg-green-soft text-green-deep' : 'bg-surface-2 text-ink-3 hover:text-ink-2'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="max-h-[286px] overflow-y-auto px-1.5 pb-2">
        {!q && cat === '' && recent.length > 0 ? (
          <>
            <div className="px-1.5 pt-1 pb-1 text-[10.5px] tracking-wide text-ink-3">最近用过</div>
            <div className="grid grid-cols-9 gap-0.5">
              {recent.map((ch) => (
                <button
                  key={`r-${ch}`}
                  type="button"
                  onClick={() => pick(ch)}
                  title={ch}
                  className="grid h-7 place-items-center rounded-md text-[16px] leading-none hover:bg-surface-2 active:bg-green-soft"
                >
                  {ch}
                </button>
              ))}
            </div>
            <div className="mt-1.5 mb-1 h-px bg-line" />
          </>
        ) : null}

        {hits.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-ink-3">没有匹配的符号，换个词试试。</p>
        ) : (
          <div className="grid grid-cols-9 gap-0.5 pt-1">
            {hits.map((s) => (
              <button
                key={`${s.cat}-${s.ch}`}
                type="button"
                onClick={() => pick(s.ch)}
                title={`${s.name}（${s.cat}）`}
                className={`grid h-7 place-items-center rounded-md text-[16px] leading-none hover:bg-surface-2 active:bg-green-soft ${
                  current === s.ch ? 'bg-green-soft ring-1 ring-green/40' : ''
                }`}
              >
                {s.ch}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-line px-3 py-1.5 text-[10.5px] text-ink-3">
        存进正文的是字符本身；同一个 emoji 在各系统上画得略不同，属正常
      </div>
    </div>
  )
}
