/*
 * 文档顶部的格式工具条。
 *
 * 只放**纯 markdown**：加粗/斜体/划掉/行内码、标题、列表、引用、表格、公式、双链、标签、链接。
 * 内嵌 HTML/CSS 那一套已经拿掉了 —— 笔记保持是"别的工具也读得懂的普通 markdown"。
 *
 * 布局：卡片居中，允许换行；整条可以收起成一个小胶囊。
 */
import { useEffect, useRef, useState } from 'react'
import { SymbolPanel } from './SymbolPanel'
import {
  IconBold,
  IconBrackets,
  IconChevron,
  IconCode,
  IconHeading,
  IconHr,
  IconItalic,
  IconLink,
  IconList,
  IconListOrdered,
  IconMathBlock,
  IconQuote,
  IconSigma,
  IconSmiley,
  IconStrike,
  IconTable,
  IconTableEdit,
  IconTag,
  IconTask,
} from './icons'

export type FormatProps = {
  onWrap: (before: string, after: string, placeholder: string) => void
  onPrefix: (prefix: string) => void
  onInsert: (text: string) => void
  /** 插一个块公式，光标落在两个 $$ 之间 */
  onMathBlock: () => void
  onHeading: (level: number | null) => void
  onInsertTable: (rows: number, cols: number) => void
  onEditTable: () => void
  canEditTable: boolean
  heading: number | null
  disabled: boolean
  /** 仓库里的笔记清单（插入链接时选目标） */
  notes: { path: string; title: string }[]
  /** 工具条是否展开 */
  open: boolean
  onToggle: () => void
}

const BTN =
  'grid size-7 shrink-0 place-items-center rounded-lg text-ink-3 transition-all duration-150 hover:bg-surface hover:text-ink hover:shadow-[0_1px_2px_rgba(16,35,28,0.08)] active:scale-90 active:bg-surface-2 disabled:pointer-events-none disabled:opacity-40'

/** 点外面 / 按 Esc 关掉的小浮层 */
function Popover({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      ref={box}
      className="absolute top-full left-0 z-40 mt-1.5 rounded-xl border border-line bg-surface p-1 shadow-[0_10px_30px_rgba(16,35,28,0.16)]"
    >
      {children}
    </div>
  )
}

const LEVELS: { level: number | null; label: string; cls: string }[] = [
  { level: null, label: '正文', cls: 'text-[13px]' },
  { level: 1, label: '一级标题', cls: 'text-[16px] font-semibold' },
  { level: 2, label: '二级标题', cls: 'text-[14.5px] font-semibold' },
  { level: 3, label: '三级标题', cls: 'text-[13.5px] font-semibold' },
  { level: 4, label: '四级标题', cls: 'text-[12.5px] font-semibold' },
]

/**
 * 链接卡片：显示字样 + 地址，两栏都填。
 *
 * 之前只有一个搜索列表 —— 点了就插 `[标题](路径)`，用户想改显示字样还得回正文里改。
 * 现在两件事都在这张卡上做完：先填字，再填地址，或者从库里挑一条自动带出来。
 *
 * 写出去的永远是标准 markdown：`[字样](地址)` —— 别的工具都认。
 */
function LinkCard({
  notes,
  onInsert,
}: {
  notes: { path: string; title: string }[]
  onInsert: (label: string, href: string) => void
}) {
  const [label, setLabel] = useState('')
  const [href, setHref] = useState('')
  const [q, setQ] = useState('')
  const key = q.trim().toLowerCase()
  const hits = key
    ? notes.filter((n) => n.title.toLowerCase().includes(key) || n.path.toLowerCase().includes(key))
    : notes

  const ready = href.trim().length > 0
  const field =
    'mb-1.5 flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 focus-within:border-green/50'
  const input = 'h-7 min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none'

  return (
    <div style={{ width: 276 }} className="p-1.5">
      <label className={field}>
        <span className="w-9 shrink-0 text-[10.5px] text-ink-3">字样</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="点开看这篇"
          aria-label="链接显示字样"
          className={input}
        />
      </label>
      <label className={field}>
        <span className="w-9 shrink-0 text-[10.5px] text-ink-3">地址</span>
        <input
          value={href}
          onChange={(e) => setHref(e.target.value)}
          placeholder="项目/周计划.md 或 https://"
          aria-label="链接地址"
          className={input}
        />
      </label>

      <div className="mt-2 mb-1 flex items-center gap-1.5">
        <span className="text-[10.5px] tracking-wide text-ink-3">从库里选</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜标题…"
          aria-label="搜索要链接的笔记"
          className="ml-auto h-6 w-[118px] rounded border border-line bg-surface px-1.5 text-[11px] text-ink outline-none focus:border-green/50"
        />
      </div>
      <div className="max-h-[132px] overflow-y-auto">
        {hits.length === 0 ? (
          <p className="px-2 py-2 text-[11.5px] text-ink-3">没有匹配的笔记</p>
        ) : (
          hits.slice(0, 40).map((n) => (
            <button
              key={n.path}
              type="button"
              onClick={() => {
                setLabel(n.title)
                setHref(n.path)
              }}
              title={n.path}
              className={`flex w-full flex-col items-start rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-2 ${
                href === n.path ? 'bg-green-soft' : ''
              }`}
            >
              <span className="max-w-full truncate text-[12px] text-ink">{n.title}</span>
              <span className="max-w-full truncate text-[10px] text-ink-3">{n.path}</span>
            </button>
          ))
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5 border-t border-line pt-1.5">
        <span className="text-[10.5px] text-ink-3">
          {ready ? `[${label || href}](${href})` : '地址填了才能插'}
        </span>
        <button
          type="button"
          disabled={!ready}
          onClick={() => onInsert(label.trim() || href.trim(), href.trim())}
          className="ml-auto h-6 rounded-md bg-green px-2.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          插入
        </button>
      </div>
    </div>
  )
}

/** 表格尺寸：6×6 的格子，划过几格就是几行几列 */
function TableSizePicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null)
  const MAX = 6

  return (
    <div className="p-1" style={{ width: 168 }}>
      <div className="mb-1.5 px-1 text-[11px] text-ink-3">
        {hover ? `${hover.r} 行 × ${hover.c} 列` : '选行列数'}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 22px)',
          gridAutoRows: '22px',
          gap: 4,
        }}
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: MAX * MAX }, (_, i) => {
          const r = Math.floor(i / MAX) + 1
          const c = (i % MAX) + 1
          const on = hover ? r <= hover.r && c <= hover.c : false
          return (
            <button
              key={i}
              type="button"
              aria-label={`${r} 行 ${c} 列`}
              onMouseEnter={() => setHover({ r, c })}
              onClick={() => onPick(r, c)}
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                border: `1px solid ${on ? 'rgba(14,155,102,0.55)' : 'var(--color-line)'}`,
                background: on ? 'rgba(14,155,102,0.22)' : 'var(--color-surface-2)',
                transition: 'background 120ms, border-color 120ms',
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

export function FormatBar(p: FormatProps) {
  const [picker, setPicker] = useState<'heading' | 'table' | 'link' | 'symbol' | null>(null)
  const close = () => setPicker(null)

  // 收起态：只留一个小胶囊
  if (!p.open) {
    return (
      <div className="flex shrink-0 justify-center border-b border-line/70 py-1">
        <button
          type="button"
          onClick={p.onToggle}
          title="展开格式工具条"
          aria-label="展开格式工具条"
          aria-expanded={false}
          data-bar="pill"
          className="flex h-[22px] items-center gap-1 rounded-full border border-line/70 bg-surface-2/45 px-2.5 text-[11px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
        >
          <IconChevron className="size-3 rotate-90" />
          格式
        </button>
      </div>
    )
  }

  const pick = (kind: 'heading' | 'table' | 'link' | 'symbol') => () =>
    setPicker((v) => (v === kind ? null : kind))

  return (
    <div className="relative flex shrink-0 justify-center border-b border-line/70 px-9 py-2">
      <div
        data-bar="card"
        className="flex w-fit max-w-full flex-wrap items-center justify-center gap-0.5 rounded-xl border border-line/70 bg-surface-2/45 px-1.5 py-1.5 shadow-[0_1px_2px_rgba(16,35,28,0.05)]"
      >
        <button type="button" disabled={p.disabled} title="加粗" aria-label="加粗" className={BTN} onClick={() => p.onWrap('**', '**', '粗体')}>
          <IconBold className="size-4" />
        </button>
        <button type="button" disabled={p.disabled} title="斜体" aria-label="斜体" className={BTN} onClick={() => p.onWrap('*', '*', '斜体')}>
          <IconItalic className="size-4" />
        </button>
        <button type="button" disabled={p.disabled} title="划掉" aria-label="划掉" className={BTN} onClick={() => p.onWrap('~~', '~~', '删除')}>
          <IconStrike className="size-4" />
        </button>
        <button type="button" disabled={p.disabled} title="行内代码" aria-label="行内代码" className={BTN} onClick={() => p.onWrap('`', '`', '代码')}>
          <IconCode className="size-4" />
        </button>

        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 rounded-full bg-line" />

        <div className="relative">
          <button
            type="button"
            disabled={p.disabled}
            title="标题级别"
            aria-label="标题级别"
            aria-expanded={picker === 'heading'}
            onClick={pick('heading')}
            className={[BTN, p.heading ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(16,35,28,0.08)]' : ''].join(' ')}
          >
            <IconHeading className="size-4" />
            {p.heading ? (
              <span className="absolute right-0.5 bottom-0.5 text-[8px] leading-none font-bold text-green">
                {p.heading}
              </span>
            ) : null}
          </button>

          <Popover open={picker === 'heading'} onClose={close}>
            <div className="w-40">
              {LEVELS.map((l) => (
                <button
                  key={String(l.level)}
                  type="button"
                  onClick={() => {
                    p.onHeading(l.level)
                    close()
                  }}
                  className={[
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2',
                    l.cls,
                    p.heading === l.level ? 'bg-surface-2 text-green' : 'text-ink-2',
                  ].join(' ')}
                >
                  {l.label}
                  <span className="ml-auto text-[10.5px] font-normal text-ink-3">
                    {l.level ? `H${l.level}` : '—'}
                  </span>
                </button>
              ))}
            </div>
          </Popover>
        </div>

        <button type="button" disabled={p.disabled} title="无序列表" aria-label="无序列表" className={BTN} onClick={() => p.onPrefix('- ')}>
          <IconList className="size-4" />
        </button>
        <button type="button" disabled={p.disabled} title="有序列表" aria-label="有序列表" className={BTN} onClick={() => p.onPrefix('1. ')}>
          <IconListOrdered className="size-4" />
        </button>
        <button type="button" disabled={p.disabled} title="任务列表" aria-label="任务列表" className={BTN} onClick={() => p.onPrefix('- [ ] ')}>
          <IconTask className="size-4" />
        </button>
        <button type="button" disabled={p.disabled} title="引用" aria-label="引用" className={BTN} onClick={() => p.onPrefix('> ')}>
          <IconQuote className="size-4" />
        </button>
        <button type="button" disabled={p.disabled} title="分割线" aria-label="分割线" className={BTN} onClick={() => p.onInsert('\n---\n')}>
          <IconHr className="size-4" />
        </button>

        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 rounded-full bg-line" />

        <div className="relative">
          <button
            type="button"
            disabled={p.disabled}
            title="插入表格（选行列数）"
            aria-label="插入表格"
            aria-expanded={picker === 'table'}
            onClick={pick('table')}
            className={BTN}
          >
            <IconTable className="size-4" />
          </button>

          <Popover open={picker === 'table'} onClose={close}>
            <TableSizePicker
              onPick={(rows, cols) => {
                p.onInsertTable(rows, cols)
                close()
              }}
            />
          </Popover>
        </div>

        <button
          type="button"
          disabled={p.disabled || !p.canEditTable}
          title={p.canEditTable ? '编辑这张表格' : '光标不在表格里'}
          aria-label="编辑表格"
          onClick={p.onEditTable}
          className={BTN}
        >
          <IconTableEdit className="size-4" />
        </button>

        <button type="button" disabled={p.disabled} title="行内公式" aria-label="行内公式" className={BTN} onClick={() => p.onWrap('$', '$', 'E=mc^2')}>
          <IconSigma className="size-4" />
        </button>
        <button type="button" disabled={p.disabled} title="块级公式（光标会停在公式里）" aria-label="块级公式" className={BTN} onClick={() => p.onMathBlock()}>
          <IconMathBlock className="size-4" />
        </button>

        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 rounded-full bg-line" />

        <div className="relative">
          <button
            type="button"
            disabled={p.disabled}
            title="插入链接（标准 markdown）"
            aria-label="插入链接"
            aria-expanded={picker === 'link'}
            onClick={pick('link')}
            className={BTN}
          >
            <IconBrackets className="size-4" />
          </button>

          <Popover open={picker === 'link'} onClose={close}>
            <LinkCard
              notes={p.notes}
              onInsert={(label, href) => {
                p.onInsert(`[${label}](${href})`)
                close()
              }}
            />
          </Popover>
        </div>
        <button type="button" disabled={p.disabled} title="标签" aria-label="标签" className={BTN} onClick={() => p.onWrap('#', '', '标签')}>
          <IconTag className="size-4" />
        </button>
        <button type="button" disabled={p.disabled} title="链接" aria-label="链接" className={BTN} onClick={() => p.onWrap('[', '](https://)', '文字')}>
          <IconLink className="size-4" />
        </button>

        <div className="relative">
          <button
            type="button"
            disabled={p.disabled}
            title="插入符号"
            aria-label="插入符号"
            aria-expanded={picker === 'symbol'}
            onClick={pick('symbol')}
            className={BTN}
          >
            <IconSmiley className="size-4" />
          </button>

          <Popover open={picker === 'symbol'} onClose={close}>
            <SymbolPanel
              onClose={close}
              onPick={(ch) => {
                p.onInsert(ch)
                close()
              }}
            />
          </Popover>
        </div>
      </div>

      {/* 收起按钮固定贴在右边缘，卡片换行时它不会跟着乱跑 */}
      <button
        type="button"
        onClick={p.onToggle}
        title="收起格式工具条"
        aria-label="收起格式工具条"
        aria-expanded={true}
        className={[BTN, 'absolute top-1/2 right-2 -translate-y-1/2'].join(' ')}
      >
        <IconChevron className="size-3.5 -rotate-90" />
      </button>
    </div>
  )
}
