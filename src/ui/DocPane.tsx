import { Suspense, lazy, useEffect, useId, useRef, useState } from 'react'
import { parseMarkdown, plainText } from '../core/markdown/parse'
import type { Align } from '../core/markdown/parse'
import {
  ATTACH_DIR,
  attachName,
  attachPath,
  isImageName,
  imageRefs,
} from '../core/model/attach'
import type { Host } from '../core/ports/host'
import { hasImage, putImage } from './markdown/imageStore'
import { labelOf, nameOf } from '../core/model/path'
import { FormatBar } from './FormatBar'
import { emptyTable, buildTable } from '../core/markdown/table'
/** 块编辑器和 TipTap 一起懒加载 —— 首屏不该为它付钱 */
const NoteEditor = lazy(() =>
  import('./NoteEditor').then((m) => ({ default: m.NoteEditor })),
)
import { TableEditor } from './TableEditor'
import { BlockView, JumpContext, TaskContext, type JumpKind } from './markdown/render'
import { LinkDialog } from './LinkDialog'
import { MathDialog } from './MathDialog'
import type { EditorContext } from './editor/CodeEditor'
import type { EditorHandle } from './editor/CodeEditor'
import { IconBook, IconCode, IconPanelRight, IconPen, IconSplit } from './icons'

/*
 * 编辑器带着 CodeMirror（压缩后 400KB 上下），而首屏真正需要的只有外框和文件树。
 * 所以它必须待在这条懒加载边界后面 —— 壳先画出来，编辑器到了再顶上去。
 */
const CodeEditor = lazy(() =>
  import('./editor/CodeEditor').then((m) => ({ default: m.CodeEditor })),
)

type Mode = 'read' | 'preview' | 'source'

type Props = {
  /** 这一栏里打开着的标签页（文件路径），按打开顺序 */
  tabs: string[]
  active: string | null
  /** 这一栏是不是当前焦点栏 —— 左栏点文件时开的就是它 */
  focused: boolean
  /** 点进这一栏的任何地方都算"认领焦点" */
  onFocus: () => void
  text: string
  /** 编辑时带上路径 —— 几个栏各改各的 */
  onChange: (path: string, text: string) => void
  onSelectTab: (path: string) => void
  onCloseTab: (path: string) => void
  /** 把这一栏一分为二 */
  onSplit: () => void
  /** 只有一个栏时不给关 */
  onClosePane: (() => void) | null
  /** 只有最右那一栏画右栏开关 */
  aside: { open: boolean; toggle: () => void } | null
  /** 图床要往仓库里写图片，所以需要宿主 */
  host: Host
  /** 双击双链 / 链接时跳过去 */
  onJump: (target: string, kind: JumpKind) => void
  /** 打开后要滚到哪个小节（`[[某篇#小节]]`） */
  anchor: string | null
  onAnchorDone: () => void
  /** 双链选择器要的清单 */
  notes: { path: string; title: string }[]
  /** `[[` 提示要的清单：每篇带自己的小节 */
  linkTargets?: { path: string; title: string; headings: string[] }[]
  /** 当前文档是不是 `.note`（是的话用块编辑器，不用 markdown 编辑器） */
  noteDir: string | null
  /** 块编辑器把大纲/正文报给上层（右栏要用） */
  onNoteInfo?: (dir: string, info: import('./NoteEditor').NoteInfo) => void
}

/* 三档，照 Obsidian 那套：阅读（不可编辑）／编写（实时预览）／原代码（不渲染） */
const MODES: { id: Mode; label: string; Icon: typeof IconBook }[] = [
  { id: 'read', label: '阅读', Icon: IconBook },
  { id: 'preview', label: '编写', Icon: IconPen },
  { id: 'source', label: '原代码', Icon: IconCode },
]

export function DocPane({
  tabs,
  active,
  focused,
  onFocus,
  text,
  onChange,
  onSelectTab,
  onCloseTab,
  onSplit,
  onClosePane,
  aside,
  host,
  onJump,
  anchor,
  onAnchorDone,
  notes,
  linkTargets,
  noteDir,
  onNoteInfo,
}: Props) {
  // 允许用 ?mode=read|preview|source 直接开在某一档 —— 分享链接和截图验证都用得上
  const [mode, setMode] = useState<Mode>(() => {
    const m = new URLSearchParams(location.search).get('mode')
    return m === 'read' || m === 'source' || m === 'preview' ? m : 'preview'
  })

  /** 顶上那排格式化按钮靠它去动光标/选区 */
  const editorRef = useRef<EditorHandle | null>(null)

  /** 图片加载完成后用来触发一次重渲染（值本身只是计数器） */
  const [imgTick, setImgTick] = useState(0)

  /**
   * 预加载这篇里引用的图片：仓库里是字节，得读出来换成 Blob URL 才能显示。
   * 找不到就当这条引用是坏的 —— 正文不变，只是图片位置显示占位。
   */
  useEffect(() => {
    if (!active) return
    const refs = imageRefs(text).filter((p) => !hasImage(p))
    if (refs.length === 0) return

    let alive = true
    void (async () => {
      let added = false
      for (const p of refs) {
        try {
          const bytes = await host.read(p)
          if (!alive) return
          putImage(p, URL.createObjectURL(new Blob([bytes.buffer.slice(0) as ArrayBuffer])))
          added = true
        } catch {
          // 图不在仓库里：留着占位，不打扰
        }
      }
      if (alive && added) {
        setImgTick((n) => n + 1)
        // 编写模式里的图片是 widget，得让编辑器重算一次才会画出来
        editorRef.current?.refresh()
      }
    })()
    return () => {
      alive = false
    }
  }, [host, active, text])

  /** 把图片写进图床，返回它的仓库相对路径 */
  async function storeImage(file: File): Promise<string | null> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const path = attachPath(attachName(file.name || 'image', file.type || 'image/png'))
      await host.mkdir(ATTACH_DIR)
      await host.write(path, bytes)
      putImage(path, URL.createObjectURL(new Blob([bytes.buffer.slice(0) as ArrayBuffer], { type: file.type || 'image/png' })))
      return path
    } catch (e) {
      console.warn('[dusk] 图片存不进图床', e)
      return null
    }
  }

  /** 粘贴 / 拖入的图片：存进图床，并在光标处插入 `![]()` 引用 */
  async function takeFiles(files: File[]): Promise<boolean> {
    const images = files.filter((f) => f.type.startsWith('image/') || isImageName(f.name))
    if (images.length === 0) return false

    for (const f of images) {
      const path = await storeImage(f)
      // 单独占一行：`![](…)` 黏在标题后面会把标题弄坏
      if (path) editorRef.current?.insert(`\n![](${path})\n`)
    }
    return true
  }

  /** 打开 [[某篇#小节]] 之后滚到那个标题 */
  useEffect(() => {
    if (!anchor) return
    const root = document.querySelector('[data-dd-doc]')
    if (!root) return
    const heads = [...root.querySelectorAll('h1,h2,h3,h4')]
    const hit = heads.find((h) => (h.textContent ?? '').trim() === anchor)
    hit?.scrollIntoView({ block: 'start' })
    onAnchorDone()
  }, [anchor, active, onAnchorDone])

  /** 格式工具条收没收起（记在本地，切笔记也保持） */
  const [barOpen, setBarOpen] = useState(() => {
    try {
      return localStorage.getItem('dusk.bar.v1') !== '0'
    } catch {
      return true
    }
  })
  const toggleBar = () =>
    setBarOpen((v) => {
      const next = !v
      try {
        localStorage.setItem('dusk.bar.v1', next ? '1' : '0')
      } catch {
        /* 存不了就算了 */
      }
      return next
    })

  /** 光标上下文：在不在表格里、当前是几级标题 */
  const [ctx, setCtx] = useState<EditorContext>({ inTable: false, heading: null })
  /** 正在编辑的表格（null = 没打开编辑器）。align 按列，保存时原样写回 */
  const [tableDraft, setTableDraft] = useState<{ from: number; to: number; cells: string[][]; align: Align[] } | null>(null)
  /** 公式弹窗：initial 为空 = 新建；带 range = 改已有的那一块 */
  const [mathDlg, setMathDlg] = useState<{
    initial: string
    kind: 'inline' | 'block'
    range: { from: number; to: number } | null
  } | null>(null)
  /** 引用弹窗 */
  const [linkDlg, setLinkDlg] = useState(false)

  /**
   * 笔记里写的 CSS 只该作用于**这一篇**。每栏一个唯一标记，
   * 注入前把每条选择器都加上这个前缀 —— 否则 `p{color:red}` 会把整个应用染红。
   */
  const scopeId = useId()

  return (
    <main
      // 点这一栏的任何地方都认领焦点 —— 之后左栏点文件就开在这一栏
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
      data-pane-active={focused ? 'true' : undefined}
      data-active-path={active ?? ''}
      className="relative flex min-w-0 flex-1 flex-col bg-surface"
    >
      <header
        className={[
          'flex h-10 shrink-0 items-stretch',
          // 焦点栏的抬头条下面加一道绿：一眼看出"左栏点文件会开在哪儿"
          focused ? 'border-b-2 border-green/50' : 'border-b border-line',
        ].join(' ')}
      >
        <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-2 pt-1.5">
          {tabs.length === 0 ? (
            <span className="px-2 pb-2 text-[12.5px] text-ink-3">没有打开的笔记</span>
          ) : (
            tabs.map((p) => {
              const on = p === active
              return (
                <div
                  key={p}
                  className={[
                    'group flex h-[30px] shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2.5 text-[12.5px] transition-colors',
                    on
                      ? 'border-line bg-surface text-ink'
                      : 'border-transparent text-ink-3 hover:bg-surface-2 hover:text-ink-2',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    onClick={() => onSelectTab(p)}
                    title={p}
                    className="max-w-[11rem] truncate"
                  >
                    {labelOf(p)}
                  </button>
                  <button
                    type="button"
                    onClick={() => onCloseTab(p)}
                    aria-label={`关闭 ${nameOf(p)}`}
                    className="-mr-1 grid size-4 place-items-center rounded text-ink-3/70 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface-2 hover:text-ink-2"
                  >
                    <span className="text-[13px] leading-none">×</span>
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 px-2">
          <button
            type="button"
            onClick={onSplit}
            title="向右拆分这一栏"
            aria-label="向右拆分这一栏"
            className="grid size-7 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
          >
            <IconSplit className="size-4" />
          </button>

          {onClosePane ? (
            <button
              type="button"
              onClick={onClosePane}
              title="关掉这一栏"
              aria-label="关掉这一栏"
              className="grid size-7 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
            >
              <span className="text-[15px] leading-none">×</span>
            </button>
          ) : null}

          {aside ? (
            <button
              type="button"
              onClick={aside.toggle}
              aria-label={aside.open ? '收起右栏' : '展开右栏'}
              aria-pressed={aside.open}
              className={[
                'grid size-7 place-items-center rounded-md transition-colors',
                aside.open
                  ? 'bg-surface-2 text-ink-2'
                  : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2',
              ].join(' ')}
            >
              <IconPanelRight className="size-4" />
            </button>
          ) : null}
        </div>
      </header>

      {/* 格式化工具条：正文顶上那一排。阅读模式里没有 —— 那儿不可编辑 */}
      {active && mode !== 'read' && !noteDir ? (
        <FormatBar
          disabled={!active}
          open={barOpen}
          onToggle={toggleBar}
          heading={ctx.heading}
          canEditTable={ctx.inTable}
          onWrap={(before, after, placeholder) =>
            editorRef.current?.wrap(before, after, placeholder)
          }
          onPrefix={(prefix) => editorRef.current?.linePrefix(prefix)}
          onInsert={(text) => editorRef.current?.insert(text)}
          onMathDialog={() => setMathDlg({ initial: '', kind: 'block', range: null })}
          onLinkDialog={() => setLinkDlg(true)}
          onHeading={(level) => editorRef.current?.setHeading(level)}
          onInsertTable={(rows, cols) => {
            const table = buildTable(emptyTable(Math.max(0, rows - 1), cols))
            editorRef.current?.insert(`\n${table}\n`)
          }}
          notes={notes}
          onEditTable={() => {
            const found = editorRef.current?.tableAtCursor()
            if (found) setTableDraft(found)
          }}
        />
      ) : null}

      {noteDir ? (
        <Suspense fallback={null}>
          <NoteEditor host={host} dir={noteDir} onInfo={onNoteInfo} />
        </Suspense>
      ) : null}

      <div
        className={noteDir ? 'hidden' : 'min-h-0 flex-1'}
        onPasteCapture={(e) => {
          const files = Array.from(e.clipboardData?.files ?? [])
          if (files.length === 0) return
          void takeFiles(files).then((handled) => {
            if (handled) {
              e.preventDefault()
              e.stopPropagation()
            }
          })
        }}
        onDragOver={(e) => {
          if (e.dataTransfer?.types.includes('Files')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer?.files ?? [])
          if (files.length === 0) return
          void takeFiles(files).then((handled) => {
            if (handled) {
              e.preventDefault()
              e.stopPropagation()
            }
          })
        }}
      >
        {!active ? (
          <div className="grid h-full place-items-center px-8">
            <div className="text-center">
              <p className="text-[15px] text-ink-2">从左边选一篇。</p>
              <p className="mt-2 text-[12.5px] text-ink-3">
                这里摊开的永远是你文件夹里那一个文件。
              </p>
            </div>
          </div>
        ) : mode === 'read' ? (
          <div className="h-full overflow-y-auto">
            <JumpContext.Provider value={onJump}>
            <TaskContext.Provider value={(line, checked) => {
              // 阅读模式点任务框：只改那一行的 `[ ]` / `[x]`，别的一律不碰
              if (!active) return
              const lines = text.split('\n')
              const at = lines[line - 1]
              if (at === undefined) return
              const next = at.replace(
                // 无序：`- ` / `* ` / `+ `；有序：`1. ` / `1) ` —— 两种都要认
                /^(\s*(?:[-*+]\s+|\d{1,9}[.)]\s+)\[)([ xX])(\]\s)/,
                (_, head: string, _mark: string, tail: string) => `${head}${checked ? 'x' : ' '}${tail}`,
              )
              if (next === at) return
              lines[line - 1] = next
              onChange(active, lines.join('\n'))
            }}>
            <article
              data-dd-doc={scopeId}
              data-img-tick={imgTick}
              style={{
                maxWidth: 'var(--dd-cw)',
                fontSize: 'var(--dd-fs)',
                lineHeight: 'var(--dd-lh)',
                fontFamily: 'var(--dd-font)',
              }}
              className="mx-auto w-full px-10 pt-10 pb-28"
            >
              {parseMarkdown(text).map((b, i) => (
                <BlockView key={i} b={b} />
              ))}
            </article>
            </TaskContext.Provider>
            </JumpContext.Provider>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="grid h-full place-items-center text-[12.5px] text-ink-3">
                正在载入编辑器…
              </div>
            }
          >
            <CodeEditor
              ref={editorRef}
              docKey={active}
              value={text}
              live={mode === 'preview'}
              onChange={(next) => onChange(active, next)}
              onContext={setCtx}
              onJump={onJump}
              linkTargets={linkTargets}
              onOpenMath={(from, to) => {
                const raw = text.slice(from, to)
                // 把 `$$ … $$` 里面那段取出来
                const inner = raw.replace(/^\$\$/, '').replace(/\$\$$/, '').trim()
                setMathDlg({ initial: inner, kind: 'block', range: { from, to } })
              }}
              onOpenTable={(from, to) => {
                // 点渲染出来的表格：把那段 markdown 解回单元格 + 对齐
                const blk = parseMarkdown(text.slice(from, to)).find((b) => b.t === 'table')
                if (blk && blk.t === 'table') {
                  const cells = [blk.head, ...blk.rows].map((row) => row.map((c) => plainText(c)))
                  setTableDraft({ from, to, cells, align: blk.align })
                }
              }}
            />
          </Suspense>
        )}
      </div>


      {tableDraft ? (
        <TableEditor
          cells={tableDraft.cells}
          align={tableDraft.align}
          onCancel={() => setTableDraft(null)}
          onApply={(cells, align) => {
            editorRef.current?.replaceRange(tableDraft.from, tableDraft.to, buildTable(cells, align))
            setTableDraft(null)
          }}
        />
      ) : null}

      {mathDlg ? (
        <MathDialog
          initial={mathDlg.initial}
          kind={mathDlg.kind}
          onCancel={() => setMathDlg(null)}
          onApply={(tex) => {
            const body = tex.trim()
            const full = mathDlg.kind === 'block' ? `$$\n${body}\n$$` : `$${body}$`
            if (mathDlg.range) {
              editorRef.current?.replaceRange(mathDlg.range.from, mathDlg.range.to, full)
            } else {
              // 新建：前后各留一个空行，块公式才不会被并进上一段
              editorRef.current?.insert(`\n${full}\n`)
            }
            setMathDlg(null)
          }}
        />
      ) : null}

      {linkDlg ? (
        <LinkDialog
          targets={linkTargets ?? []}
          onCancel={() => setLinkDlg(false)}
          onApply={(insert) => {
            editorRef.current?.insert(insert)
            setLinkDlg(false)
          }}
        />
      ) : null}

      {noteDir ? null : <footer className="flex h-9 shrink-0 items-center gap-2 overflow-hidden border-t border-line pr-2 pl-3 text-[11px] text-ink-3">

        <span className="ml-auto whitespace-nowrap tabular-nums">{text.length} 字</span>

        <div className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5" role="group" aria-label="显示模式">
          {MODES.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              title={label}
              aria-label={label}
              aria-pressed={mode === id}
              className={[
                'grid size-6 place-items-center rounded-[5px] transition-colors',
                mode === id
                  ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(16,35,28,0.10)]'
                  : 'text-ink-3 hover:text-ink-2',
              ].join(' ')}
            >
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
      </footer>}
    </main>
  )
}
