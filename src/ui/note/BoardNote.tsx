/*
 * v3 纵向块画布。
 *
 * 跟 v2 文档流最大的区别：**没有"一整篇正文"**。每个块是独立 TipTap 实例，
 * 顺序由 board.json 管，连接由 relations.json 管，文件复制进本笔记的 assets/。
 *
 * 这一版只做纵向排列：块手柄拖动换顺序；连接用"类型 + 说明"表达，
 * 在右栏列表里查看和跳转 —— 不引入任意坐标拖拽，也不画贝塞尔曲线。
 */
import type { Editor } from '@tiptap/core'
import { Link2, Plus, RotateCw, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  BOARD_ASSETS,
  type BoardBlock,
  type BoardBlockType,
  type BoardDoc,
  type Relation,
  type RelationType,
  RELATION_TYPES,
  addRelation,
  assetPath,
  assetRefs,
  blockLabel,
  boardOutline,
  boardPlainText,
  diffBoardDoc,
  insertBoardBlock,
  moveBoardBlockTo,
  newBoardBlock,
  nextBoardId,
  relationsOf,
  removeBoardBlock,
  removeRelation,
  removedBoardBlockFiles,
  updateBoardBlock,
} from '../../core/note/board'
import { encodeText } from '../../core/model/text'
import { parentOf } from '../../core/model/path'
import type { Host } from '../../core/ports/host'
import type { BoardEntry } from '../../core/board/refs'
import type { NoteInfo } from '../NoteEditor'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { BoardPickDialog } from '../board/BoardPickDialog'
import { BoardCard } from './BoardCard'
import { RelationDialog } from './RelationDialog'

type Props = {
  host: Host
  dir: string
  doc: BoardDoc
  warnings?: string[]
  onInfo?: (dir: string, info: NoteInfo) => void
  /** 仓库里的白板索引：引用块靠它按 boardId 找到那块白板 */
  boards?: BoardEntry[]
  /** 打开一块白板（点引用块 / 菜单里） */
  onOpenBoard?: (path: string) => void
  /** 新建一块白板并返回它的身份；`null` = 建失败 */
  onCreateBoard?: (dir: string) => { path: string; boardId: string } | null
}

type Status = 'saved' | 'dirty' | 'saving' | 'error'
type DropAt = { index: number; after: boolean }
type MenuState = { id: string; x: number; y: number }
type AssetAsk = { kind: 'image' | 'file'; id?: string; afterId: string | null }

const ADD_TYPES: { type: BoardBlockType; label: string; hint: string }[] = [
  { type: 'paragraph', label: '正文', hint: '普通文字块' },
  { type: 'heading1', label: '一级标题', hint: '章节标题' },
  { type: 'heading2', label: '二级标题', hint: '小节标题' },
  { type: 'todo', label: '待办', hint: '带勾选框' },
  { type: 'quote', label: '引用', hint: '左侧竖线' },
  { type: 'image', label: '图片', hint: '复制进 assets/' },
  { type: 'file', label: '文件', hint: '复制进 assets/' },
  { type: 'divider', label: '分隔线', hint: '一条横线' },
]

const TEXT_TYPES: BoardBlockType[] = ['paragraph', 'heading1', 'heading2', 'todo', 'quote']

function isTextBlock(type: BoardBlockType): boolean {
  return TEXT_TYPES.includes(type)
}

function noticeOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function BoardNote({ host, dir, doc, warnings, onInfo, boards = [], onOpenBoard, onCreateBoard }: Props) {
  const [data, setData] = useState<BoardDoc>(doc)
  const [title, setTitle] = useState(doc.meta.title)
  const [status, setStatus] = useState<Status>('saved')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showRelations, setShowRelations] = useState(false)
  const [relationFrom, setRelationFrom] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<DropAt | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [assetAsk, setAssetAsk] = useState<AssetAsk | null>(null)
  const [hideWarnings, setHideWarnings] = useState(false)
  /** 白板选择器：insert = 在末尾插一个引用块；relocate = 给某个引用块重新定位 */
  const [boardPick, setBoardPick] = useState<{ mode: 'insert' } | { mode: 'relocate'; blockId: string } | null>(
    null,
  )

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const editors = useRef(new Map<string, Editor>())
  const savedByDir = useRef(new Map<string, BoardDoc>())
  const pending = useRef<{ dir: string; host: Host; doc: BoardDoc } | null>(null)
  const saveTimer = useRef(0)
  const titleTimer = useRef(0)
  const noticeTimer = useRef(0)
  const docRef = useRef(doc)
  const dataRef = useRef(doc)
  dataRef.current = data

  const registerEditor = useCallback((id: string, ed: Editor | null) => {
    if (ed) editors.current.set(id, ed)
    else editors.current.delete(id)
  }, [])

  /* ── 保存 ── */

  const flush = useCallback(async () => {
    const job = pending.current
    if (!job) return
    setStatus('saving')
    const before = savedByDir.current.get(job.dir) ?? null
    const diff = diffBoardDoc(job.dir, before, job.doc)
    const removed = removedBoardBlockFiles(job.dir, before, job.doc)
    try {
      for (const [path, text] of Object.entries(diff)) {
        await job.host.write(path, encodeText(text))
      }
      for (const path of removed) {
        if (job.host.exists && !(await job.host.exists(path))) continue
        await job.host.remove(path)
      }
      savedByDir.current.set(job.dir, job.doc)
      if (pending.current === job) {
        pending.current = null
        setStatus('saved')
        setError(null)
      } else {
        setStatus('dirty')
      }
    } catch (e) {
      // 失败不清待存：改了什么还在内存里，用户可以重试
      if (!pending.current) pending.current = job
      setStatus('error')
      setError(noticeOf(e))
    }
  }, [])
  const flushRef = useRef(flush)
  flushRef.current = flush

  const commit = useCallback(
    (next: BoardDoc) => {
      docRef.current = next
      setData(next)
      pending.current = { dir, host, doc: next }
      setStatus('dirty')
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        void flushRef.current()
      }, 400)
    },
    [dir, host],
  )

  useEffect(() => {
    if (!savedByDir.current.has(dir)) savedByDir.current.set(dir, doc)
    docRef.current = doc
    setData(doc)
    setTitle(doc.meta.title)
    setStatus('saved')
    setError(null)
  }, [dir, doc])

  useEffect(() => {
    const onHide = () => {
      void flushRef.current()
    }
    window.addEventListener('pagehide', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      window.clearTimeout(saveTimer.current)
      window.clearTimeout(titleTimer.current)
      void flushRef.current()
    }
  }, [])

  useEffect(() => {
    if (!notice) return
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3600)
    return () => window.clearTimeout(noticeTimer.current)
  }, [notice])

  useEffect(() => {
    if (!focusId) return
    const t = window.setTimeout(() => {
      const ed = editors.current.get(focusId)
      ed?.commands.focus('end')
      setFocusId(null)
    }, 80)
    return () => window.clearTimeout(t)
  }, [focusId])

  useEffect(() => {
    onInfo?.(dir, { outline: boardOutline(data), text: boardPlainText(data) })
  }, [data, dir, onInfo])

  /* ── 块编辑 ── */

  const patchBlock = (id: string, patch: Partial<BoardBlock>) => {
    commit(updateBoardBlock(docRef.current, id, patch))
  }

  const addBlock = (type: BoardBlockType, afterId: string | null) => {
    const id = nextBoardId(docRef.current)
    const block = newBoardBlock(type, id)
    commit(insertBoardBlock(docRef.current, afterId, block))
    setFocusId(id)
  }

  const requestAsset = (kind: 'image' | 'file', id: string | undefined, afterId: string | null) => {
    setAssetAsk({ kind, id, afterId })
    if (fileRef.current) {
      fileRef.current.accept = kind === 'image' ? 'image/*' : '*/*'
      fileRef.current.value = ''
      fileRef.current.click()
    }
  }

  const addAssetBlocks = async (files: File[], afterId: string | null) => {
    let cursor = afterId
    for (const file of files) {
      try {
        await host.mkdir(`${dir}/${BOARD_ASSETS}`)
        const path = assetPath(dir, file.name)
        await host.write(path, new Uint8Array(await file.arrayBuffer()))
        const id = nextBoardId(docRef.current)
        const image = file.type.startsWith('image/')
        const block: BoardBlock = image
          ? { ...newBoardBlock('image', id), src: path, alt: '' }
          : { ...newBoardBlock('file', id), src: path, name: file.name, size: file.size }
        commit(insertBoardBlock(docRef.current, cursor, block))
        cursor = id
        setFocusId(id)
      } catch (e) {
        setNotice(`「${file.name}」没能复制进 assets/：${noticeOf(e)}`)
      }
    }
  }

  const onAssetPicked = async (file: File) => {
    const ask = assetAsk
    setAssetAsk(null)
    if (!ask) return
    try {
      await host.mkdir(`${dir}/${BOARD_ASSETS}`)
      const path = assetPath(dir, file.name)
      await host.write(path, new Uint8Array(await file.arrayBuffer()))
      if (ask.id) {
        patchBlock(ask.id, {
          src: path,
          ...(ask.kind === 'file' ? { name: file.name, size: file.size } : {}),
        })
      } else {
        const id = nextBoardId(docRef.current)
        const block: BoardBlock =
          ask.kind === 'image'
            ? { ...newBoardBlock('image', id), src: path, alt: '' }
            : { ...newBoardBlock('file', id), src: path, name: file.name, size: file.size }
        commit(insertBoardBlock(docRef.current, ask.afterId, block))
        setFocusId(id)
      }
    } catch (e) {
      setNotice(`没能把文件复制进 assets/：${noticeOf(e)}`)
    }
  }

  const deleteBlock = (id: string) => {
    const cur = docRef.current
    const at = cur.order.indexOf(id)
    const block = cur.blocks[id]
    const next = removeBoardBlock(cur, id)
    commit(next)
    if (block?.src) {
      const left = assetRefs(next, block.src)
      if (left.length === 0) setNotice('块已删除；assets/ 里的文件没有自动删，避免误删你的资料')
    }
    const prev = cur.order[at - 1] ?? cur.order[at + 1] ?? null
    if (prev) setFocusId(prev)
  }

  const duplicateBlock = (id: string) => {
    const cur = docRef.current
    const block = cur.blocks[id]
    if (!block) return
    const nextId = nextBoardId(cur)
    const copy: BoardBlock = {
      ...block,
      id: nextId,
      content: block.content ? block.content.map((x) => ({ ...x })) : undefined,
    }
    commit(insertBoardBlock(cur, id, copy))
    setFocusId(nextId)
  }

  const moveBlock = (id: string, dirStep: -1 | 1) => {
    const cur = docRef.current
    const at = cur.order.indexOf(id)
    if (at < 0) return
    const next = moveBoardBlockTo(cur, id, at + (dirStep > 0 ? 2 : -1))
    if (next !== cur) commit(next)
    setFocusId(id)
  }

  /** 插入一个白板引用块。只记身份 + 路径提示 + 显示方式，**不复制白板内容** */
  const insertBoardRef = (target: { path: string; boardId: string }) => {
    const cur = docRef.current
    const id = nextBoardId(cur)
    const block: BoardBlock = {
      ...newBoardBlock('boardref', id),
      boardId: target.boardId,
      path: target.path,
      view: 'compact',
    }
    commit(insertBoardBlock(cur, cur.order[cur.order.length - 1] ?? null, block))
    setFocusId(id)
  }

  /** 引用块重新定位：换 boardId 和路径提示，块本身和顺序都不动 */
  const relocateBoard = (blockId: string, target: { path: string; boardId: string }) => {
    patchBlock(blockId, { boardId: target.boardId, path: target.path })
  }

  const onCreateBoardHere = () => {
    if (!onCreateBoard) return
    // 新白板放在这篇笔记旁边（同一层目录），别默认丢到仓库根
    const made = onCreateBoard(parentOf(dir))
    if (!made) {
      setNotice('新建白板失败：看下文件栏的提示')
      return
    }
    if (boardPick?.mode === 'relocate') relocateBoard(boardPick.blockId, made)
    else insertBoardRef(made)
    setBoardPick(null)
  }

  const handleDrop = () => {
    const cur = docRef.current
    if (dragId && dropAt) {
      const target = dropAt.index + (dropAt.after ? 1 : 0)
      const next = moveBoardBlockTo(cur, dragId, target)
      if (next !== cur) commit(next)
      setFocusId(dragId)
    }
    setDropAt(null)
    setDragId(null)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDropAt({ index, after: e.clientY > r.top + r.height / 2 })
  }

  /* ── 连接 ── */

  const saveRelation = (rel: { to: string; type: RelationType; label: string }) => {
    if (!relationFrom) return
    const relation: Relation = {
      id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      from: relationFrom,
      to: rel.to,
      type: rel.type,
      label: rel.label,
      createdAt: Date.now(),
    }
    commit(addRelation(docRef.current, relation))
    setRelationFrom(null)
    setShowRelations(true)
  }

  const scrollToBlock = (id: string) => {
    const el = scrollRef.current?.querySelector(`[data-block-id="${id}"]`) as HTMLElement | null
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlashId(id)
    window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1600)
  }

  /* ── 菜单 ── */

  const blockMenuItems = (id: string): MenuItem[] => {
    const block = dataRef.current.blocks[id]
    if (!block) return []
    const items: MenuItem[] = [
      { label: '在下方添加正文', onSelect: () => addBlock('paragraph', id) },
      { label: '复制这个块', onSelect: () => duplicateBlock(id) },
      { divider: true, label: '', onSelect: () => {} },
      { label: '连接到…', onSelect: () => setRelationFrom(id) },
    ]
    if (isTextBlock(block.type)) {
      items.push({ divider: true, label: '', onSelect: () => {} })
      for (const t of ADD_TYPES) {
        if (!isTextBlock(t.type) || t.type === block.type) continue
        items.push({ label: `转为${t.label}`, onSelect: () => patchBlock(id, { type: t.type }) })
      }
    }
    if (block.type === 'image') {
      items.splice(2, 0, { label: '更换图片…', onSelect: () => requestAsset('image', id, null) })
    }
    if (block.type === 'file') {
      items.splice(2, 0, { label: '更换文件…', onSelect: () => requestAsset('file', id, null) })
    }
    if (block.type === 'boardref') {
      items.splice(2, 0,
        {
          label: block.view === 'preview' ? '改成紧凑卡片' : '改成预览卡片',
          onSelect: () => patchBlock(id, { view: block.view === 'preview' ? 'compact' : 'preview' }),
        },
        {
          label: '重新定位到别的白板…',
          onSelect: () => setBoardPick({ mode: 'relocate', blockId: id }),
        },
      )
    }
    items.push({ divider: true, label: '', onSelect: () => {} })
    items.push({ label: '删除这个块', danger: true, onSelect: () => deleteBlock(id) })
    return items
  }

  const addMenuItems = (afterId: string | null): MenuItem[] => [
    ...ADD_TYPES.map((t) => ({
      label: t.label,
      onSelect: () => {
        if (t.type === 'image' || t.type === 'file') requestAsset(t.type, undefined, afterId)
        else addBlock(t.type, afterId)
      },
    })),
    { divider: true, label: '', onSelect: () => {} },
    { label: '引用白板…', onSelect: () => setBoardPick({ mode: 'insert' }) },
    {
      label: '新建白板并引用',
      onSelect: () => {
        if (!onCreateBoard) {
          setNotice('这里没法新建白板：仓库还没准备好')
          return
        }
        const made = onCreateBoard(parentOf(dir))
        if (made) insertBoardRef(made)
        else setNotice('新建白板失败：看下文件栏的提示')
      },
    },
  ]

  const addAt = (x: number, y: number) => setAddMenu({ x, y })
  const lastId = data.order.length ? (data.order[data.order.length - 1] ?? null) : null

  const relationList = data.relations
  const totalRelations = relationList.length

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-paper">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="rounded-full bg-green-soft px-2 py-0.5 text-[10.5px] tracking-wide text-green">
          .note · 纵向画布
        </span>
        <span className="text-[10.5px] text-ink-3">
          {status === 'saved'
            ? '已保存'
            : status === 'saving'
              ? '保存中…'
              : status === 'error'
                ? '未保存'
                : '有改动'}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            addAt(r.left, r.bottom + 4)
          }}
          className="inline-flex items-center gap-1 rounded-md bg-green px-2.5 py-1 text-[11.5px] text-white hover:bg-green-deep"
        >
          <Plus className="size-3.5" />
          添加块
        </button>
        <button
          type="button"
          onClick={() => setShowRelations((v) => !v)}
          aria-pressed={showRelations}
          className={[
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px]',
            showRelations
              ? 'border-green/40 bg-green-soft text-green'
              : 'border-line text-ink-2 hover:bg-surface-2',
          ].join(' ')}
        >
          <Link2 className="size-3.5" />
          连接 {totalRelations}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          data-dd-flow-scroll=""
          className="min-h-0 flex-1 overflow-y-auto"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
            }
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length > 0) {
              e.preventDefault()
              void addAssetBlocks([...e.dataTransfer.files], lastId)
            }
          }}
        >
          <div className="mx-auto w-full px-10 pt-8 pb-40" style={{ maxWidth: 'var(--dd-cw)' }}>
            <input
              value={title}
              onChange={(e) => {
                const v = e.target.value
                setTitle(v)
                window.clearTimeout(titleTimer.current)
                titleTimer.current = window.setTimeout(() => {
                  commit({
                    ...docRef.current,
                    meta: { ...docRef.current.meta, title: v, updatedAt: new Date().toISOString() },
                  })
                }, 400)
              }}
              aria-label="文档标题"
              placeholder="无标题"
              className="dd-board-title"
            />
            <div className="mb-4 flex items-center gap-2 text-[10.5px] text-ink-3">
              <span>{data.order.length} 块</span>
              <span className="opacity-50">·</span>
              <span>{totalRelations} 条连接</span>
              <span className="opacity-50">·</span>
              <span>拖动左侧手柄换顺序</span>
            </div>

            {warnings && warnings.length > 0 && !hideWarnings ? (
              <div role="status" className="mb-4 rounded-lg border border-[#f0e2c4] bg-[#fdf8ec] px-3 py-2">
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 text-[11px] leading-relaxed break-words text-[#7a5b18]">
                    {warnings.join('；')}
                  </p>
                  <button
                    type="button"
                    onClick={() => setHideWarnings(true)}
                    aria-label="关闭提示"
                    className="shrink-0 text-[12px] text-[#7a5b18]/70 hover:text-[#7a5b18]"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              </div>
            ) : null}

            {data.layoutMode === 'free' ? (
              <p className="mb-4 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11px] text-ink-2">
                这份文档标记为自由排布（free）。自由排布视图还没做，现在先按纵向显示；数据和顺序不会丢。
              </p>
            ) : null}

            {data.order.length === 0 ? (
              <div className="mt-10 rounded-xl border border-dashed border-line px-6 py-12 text-center">
                <p className="text-[14px] text-ink-2">这是一张空画布</p>
                <p className="mt-1.5 text-[11.5px] text-ink-3">
                  块是独立的小卡片：文字、待办、引用、图片、文件都可以单独放、单独拖。
                </p>
                <button
                  type="button"
                  onClick={() => addBlock('paragraph', null)}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-green px-3 py-1.5 text-[12px] text-white hover:bg-green-deep"
                >
                  <Plus className="size-3.5" />
                  添加第一个块
                </button>
              </div>
            ) : null}

            <div className="flex flex-col gap-1">
              {data.order.map((id, index) => {
                const block = data.blocks[id]
                if (!block) return null
                return (
                  <Fragment key={id}>
                    {dropAt && dropAt.index === index && !dropAt.after ? <DropLine /> : null}
                    <BoardCard
                      host={host}
                      block={block}
                      index={index}
                      autoFocus={focusId === id}
                      flash={flashId === id}
                      relationCount={relationsOf(data, id).length}
                      onChange={patchBlock}
                      onMenu={(blockId, x, y) => setMenu({ id: blockId, x, y })}
                      onEnterEnd={(blockId) => addBlock('paragraph', blockId)}
                      onBackspaceEmpty={deleteBlock}
                      onEditor={registerEditor}
                      onDragStart={setDragId}
                      onDragEnd={() => {
                        setDragId(null)
                        setDropAt(null)
                      }}
                      onDragOver={handleDragOver}
                      onDrop={handleDrop}
                      onPickAsset={(blockId, kind) => requestAsset(kind, blockId, null)}
                      onShowRelations={() => setShowRelations(true)}
                      onMove={moveBlock}
                      onNotice={setNotice}
                      boards={boards}
                      onOpenBoard={onOpenBoard}
                      onRelocateBoard={(blockId) => setBoardPick({ mode: 'relocate', blockId })}
                    />
                    {dropAt && dropAt.index === index && dropAt.after ? <DropLine /> : null}
                  </Fragment>
                )
              })}
            </div>

            <div
              className="mt-2 flex h-16 items-center justify-center rounded-lg border border-dashed border-line/70 text-[11px] text-ink-3/60"
              onDragOver={(e) => {
                if (!dragId) return
                e.preventDefault()
                setDropAt({ index: data.order.length, after: false })
              }}
              onDrop={(e) => {
                e.preventDefault()
                handleDrop()
              }}
            >
              <button
                type="button"
                onClick={() => addBlock('paragraph', lastId)}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-surface-2 hover:text-ink-2"
              >
                <Plus className="size-3.5" />
                在末尾添加一个正文块
              </button>
            </div>
          </div>
        </div>

        {showRelations ? (
          <aside aria-label="块间连接" className="flex w-[270px] shrink-0 flex-col border-l border-line bg-surface">
            <header className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2.5">
              <Link2 className="size-3.5 text-ink-3" />
              <span className="text-[11.5px] text-ink-2">连接 {totalRelations}</span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setShowRelations(false)}
                aria-label="收起连接面板"
                className="grid size-6 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink-2"
              >
                <X className="size-3.5" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {relationList.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-ink-3">
                  还没有连接。点任意块左侧 <span className="font-mono">⋯</span> → 「连接到…」，
                  选目标块和关系类型。
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {relationList.map((rel) => {
                    const from = data.blocks[rel.from]
                    const to = data.blocks[rel.to]
                    const typeLabel = RELATION_TYPES.find((t) => t.id === rel.type)?.label ?? rel.type
                    return (
                      <li key={rel.id} className="group rounded-lg border border-line bg-surface px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          <span className="rounded bg-surface-2 px-1 py-[1px] text-[9.5px] text-ink-3">
                            {typeLabel}
                          </span>
                          <span className="flex-1" />
                          <button
                            type="button"
                            aria-label="删除连接"
                            onClick={() => commit(removeRelation(dataRef.current, rel.id))}
                            className="rounded p-0.5 text-ink-3 opacity-0 hover:bg-surface-2 hover:text-[#b3261e] group-hover:opacity-100"
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            if (to) scrollToBlock(rel.to)
                            else if (from) scrollToBlock(rel.from)
                          }}
                          className="mt-1 block w-full text-left text-[10.5px] leading-relaxed text-ink-2 hover:text-green"
                        >
                          <span className="block truncate">{blockLabel(from, rel.from)}</span>
                          <span className="block pl-1 text-ink-3">→ {blockLabel(to, rel.to)}</span>
                        </button>
                        {rel.label ? (
                          <p className="mt-1 border-t border-line/60 pt-1 text-[10.5px] leading-relaxed break-words text-ink-3">
                            {rel.label}
                          </p>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </aside>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-t border-[#f0c9c5] bg-[#fdf0ef] px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-[#8f1d17]">保存失败：{error}</span>
          <button
            type="button"
            onClick={() => void flushRef.current()}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-[#e4b4af] px-1.5 py-0.5 text-[10.5px] text-[#8f1d17] hover:bg-[#fbe4e2]"
          >
            <RotateCw className="size-3" />
            重试
          </button>
        </div>
      ) : null}

      {notice ? (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 max-w-[min(520px,86vw)] -translate-x-1/2 rounded-lg border border-line bg-surface px-3 py-2 text-[11px] text-ink-2 shadow-[0_10px_28px_rgba(16,35,28,0.16)]">
          {notice}
        </div>
      ) : null}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={blockMenuItems(menu.id)} onClose={() => setMenu(null)} />
      ) : null}

      {addMenu ? (
        <ContextMenu
          x={addMenu.x}
          y={addMenu.y}
          items={addMenuItems(lastId)}
          onClose={() => setAddMenu(null)}
        />
      ) : null}

      {relationFrom ? (
        <RelationDialog
          fromId={relationFrom}
          blocks={data.order
            .map((id) => data.blocks[id])
            .filter((b): b is BoardBlock => Boolean(b))
            .map((b) => ({ id: b.id, label: blockLabel(b, b.id) }))}
          onSave={saveRelation}
          onClose={() => setRelationFrom(null)}
        />
      ) : null}

      {boardPick ? (
        <BoardPickDialog
          title={boardPick.mode === 'insert' ? '引用一块白板' : '重新定位白板引用'}
          hint={
            boardPick.mode === 'insert'
              ? '引用块只记这块白板本身，不复制内容 —— 在白板里改完，这里再看就是最新的。'
              : '选一块新的白板替换原来的指向。引用块的位置和顺序不变。'
          }
          boards={boards}
          currentId={
            boardPick.mode === 'relocate' ? data.blocks[boardPick.blockId]?.boardId : undefined
          }
          onCreate={onCreateBoard ? onCreateBoardHere : undefined}
          onPick={(entry) => {
            const target = { path: entry.path, boardId: entry.boardId }
            if (boardPick.mode === 'insert') insertBoardRef(target)
            else relocateBoard(boardPick.blockId, target)
            setBoardPick(null)
          }}
          onClose={() => setBoardPick(null)}
        />
      ) : null}

      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void onAssetPicked(f)
          else setAssetAsk(null)
        }}
      />
    </div>
  )
}

function DropLine() {
  return <div className="dd-board-drop" aria-hidden />
}
