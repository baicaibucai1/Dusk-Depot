/*
 * 设置面板。
 *
 * 只放**真的会影响渲染**的几项，改完立刻生效（不用"保存"按钮），
 * 面板里带一小段实时预览 —— 调字号的时候能直接看到效果，而不是关掉才知道。
 */
import { useEffect, useState } from 'react'
import { parseMarkdown } from '../core/markdown/parse'
import { BlockView } from './markdown/render'
import { DEFAULTS, type Settings } from './settings'

type Props = {
  settings: Settings
  onChange: (s: Settings) => void
  onClose: () => void
  onReset: () => void
}

const PREVIEW = `## 预览

正文长这样。**粗体**、*斜体*、\`行内码\`、[[双链]]、#标签 都在这一行里。

- 列表第一项
- 列表第二项

> 引用会有一道绿线和浅底。`

const FONT_SAMPLE: Record<Settings['font'], string> = {
  sans: '无衬线',
  serif: '衬线',
  custom: '自定义',
}

/** 常见字体，写自定义的时候点一下就填进去 */
const FONT_SUGGEST = [
  "'Microsoft YaHei', sans-serif",
  "'PingFang SC', sans-serif",
  "'SimSun', serif",
  "'KaiTi', serif",
  "'LXGW WenKai', 'KaiTi', serif",
  "'JetBrains Mono', 'Cascadia Code', monospace",
]

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-3">
      <div className="w-24 shrink-0">
        <div className="text-[13px] text-ink">{label}</div>
        {hint ? <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div> : null}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
    </div>
  )
}

function Slider({
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  value: number
  min: number
  max: number
  step: number
  suffix: string
  onChange: (v: number) => void
}) {
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-line accent-green"
      />
      <span className="w-14 shrink-0 text-right font-mono text-[12px] tabular-nums text-ink-2">
        {value}
        {suffix}
      </span>
    </>
  )
}

export function SettingsDialog({ settings, onChange, onClose, onReset }: Props) {
  const [s, setS] = useState<Settings>(settings)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const patch = (next: Partial<Settings>) => {
    const merged = { ...s, ...next }
    setS(merged)
    onChange(merged)
  }

  const blocks = parseMarkdown(PREVIEW)

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/25 p-6">
      <div
        role="dialog"
        aria-label="设置"
        className="flex max-h-[86vh] w-full max-w-[44rem] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_20px_60px_rgba(16,35,28,0.22)]"
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <span className="text-[13.5px] font-semibold">设置</span>
          <span className="text-[11.5px] text-ink-3">调整渲染效果 · 改完立刻生效</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭设置"
            className="ml-auto grid size-7 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <Row label="字号" hint="正文基准">
            <Slider
              value={s.fontSize}
              min={13}
              max={21}
              step={1}
              suffix="px"
              onChange={(v) => patch({ fontSize: v })}
            />
          </Row>

          <Row label="行距" hint="行与行之间">
            <Slider
              value={s.lineHeight}
              min={1.4}
              max={2.2}
              step={0.05}
              suffix="×"
              onChange={(v) => patch({ lineHeight: v })}
            />
          </Row>

          <Row label="段间距" hint="段与段之间">
            <Slider
              value={s.paraGap}
              min={0}
              max={1.75}
              step={0.25}
              suffix="rem"
              onChange={(v) => patch({ paraGap: v })}
            />
          </Row>

          <Row label="正文宽度" hint="一行的长度">
            <Slider
              value={s.width}
              min={34}
              max={62}
              step={2}
              suffix="rem"
              onChange={(v) => patch({ width: v })}
            />
          </Row>

          <Row label="字体">
            <div className="flex flex-wrap items-center gap-1">
              {(['sans', 'serif', 'custom'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => patch({ font: f })}
                  className={[
                    'h-7 rounded-md px-3 text-[12.5px] transition-colors',
                    s.font === f ? 'bg-surface-2 text-green' : 'text-ink-2 hover:bg-surface-2',
                  ].join(' ')}
                >
                  {FONT_SAMPLE[f]}
                </button>
              ))}
            </div>
          </Row>

          {s.font === 'custom' ? (
            <div className="-mt-1 mb-2 pl-28">
              <input
                type="text"
                value={s.fontCustom}
                onChange={(e) => patch({ fontCustom: e.target.value })}
                placeholder="'LXGW WenKai', 'KaiTi', serif"
                aria-label="自定义字体"
                className="h-8 w-full rounded-md border border-line bg-surface px-2 font-mono text-[12px] text-ink outline-none focus:border-green/50"
              />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {FONT_SUGGEST.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => patch({ fontCustom: f })}
                    style={{ fontFamily: f }}
                    className="rounded-md bg-surface-2/60 px-1.5 py-0.5 text-[11px] text-ink-2 transition-colors hover:bg-surface-2"
                  >
                    {f.split(',')[0]?.replace(/['"]/g, '')}
                  </button>
                ))}
              </div>
              {!s.fontCustom.trim() ? (
                <p className="mt-1 text-[11px] text-ink-3">留空就回到无衬线</p>
              ) : null}
            </div>
          ) : null}

          <div className="mt-2 mb-4 rounded-xl border border-line bg-paper/60 p-4">
            <div className="mb-2 text-[10.5px] tracking-wider text-ink-3 uppercase">预览</div>
            <div
              style={{
                fontSize: 'var(--dd-fs)',
                lineHeight: 'var(--dd-lh)',
                fontFamily: 'var(--dd-font)',
                maxWidth: 'var(--dd-cw)',
              }}
            >
              {blocks.map((b, i) => (
                <BlockView key={i} b={b} />
              ))}
            </div>
          </div>
        </div>

        <footer className="flex h-14 shrink-0 items-center justify-between border-t border-line px-4">
          <button
            type="button"
            onClick={() => {
              onReset()
              setS({ ...DEFAULTS })
            }}
            className="h-8 rounded-lg px-3 text-[12.5px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            恢复默认
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-lg bg-green px-3.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
          >
            完成
          </button>
        </footer>
      </div>
    </div>
  )
}
