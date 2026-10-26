import { useEffect, useRef, useState } from 'react'
import type { TreeNode } from '../core/model/library'
import type { ReactNode } from 'react'
import { ContextMenu, type MenuItem } from './ContextMenu'
import {
  IconBlocks,
  IconChevron,
  IconFile,
  IconFolder,
  IconFolderPlus,
  IconMore,
  IconPin,
  IconPlus,
} from './icons'
import type { Section } from './Rail'

type Props = {
  section: Section
  tree: TreeNode[]
  current: string | null
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpen: (path: string) => void
  /** 在新标签页里打开 */
  onOpenTab: (path: string) => void
  /** 新开一个标签页并放到右侧分栏 */
  onOpenSplit: (path: string) => void

  /** 在某个目录里新建。返回新路径或 null */
  onNewNote: (dir: string) => string | null
  /** 新建块笔记（.note） */
  onNewBlockNote: (dir: string) => void
  onNewFolder: (dir: string) => string | null
  /** 改名。返回错误消息；成功返回 null */
  onRename: (path: string, name: string) => string | null
  /** 搬家到某个目录（`''` = 根）。返回错误消息；成功返回 null */
  onMove: (path: string, destDir: string) => string | null
  onDelete: (path: string) => void

  /** 置顶的路径，越靠前越上面 */
  pinned: string[]
  onTogglePin: (path: string) => void

  /** 仓库位置的一句话。显示在这一栏底部 —— 它是"我在哪"的常驻答案 */
  repoLabel: string
  /** 内容是不是真的在磁盘上。memory 是 false，必须照实说 */
  durable: boolean
  save: 'clean' | 'dirty' | 'saving' | 'error'
  saveError: string | null

  /** 点底部仓库名弹出来的切换列表（label 给人看，key 用来认） */
  vaultItems: { key: string; label: string }[]
  currentVaultKey: string
  onSwitchVault: (key: string) => void
  onPickVault: () => void

  /** 宽度由 App 管（可拖动） */
  width: number
  /** 拖拽把手，由 App 传进来贴在这一栏的右边缘 */
  resizer?: ReactNode
}

const SAVE_LABEL = {
  clean: '已保存',
  dirty: '待写入',
  saving: '写入中…',
  error: '写盘失败',
} as const

const TITLE: Record<Section, string> = {
  notes: 'Dusk Depot',
  search: '搜索',
  tags: '标签',
}

type MenuState = { x: number; y: number; path: string | null } | null
type RenameState = { path: string; value: string } | null

/** 第二列：右键菜单、就地改名、拖动搬家、删除确认都在这一列里 */
export function TreePanel({
  section,
  tree,
  current,
  expanded,
  onToggle,
  onOpen,
  onOpenTab,
  onOpenSplit,
  onNewNote,
  onNewBlockNote,
  onNewFolder,
  onRename,
  onMove,
  onDelete,
  pinned,
  onTogglePin,
  repoLabel,
  durable,
  save,
  saveError,
  vaultItems,
  currentVaultKey,
  onSwitchVault,
  onPickVault,
  width,
  resizer,
}: Props) {
  const [menu, setMenu] = useState<MenuState>(null)
  const [rename, setRename] = useState<RenameState>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [vaultMenu, setVaultMenu] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (rename) input.current?.select()
  }, [rename])

  useEffect(() => {
    if (!err) return
    const t = window.setTimeout(() => setErr(null), 3200)
    return () => window.clearTimeout(t)
  }, [err])

  function fail(message: string | null) {
    if (message) setErr(message)
    return message === null
  }

  function commitRename() {
    if (!rename) return
    const value = rename.value.trim()
    const old = rename.path
    setRename(null)
    if (!value) return
    const name = old.slice(old.lastIndexOf('/') + 1)
    if (value === name) return
    fail(onRename(old, value))
  }

  function startCreate(dir: string, kind: 'note' | 'folder') {
    // 新建是"一键建、零输入"，名字进来再改
    const made = kind === 'note' ? onNewNote(dir) : onNewFolder(dir)
    if (!made) {
      setErr('新建失败')
      return
    }
    const name = made.slice(made.lastIndexOf('/') + 1)
    setRename({ path: made, value: kind === 'note' ? name.replace(/\.md$/, '') : name })
  }

  function menuFor(path: string | null): MenuItem[] {
    const isDir = path === null || treeIsDir(tree, path)
    const dir = path === null ? '' : isDir ? path : path.slice(0, path.lastIndexOf('/'))

    const items: MenuItem[] = [
      { label: '新建笔记', onSelect: () => startCreate(dir, 'note') },
      { label: '新建文件夹', onSelect: () => startCreate(dir, 'folder') },
    ]

    if (path !== null) {
      // 只有文件才有"打开"这回事
      if (!isDir) {
        items.push(
          { label: '在新标签页打开', onSelect: () => onOpenTab(path) },
          { label: '在右侧分栏打开', onSelect: () => onOpenSplit(path) },
        )
      }
      items.push(
        { label: '', onSelect: () => {}, divider: true },
        {
          label: '重命名',
          onSelect: () => setRename({ path, value: path.slice(path.lastIndexOf('/') + 1) }),
        },
        {
          label: pinned.includes(path) ? '取消置顶' : '置顶',
          onSelect: () => onTogglePin(path),
        },
        { label: '删除', danger: true, onSelect: () => setPendingDelete(path) },
      )
    }

    return items
  }

  function drop(dir: string) {
    if (!dragging) return
    const from = dragging
    setDragging(null)
    setDropDir(null)
    if (dir === from) return
    if (dir === from.slice(0, from.lastIndexOf('/'))) return
    fail(onMove(from, dir))
  }

  function render(nodes: TreeNode[], depth: number): ReactNode {
    return nodes.map((n) => {
      const pad = 8 + depth * 12
      const isDir = n.kind === 'dir'
      const active = current === n.path
      const editing = rename?.path === n.path

      const rowClass = [
        'group flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-[13px] transition-colors',
        active ? 'bg-green-soft font-medium text-green-deep' : 'text-ink-2 hover:bg-surface-2',
        dropDir === n.path ? 'ring-1 ring-green/50 ring-inset' : '',
      ].join(' ')

      const label = editing ? (
        <input
          ref={input}
          value={rename?.value ?? ''}
          onChange={(e) => setRename({ path: n.path, value: e.target.value })}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitRename()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setRename(null)
            }
          }}
          className="h-6 w-full rounded border border-green/50 bg-surface px-1 text-[13px] text-ink outline-none"
        />
      ) : (
        <>
          {isDir ? (
            <IconChevron
              className={`size-3.5 shrink-0 text-ink-3 transition-transform ${expanded.has(n.path) ? 'rotate-90' : ''}`}
            />
          ) : null}
          {isDir ? (
            <IconFolder className="size-4 shrink-0 text-ink-3" />
          ) : (
            <IconFile className={`size-4 shrink-0 ${active ? 'text-green' : 'text-ink-3'}`} />
          )}
          <span className="truncate">{n.name}</span>
          {pinned.includes(n.path) ? (
            <IconPin className="size-3 shrink-0 text-green/60" />
          ) : null}
        </>
      )

      return (
        <div key={n.path}>
          <div
            draggable={!editing}
            onDragStart={(e) => {
              setDragging(n.path)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', n.path)
            }}
            onDragEnd={() => {
              setDragging(null)
              setDropDir(null)
            }}
            onDragOver={(e) => {
              if (!isDir || !dragging || dragging === n.path) return
              e.preventDefault()
              setDropDir(n.path)
            }}
            onDragLeave={() => setDropDir((d) => (d === n.path ? null : d))}
            onDrop={(e) => {
              if (!isDir) return
              e.preventDefault()
              e.stopPropagation()
              drop(n.path)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, path: n.path })
            }}
            style={editing ? undefined : { paddingLeft: pad + (isDir ? 0 : 18) }}
            className={rowClass}
          >
            <button
              type="button"
              onClick={() => (isDir ? onToggle(n.path) : onOpen(n.path))}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              {label}
            </button>

            {!isDir && !editing ? (
              <button
                type="button"
                aria-label="更多"
                onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, path: n.path })}
                className="grid size-5 shrink-0 place-items-center rounded text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink-2"
              >
                <IconMore className="size-3.5" />
              </button>
            ) : null}
          </div>

          {isDir && expanded.has(n.path) && n.children ? render(n.children, depth + 1) : null}
        </div>
      )
    })
  }

  return (
    <section
      aria-label={TITLE[section]}
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-line bg-surface"
    >
      {section === 'notes' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex gap-1 px-2 pt-2 pb-1">
            <button
              type="button"
              onClick={() => startCreate('', 'note')}
              className="flex h-8 flex-1 items-center gap-2 rounded-md px-2 text-[13px] text-ink-2 transition-colors hover:bg-surface-2"
            >
              <IconPlus className="size-4 text-ink-3" />
              新建笔记
            </button>
            <button
              type="button"
              onClick={() => onNewBlockNote('')}
              title="新建块笔记（.note）"
              aria-label="新建块笔记"
              className="grid size-8 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
            >
              <IconBlocks className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => startCreate('', 'folder')}
              title="新建文件夹"
              aria-label="新建文件夹"
              className="grid size-8 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
            >
              <IconFolderPlus className="size-4" />
            </button>
          </div>

          <div className="px-4 pt-2 pb-1 text-[11px] font-medium tracking-wide text-ink-3">
            笔记库
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
            onDragOver={(e) => {
              // 拖到列表空白处 = 挪到根目录
              if (dragging) {
                e.preventDefault()
                setDropDir('')
              }
            }}
            onDrop={(e) => {
              e.preventDefault()
              drop('')
            }}
            onContextMenu={(e) => {
              // 空白处右键 = 在根目录新建
              if (e.target === e.currentTarget) {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, path: null })
              }
            }}
          >
            {tree.length === 0 ? (
              <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-ink-3">
                这个仓库里还没有 .md。
                <br />
                右键或者点上面的「新建笔记」。
              </p>
            ) : (
              render(tree, 0)
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="text-[13px] text-ink-2">这一栏还没做。</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
            先把「笔记」那一栏做到能用，搜索和标签等模型稳了再接。
          </p>
        </div>
      )}

      <footer className="relative flex h-9 shrink-0 items-center gap-2 border-t border-line px-2 text-[11px] text-ink-3">
        <button
          type="button"
          onClick={() => setVaultMenu((v) => !v)}
          title={`${repoLabel} —— 点击切换仓库`}
          aria-haspopup="menu"
          aria-expanded={vaultMenu}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-surface-2"
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${durable ? 'bg-green/70' : 'bg-ink-3/40'}`}
          />
          <span className="truncate">{durable ? repoLabel : '暂存（不在磁盘上）'}</span>
          <IconChevron className="size-3 shrink-0 -rotate-90 text-ink-3/70" />
        </button>
        <span
          className={`shrink-0 pr-1 ${save === 'error' ? 'font-medium text-ink' : ''}`}
          title={saveError ?? undefined}
        >
          {SAVE_LABEL[save]}
        </span>

        {vaultMenu ? (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setVaultMenu(false)} />
            <div className="absolute bottom-9 left-2 z-40 w-[15rem] rounded-lg border border-line bg-surface p-1 shadow-[0_10px_28px_rgba(16,35,28,0.16)]">
              <p className="px-2 py-1 text-[11px] text-ink-3">切换仓库</p>
              <div className="max-h-64 overflow-y-auto">
                {vaultItems.length === 0 ? (
                  <p className="px-2 py-1.5 text-[11.5px] text-ink-3">还没有别的仓库</p>
                ) : (
                  vaultItems.map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      onClick={() => {
                        setVaultMenu(false)
                        onSwitchVault(v.key)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-surface-2"
                    >
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${v.key === currentVaultKey ? 'bg-green' : 'bg-transparent'}`}
                      />
                      <span className="truncate" title={v.label}>
                        {v.label}
                      </span>
                    </button>
                  ))
                )}
              </div>
              <div className="my-1 h-px bg-line" />
              <button
                type="button"
                onClick={() => {
                  setVaultMenu(false)
                  onPickVault()
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-surface-2"
              >
                选择其他文件夹…
              </button>
            </div>
          </>
        ) : null}
      </footer>

      {err ? (
        <div className="absolute inset-x-2 bottom-2 rounded-md bg-ink px-3 py-2 text-[12px] text-paper shadow-lg">
          {err}
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="absolute inset-0 z-40 grid place-items-center bg-surface/85 px-4">
          <div className="w-full rounded-xl border border-line bg-surface p-4 shadow-[0_12px_32px_rgba(16,35,28,0.16)]">
            <p className="text-[13px] font-medium text-ink">确定要删掉它吗？</p>
            <p className="mt-1.5 break-all font-mono text-[11.5px] leading-relaxed text-ink-3">
              {pendingDelete}
            </p>
            <p className="mt-1.5 text-[11.5px] text-ink-3">删掉就没了，磁盘上也会一起消失。</p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="h-8 rounded-md border border-line px-3 text-[12.5px] text-ink-2 hover:bg-surface-2"
              >
                先不删
              </button>
              <button
                type="button"
                onClick={() => {
                  onDelete(pendingDelete)
                  setPendingDelete(null)
                }}
                className="h-8 rounded-md bg-ink px-3 text-[12.5px] font-medium text-paper hover:opacity-90"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuFor(menu.path)} onClose={() => setMenu(null)} />
      ) : null}
      {resizer}
    </section>
  )
}

/** 在树上找这个路径是不是目录 —— 只用来决定"新建"落在哪个目录 */
function treeIsDir(nodes: TreeNode[], path: string): boolean {
  for (const n of nodes) {
    if (n.path === path) return n.kind === 'dir'
    if (n.kind === 'dir' && n.children) {
      const hit = treeIsDir(n.children, path)
      if (hit) return true
    }
  }
  return false
}
