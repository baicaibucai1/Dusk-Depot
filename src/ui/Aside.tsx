import { useState } from 'react'
import type { ReactNode } from 'react'
import type { FileMap } from '../core/model/library'
import { backlinksOf, outgoingLinksOf, pendingLinksOf } from '../core/markdown/links'
import { outlineOf } from '../core/markdown/parse'
import { IconFile, IconLink, IconPanelClose, IconPlus } from './icons'

type Props = {
  files: FileMap
  path: string
  /** `.note` 的大纲由块编辑器提供（md 的从正文解析） */
  noteOutline?: { level: number; text: string }[]
  onClose: () => void
  onOpen: (path: string) => void
  /** 展开还是收起。收起时宽度收到 0，中央区平滑获得空间（不覆盖内容） */
  open: boolean
  /** 宽度由 App 管（可拖动） */
  width: number
  /** 拖拽把手，由 App 传进来贴在这一栏的左边缘 */
  resizer?: ReactNode
}

type Tab = 'outline' | 'relations'

const TABS: { id: Tab; label: string }[] = [
  { id: 'outline', label: '大纲' },
  { id: 'relations', label: '关系' },
]

/** 右侧边栏：这一栏是"关于这篇的旁注"，不是另一套功能入口 */
export function Aside({ files, path, noteOutline, onClose, onOpen, open, width, resizer }: Props) {
  const [tab, setTab] = useState<Tab>('outline')

  const text = files[path] ?? ''
  const outline = noteOutline ?? outlineOf(text)
  const backlinks = backlinksOf(files, path)
  const pending = pendingLinksOf(files, path)
  const outgoing = outgoingLinksOf(files, path)

  return (
    <aside
      aria-label="大纲与关系"
      aria-hidden={!open}
      style={{ width: open ? width : 0 }}
      className={[
        'relative flex shrink-0 overflow-hidden bg-surface transition-[width] duration-200 ease-out',
        open ? 'border-l border-line' : 'pointer-events-none',
      ].join(' ')}
    >
      {/* 内层保持固定宽度：收放时内容不跟着重排，展开后就是原来的样子 */}
      <div style={{ width }} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-0.5 border-b border-line px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={[
              'rounded-md px-2.5 py-1 text-[12.5px] transition-colors',
              tab === t.id
                ? 'bg-surface-2 font-medium text-ink'
                : 'text-ink-3 hover:text-ink-2',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭右栏"
          className="ml-auto grid size-7 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
        >
          <IconPanelClose className="size-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {tab === 'outline' ? (
          outline.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-ink-3">这一篇还没有标题。</p>
          ) : (
            <ul className="space-y-0.5">
              {outline.map((o, i) => (
                <li key={`${o.text}-${i}`}>
                  <button
                    type="button"
                    className={[
                      'w-full truncate rounded-md py-1 pr-2 text-left text-[12.5px] transition-colors hover:bg-surface-2',
                      o.level === 1 ? 'pl-2 font-medium text-ink' : 'text-ink-2',
                      o.level === 2 ? 'pl-5' : '',
                      o.level >= 3 ? 'pl-8' : '',
                    ].join(' ')}
                  >
                    {o.text}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="space-y-5 px-1 py-1" data-dd-relations>
            <section data-dd-outgoing>
              <h3 className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium tracking-wide text-ink-3">
                <IconLink className="size-3.5" />
                这篇指向的
                <span className="ml-auto tabular-nums">{outgoing.length}</span>
              </h3>
              {outgoing.length === 0 ? (
                <p className="px-2 py-1 text-[11.5px] text-ink-3">这篇没有指向别的篇。</p>
              ) : (
                <ul className="space-y-0.5">
                  {outgoing.map((r) => (
                    <li key={r.href}>
                      {r.target ? (
                        <button
                          type="button"
                          onClick={() => onOpen(r.target as string)}
                          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] text-ink transition-colors hover:bg-surface-2"
                          title={r.target}
                        >
                          <IconFile className="size-3.5 shrink-0 text-ink-3" />
                          <span className="truncate">{r.target}</span>
                        </button>
                      ) : (
                        <span
                          className="flex items-center gap-1.5 px-2 py-1 text-[12.5px] text-ink-3"
                          title={r.href}
                        >
                          <span className="size-1.5 shrink-0 rounded-full border border-dashed border-ink-3" />
                          <span className="truncate">{r.href}</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium tracking-wide text-ink-3">
                <IconLink className="size-3.5" />
                引用这篇的
                <span className="ml-auto tabular-nums">{backlinks.length}</span>
              </h3>
              {backlinks.length === 0 ? (
                <p className="px-2 py-1 text-[11.5px] text-ink-3">还没有别的篇引用它。</p>
              ) : (
                <ul className="space-y-1">
                  {backlinks.map((r) => (
                    <li key={r.path}>
                      <button
                        type="button"
                        onClick={() => onOpen(r.path)}
                        className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
                      >
                        <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
                          <IconFile className="size-3.5 shrink-0 text-ink-3" />
                          <span className="truncate">{r.path}</span>
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-relaxed text-ink-3">
                          {r.quote}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium tracking-wide text-ink-3">
                <IconPlus className="size-3.5" />
                指向了还没建的
                <span className="ml-auto tabular-nums">{pending.length}</span>
              </h3>
              {pending.length === 0 ? (
                <p className="px-2 py-1 text-[11.5px] text-ink-3">没有悬空的链接。</p>
              ) : (
                <ul className="space-y-0.5">
                  {pending.map((p) => (
                    <li
                      key={p}
                      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-ink-2"
                    >
                      <span className="size-1.5 shrink-0 rounded-full border border-dashed border-ink-3" />
                      <span className="truncate">{p}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
      </div>
      {open ? resizer : null}
    </aside>
  )
}
