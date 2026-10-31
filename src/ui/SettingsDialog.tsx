/*
 * 设置面板：两栏布局（左侧分组导航 + 右侧分组卡片）。
 *
 * 每行是"标题 + 一句说明 + 右侧控件"，和系统设置那种手感一致 ——
 * 一列竖着堆控件很难扫读，分行之后"改哪一项"一眼就找到。
 * 改完立刻生效，没有"保存"按钮。
 */
import { useEffect, useMemo, useState } from 'react'
import { DEFAULTS, type Settings } from './settings'

export type ShelfInfo = {
  where: string
  kind: string
  durable: boolean
  canReveal: boolean
  busy: boolean
  error: string | null
  onChange: () => void
  onReveal: () => void
  onRetry: () => void
}

type Props = {
  settings: Settings
  onChange: (s: Settings) => void
  onClose: () => void
  onReset: () => void
  /** 书架位置是设备级设置，跟仓库无关 */
  shelf?: ShelfInfo
}

type TabId = 'general' | 'look' | 'store' | 'shelf'

const NAV: { group: string; items: { id: TabId; label: string }[] }[] = [
  { group: '设置', items: [{ id: 'general', label: '通用' }] },
  { group: '功能', items: [{ id: 'look', label: '外观' }] },
  { group: '数据与安全', items: [{ id: 'store', label: '存储' }] },
  { group: '书架', items: [{ id: 'shelf', label: '存储位置' }] },
]

const SELECT =
  'h-8 min-w-[132px] cursor-pointer rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink outline-none hover:border-ink-3/40 focus:border-green/50'

function Row({
  title,
  desc,
  children,
  last,
}: {
  title: string
  desc?: string
  children?: React.ReactNode
  last?: boolean
}) {
  return (
    <div className={`flex items-center gap-4 px-4 py-3.5 ${last ? '' : 'border-b border-line/70'}`}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink">{title}</div>
        {desc ? (
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">{desc}</div>
        ) : null}
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 px-1 text-[11.5px] text-ink-3">{title}</h3>
      <div className="overflow-hidden rounded-xl border border-line bg-surface">{children}</div>
    </section>
  )
}

function Slider({
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  format: (v: number) => string
}) {
  return (
    <div className="flex w-[236px] items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--color-green)]"
      />
      <span className="w-14 shrink-0 text-right font-mono text-[11.5px] tabular-nums text-ink-2">
        {format(value)}
      </span>
    </div>
  )
}

export function SettingsDialog({ settings, onChange, onClose, onReset, shelf }: Props) {
  const [tab, setTab] = useState<TabId>('general')
  const [q, setQ] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch })

  const nav = useMemo(() => {
    const t = q.trim()
    if (!t) return NAV
    return NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.label.includes(t)) })).filter(
      (g) => g.items.length > 0,
    )
  }, [q])

  const TITLES: Record<TabId, string> = {
    general: '编辑与链接',
    look: '外观',
    store: '存储',
    shelf: '书架存储位置',
  }
  const title = TITLES[tab]

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/25 p-6">
      <div className="flex h-[600px] w-[880px] overflow-hidden rounded-2xl border border-line bg-paper shadow-[0_28px_70px_-20px_rgba(16,35,28,0.45)]">
        {/* 左：分组导航 */}
        <aside className="flex w-[228px] shrink-0 flex-col border-r border-line bg-surface/60">
          <div className="p-3">
            <label className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-ink-3 focus-within:border-green/50">
              <span aria-hidden className="text-[13px]">
                ⌕
              </span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索设置项"
                aria-label="搜索设置项"
                className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none"
              />
            </label>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {nav.map((g) => (
              <div key={g.group} className="mb-3">
                <div className="px-2 py-1 text-[10.5px] tracking-wide text-ink-3">{g.group}</div>
                {g.items.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    data-dd-tab={it.id}
                    onClick={() => setTab(it.id)}
                    className={`mb-0.5 flex h-8 w-full cursor-pointer items-center rounded-lg px-2 text-left text-[12.5px] transition-colors ${
                      tab === it.id
                        ? 'bg-surface-2 font-medium text-ink'
                        : 'text-ink-2 hover:bg-surface-2/60'
                    }`}
                  >
                    {it.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="border-t border-line p-2">
            <button
              type="button"
              onClick={onReset}
              className="h-8 w-full cursor-pointer rounded-lg text-[12px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
            >
              恢复默认
            </button>
          </div>
        </aside>

        {/* 右：分组卡片 */}
        <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="mb-4 flex items-center">
            <h2 className="text-[13px] font-medium text-ink">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭设置"
              className="ml-auto grid size-7 cursor-pointer place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink-2"
            >
              ×
            </button>
          </div>

          {tab === 'general' ? (
            <>
              <Section title="编辑">
                <Row title="编辑辅助" desc="智能提示会在敲公式和双链时浮出候选；纯文本就是不打扰。">
                  <select
                    value={settings.assist}
                    onChange={(e) => set({ assist: e.target.value as Settings['assist'] })}
                    aria-label="编辑辅助"
                    className={SELECT}
                  >
                    <option value="hints">智能提示</option>
                    <option value="plain">纯文本 md</option>
                  </select>
                </Row>
                <Row title="表格与公式的编辑方式" desc="单击只放光标，双击才打开编辑弹窗。">
                  <span className="text-[12px] text-ink-3">双击</span>
                </Row>
                <Row
                  title="纯文本模式包含什么"
                  desc="不弹任何提示；表格、公式仍按 markdown 渲染。"
                  last
                >
                  <span className="text-[12px] text-ink-3">渲染保留</span>
                </Row>
              </Section>

              <Section title="链接">
                <Row title="跳转方式" desc="编辑器里双击或按住 Ctrl 单击都能跳到目标篇。">
                  <span className="text-[12px] text-ink-3">双击 / Ctrl+单击</span>
                </Row>
                <Row title="引用到小节" desc="双链可以带 #小节，跳过去自动滚到那一节。" last>
                  <span className="text-[12px] text-ink-3">已启用</span>
                </Row>
              </Section>
            </>
          ) : null}

          {tab === 'look' ? (
            <>
              <Section title="正文">
                <Row title="字体大小" desc="只影响正文，不影响界面。">
                  <Slider
                    value={settings.fontSize}
                    min={13}
                    max={21}
                    step={1}
                    onChange={(v) => set({ fontSize: v })}
                    format={(v) => `${v}px`}
                  />
                </Row>
                <Row title="行高" desc="行与行之间的距离。">
                  <Slider
                    value={settings.lineHeight}
                    min={1.4}
                    max={2.2}
                    step={0.05}
                    onChange={(v) => set({ lineHeight: v })}
                    format={(v) => v.toFixed(2)}
                  />
                </Row>
                <Row title="段落间距">
                  <Slider
                    value={settings.paraGap}
                    min={0}
                    max={1.75}
                    step={0.05}
                    onChange={(v) => set({ paraGap: v })}
                    format={(v) => v.toFixed(2)}
                  />
                </Row>
                <Row title="正文宽度" desc="太宽不好读，46 左右比较舒服。">
                  <Slider
                    value={settings.width}
                    min={34}
                    max={62}
                    step={1}
                    onChange={(v) => set({ width: v })}
                    format={(v) => `${v}rem`}
                  />
                </Row>
                <Row title="字体" last>
                  <select
                    value={settings.font}
                    onChange={(e) => set({ font: e.target.value as Settings['font'] })}
                    aria-label="正文字体"
                    className={SELECT}
                  >
                    <option value="sans">无衬线</option>
                    <option value="serif">衬线</option>
                    <option value="custom">自定义</option>
                  </select>
                </Row>
              </Section>

              {settings.font === 'custom' ? (
                <Section title="自定义字体">
                  <Row title="字体族" desc="填 CSS font-family，例如 'LXGW WenKai', serif" last>
                    <input
                      value={settings.fontCustom}
                      onChange={(e) => set({ fontCustom: e.target.value })}
                      placeholder="'LXGW WenKai', serif"
                      aria-label="自定义字体族"
                      className="h-8 w-[236px] rounded-lg border border-line bg-surface px-2 font-mono text-[11.5px] text-ink outline-none focus:border-green/50"
                    />
                  </Row>
                </Section>
              ) : null}
            </>
          ) : null}

          {tab === 'shelf' ? (
            <>
              <Section title="书架">
                <Row
                  title="书架位置"
                  desc="电子书、书架清单（library.json）、阅读进度和书签都放在这个目录里；跟仓库完全分开，切仓库不会动它。"
                >
                  <div className="flex max-w-[300px] flex-col items-end gap-1">
                    <span className="max-w-[300px] truncate font-mono text-[11px] text-ink-2" title={shelf?.where ?? ''}>
                      {shelf?.where || '未设置'}
                    </span>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        disabled={!shelf || shelf.busy}
                        onClick={shelf?.onChange}
                        className="rounded-md border border-line px-2 py-1 text-[11.5px] text-ink-2 hover:bg-surface-2 disabled:opacity-50"
                      >
                        更换…
                      </button>
                      <button
                        type="button"
                        disabled={!shelf?.canReveal}
                        title={shelf?.canReveal ? undefined : '当前运行环境拿不到真实路径'}
                        onClick={shelf?.onReveal}
                        className="rounded-md border border-line px-2 py-1 text-[11.5px] text-ink-2 hover:bg-surface-2 disabled:opacity-40"
                      >
                        打开书架文件夹
                      </button>
                    </div>
                  </div>
                </Row>
                <Row
                  title="换位置时不会自动覆盖"
                  desc="新目录里已有书架就只能选“使用”；搬迁需要空目录，而且旧目录不会自动删。"
                  last
                >
                  <span className="text-[12px] text-ink-3">{shelf?.durable ? '磁盘目录' : '暂存（不落盘）'}</span>
                </Row>
              </Section>

              {shelf?.error ? (
                <Section title="状态">
                  <Row title="书架打不开" desc={shelf.error} last>
                    <button
                      type="button"
                      onClick={shelf.onRetry}
                      className="rounded-md border border-line px-2 py-1 text-[11.5px] text-ink-2 hover:bg-surface-2"
                    >
                      重试
                    </button>
                  </Row>
                </Section>
              ) : null}

              {!shelf?.durable ? (
                <p className="px-1 text-[11.5px] leading-relaxed text-ink-3">
                  当前是暂存模式：书和进度只在这次会话里，关掉程序就没了。桌面端默认落在应用数据目录下的
                  <span className="font-mono"> bookshelf</span>，浏览器需要你授权一个目录。
                </p>
              ) : null}
            </>
          ) : tab === 'store' ? (
            <>
              <Section title="仓库">
                <Row
                  title="文件就是唯一真相"
                  desc="程序只读你文件夹里的 .md；索引、视图、图标都是可删的投影。"
                  last
                >
                  <span className="text-[12px] text-ink-3">无需设置</span>
                </Row>
              </Section>
              <Section title="数据与安全">
                <Row title="回收站" desc="删除目前不可恢复，回收站还没做。">
                  <span className="text-[12px] text-ink-3">未实现</span>
                </Row>
                <Row title="同步" desc="不做同步、不做协同。" last>
                  <span className="text-[12px] text-ink-3">未实现</span>
                </Row>
              </Section>
              <p className="px-1 text-[11.5px] leading-relaxed text-ink-3">
                默认值：{DEFAULTS.fontSize}px · 行高 {DEFAULTS.lineHeight} · 宽 {DEFAULTS.width}rem
              </p>
            </>
          ) : null}
        </main>
      </div>
    </div>
  )
}
