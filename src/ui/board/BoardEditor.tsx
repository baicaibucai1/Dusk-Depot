/*
 * `.board` 白板编辑器。
 *
 * ## 它和 `.note` 的 v3 画布不是同一个东西
 *
 *   `.note` 是**一篇文档**：块竖着排，顺序就是阅读顺序，存成一整个目录。
 *   `.board` 是**一块白板**：独立一个文件，块可以拖动排序、可以连线、可以放附件，
 *   还能被别的 `.note` 按 boardId 引用（引用块只存身份，不复制内容）。
 *
 * ## 三条硬规矩
 *
 *   ① **保存状态必须是真的**。保存失败就停在"保存失败"并留着待存数据，
 *      绝不显示"已保存"而磁盘上其实没写（重试按钮会再写一次）。
 *   ② **改一个块只改这一个块**。所有编辑都走 core 里的纯函数，
 *      块内容与连接各自独立，不会因为编辑文字把别的块或连接冲掉。
 *   ③ **未知块原样保留**。认不出的块显示成"由更新版本创建"，保存时一个字节不改。
 *
 * 连接画在左侧留白里：纵向排列下，两个块之间的关系就是一条弧线。
 * 不引入任意坐标拖拽，也不用 canvas —— 出问题的时候 DOM 还能查。
 */
import type { Editor } from '@tiptap/core'
import { Link2, Plus, Redo2, RotateCw, Undo2, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  type BoardBlock,
  type BoardBlockType,
  type BoardFileDoc,
  type BoardLink,
  type BlockSource,
  type LinkType,
  LINK_TYPES,
  addLink,
  blockLabel,
  copyAssetPath,
  copyDirOf,
  duplicateBlock,
  insertBlock,
  linksOf,
  moveBlockTo,
  newBlock,
  nextBlockId,
  parseBoardFile,
  removeBlock,
  removeLink,
  serializeBoardFile,
  titleOfBoardPath,
  updateBlock,
} from '../../core/board/file'
import { decodeBytes } from '../../core/model/text'
import type { Host } from '../../core/ports/host'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { RelationDialog } from '../note/RelationDialog'
import { BoardBlockCard } from './BoardBlockCard'
import { RepoFileDialog } from './RepoFileDialog'

type Props = {
  host: Host
  path: string
  /**
   * 保存。**按 boardId 交给外层**，不是按路径 ——
   * 白板被改名/搬家后，未落的改动还要写到新位置去（详情见 App 的 boardPaths）。
   */
  onSave: (boardId: string, text: string) => Promise<void>
  /** 打开仓库里的其它文件（文件卡片上的"打开"） */
  onOpenFile?: (path: string) => void
  /** 「引用仓库文件」的候选清单 */
  repoFiles?: { path: string; label: string }[]
  /**
   * 桌面端原生拖入的登记口：Tauri 的原生拖放不经过 DOM 事件，只给坐标，
   * 由外层命中测试后按路径回调进来。传 `null` 表示这块白板关掉了。
   */
  onRegisterDrop?: (path: string, fn: ((paths: string[]) => void) | null) => void
  /** 这块白板刚被改名：读盘后把标题也改成新名字（并保存一次） */
  renameHint?: string | null
  onRenameHintUsed?: (path: string) => void
  onNotice?: (text: string) => void
}

type Status = 'saved' | 'dirty' | 'saving' | 'error'
type Load =
  | { t: 'loading' }
  | { t: 'ok'; doc: BoardFileDoc; warnings: string[] }
  | { t: 'bad'; message: string }
  | { t: 'unsupported'; message: string }
type DropAt = { index: number; after: boolean }
type AssetAsk =
  | { mode: 'copy'; kind: 'image' | 'file'; id?: string; afterId: string | null }
  | { mode: 'link'; kind: 'image' | 'file'; id?: string; afterId: string | null }

const ADD_TYPES: { type: BoardBlockType; label: string; hint: string }[] = [
  { type: 'paragraph', label: '文字', hint: '普通文字块' },
  { type: 'heading1', label: '标题', hint: '章节标题' },
  { type: 'heading2', label: '小标题', hint: '小节标题' },
  { type: 'todo', label: '待办', hint: '带勾选框' },
  { type: 'quote', label: '引用', hint: '左侧竖线' },
  { type: 'image', label: '图片（复制进来）', hint: '复制进白板，原文件删了也不影响' },
  { type: 'file', label: '文件（复制进来）', hint: '复制进白板' },
  { type: 'divider', label: '分隔线', hint: '一条横线' },
]

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 保存防抖：停手 500ms 再写，写的时候状态是真的 */
const SAVE_DELAY = 500

export function BoardEditor({
  host,
  path,
  onSave,
  onOpenFile,
  repoFiles = [],
  onRegisterDrop,
  renameHint,
  onRenameHintUsed,
  onNotice,
}: Props) {
  const [load, setLoad] = useState<Load>({ t: 'loading' })
  const [doc, setDoc] = useState<BoardFileDoc | null>(null)
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<Status>('saved')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showLinks, setShowLinks] = useState(false)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [addMenu, setAddMenu] = useState<{ x: number; y: number; afterId: string | null } | null>(null)
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<DropAt | null>(null)
  const [assetAsk, setAssetAsk] = useState<AssetAsk | null>(null)
  const [pickFile, setPickFile] = useState<AssetAsk | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [hideWarnings, setHideWarnings] = useState(false)
  const [lines, setLines] = useState<{ id: string; from: string; to: string; d: string }[]>([])
  /** 只为了在撤销栈变化时重渲染（按钮的禁用状态读的是 ref） */
  const [, bumpHistory] = useState(0)

  const docRef = useRef<BoardFileDoc | null>(null)
  const savedText = useRef('')
  const pending = useRef<BoardFileDoc | null>(null)
  const saveTimer = useRef(0)
  const titleTimer = useRef(0)
  const past = useRef<BoardFileDoc[]>([])
  const future = useRef<BoardFileDoc[]>([])
  const editKey = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  const editors = useRef(new Map<string, Editor>())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  /** 改名提示只影响"挂载后第一次读盘"，用 ref 读，免得改个名字就整篇重读 */
  const hintRef = useRef(renameHint)
  hintRef.current = renameHint
  const hintUsedRef = useRef(onRenameHintUsed)
  hintUsedRef.current = onRenameHintUsed

  const notify = useCallback(
    (text: string) => {
      setNotice(text)
      onNotice?.(text)
    },
    [onNotice],
  )

  /* ── 读盘 ── */

  useEffect(() => {
    let alive = true
    setLoad({ t: 'loading' })
    setDoc(null)
    docRef.current = null
    setStatus('saved')
    setError(null)
    setHideWarnings(false)
    past.current = []
    future.current = []
    bumpHistory(0)

    void (async () => {
      let text = ''
      try {
        text = decodeBytes(await host.read(path))
      } catch (e) {
        if (alive) setLoad({ t: 'bad', message: `读不出来：${msg(e)}` })
        return
      }
      const parsed = parseBoardFile(text, titleOfBoardPath(path))
      if (!alive) return
      if (parsed.kind === 'unsupported') {
        setLoad({ t: 'unsupported', message: parsed.message })
        return
      }
      if (parsed.kind === 'bad') {
        setLoad({ t: 'bad', message: parsed.message })
        return
      }
      savedText.current = text
      docRef.current = parsed.doc
      setDoc(parsed.doc)
      setTitle(parsed.doc.title)
      setLoad({ t: 'ok', doc: parsed.doc, warnings: parsed.warnings })

      /*
       * 刚在文件树里改过名：标题跟着改。
       * 不在改名那一刻直接改文件 —— 编辑器可能还有没落盘的改动，谁后写谁赢。
       * 这里读盘之后改一次，并立刻排一次保存，逻辑上只有一条时间线。
       */
      const hint = hintRef.current
      if (hint && hint !== parsed.doc.title) {
        const next = { ...parsed.doc, title: hint }
        docRef.current = next
        setDoc(next)
        setTitle(hint)
        pending.current = next
        setStatus('dirty')
        window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => {
          void flushRef.current()
        }, SAVE_DELAY)
      }
      if (hint) hintUsedRef.current?.(path)
    })()

    return () => {
      alive = false
    }
  }, [host, path])

  /* ── 保存 ── */

  const flush = useCallback(async () => {
    const job = pending.current
    if (!job) return
    const text = serializeBoardFile(job)
    if (text === savedText.current) {
      pending.current = null
      setStatus('saved')
      return
    }
    setStatus('saving')
    try {
      await onSaveRef.current(job.boardId, text)
      savedText.current = text
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
      setError(msg(e))
    }
  }, [])
  const flushRef = useRef(flush)
  flushRef.current = flush

  const schedule = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void flushRef.current()
    }, SAVE_DELAY)
  }, [])

  /** 落到内存 + 排一次保存。`key` 用来合并连续的同类编辑（打字不产生几十步撤销） */
  const commit = useCallback(
    (next: BoardFileDoc, key?: string) => {
      const prev = docRef.current
      if (prev && prev !== next) {
        const now = Date.now()
        const mergeable = Boolean(key) && editKey.current.key === key && now - editKey.current.at < 900
        if (!mergeable) {
          past.current.push(prev)
          if (past.current.length > 60) past.current.shift()
          future.current = []
        }
        editKey.current = { key: key ?? '', at: now }
        bumpHistory((n) => n + 1)
      }

      const stamped: BoardFileDoc = { ...next, updatedAt: new Date().toISOString() }
      docRef.current = stamped
      setDoc(stamped)
      pending.current = stamped
      setStatus('dirty')
      schedule()
    },
    [schedule],
  )

  const restore = useCallback(
    (next: BoardFileDoc) => {
      docRef.current = next
      setDoc(next)
      setTitle(next.title)
      pending.current = next
      setStatus('dirty')
      schedule()
    },
    [schedule],
  )

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (!prev) return
    const cur = docRef.current
    if (cur) future.current.push(cur)
    editKey.current = { key: '', at: 0 }
    bumpHistory((n) => n + 1)
    restore(prev)
  }, [restore])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    const cur = docRef.current
    if (cur) past.current.push(cur)
    editKey.current = { key: '', at: 0 }
    bumpHistory((n) => n + 1)
    restore(next)
  }, [restore])

  /* 关标签 / 切页前把没落的改动写下去 */
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
    const t = window.setTimeout(() => setNotice(null), 3600)
    return () => window.clearTimeout(t)
  }, [notice])

  useEffect(() => {
    if (!focusId) return
    const t = window.setTimeout(() => {
      editors.current.get(focusId)?.commands.focus('end')
      setFocusId(null)
    }, 80)
    return () => window.clearTimeout(t)
  }, [focusId])

  const registerEditor = useCallback((id: string, ed: Editor | null) => {
    if (ed) editors.current.set(id, ed)
    else editors.current.delete(id)
  }, [])

  /* ── 连接线：量出每块的位置，在左侧留白里画弧 ── */

  const measure = useCallback(() => {
    const box = listRef.current
    const cur = docRef.current
    if (!box || !cur) return
    const cards = new Map<string, HTMLElement>()
    for (const el of box.querySelectorAll<HTMLElement>('[data-dd-board-block]')) {
      cards.set(el.dataset.ddBoardBlock ?? '', el)
    }
    const out: { id: string; from: string; to: string; d: string }[] = []
    cur.links.forEach((link, i) => {
      const a = cards.get(link.from)
      const b = cards.get(link.to)
      if (!a || !b) return
      const y1 = a.offsetTop + a.offsetHeight / 2
      const y2 = b.offsetTop + b.offsetHeight / 2
      const x = 11
      // 同一对块之间可能有好几条连接：每条再往外偏一点，不至于完全叠在一起
      const bow = 15 + Math.min(18, Math.abs(y2 - y1) * 0.12) + (i % 3) * 5
      out.push({
        id: link.id,
        from: link.from,
        to: link.to,
        d: `M${x} ${y1} C ${x + bow} ${y1}, ${x + bow} ${y2}, ${x} ${y2}`,
      })
    })
    setLines(out)
  }, [])

  useLayoutEffect(() => {
    measure()
  }, [measure, doc?.layout.order, doc?.links, doc?.blocks])

  useEffect(() => {
    if (!listRef.current || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(listRef.current)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  /* ── 快捷键：撤销 / 重做（在块内打字时让 TipTap 自己管） ── */

  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = e.target as HTMLElement | null
    const inEditor = Boolean(el?.closest('.ProseMirror, input, textarea, select'))
    if (e.key === 'Escape') {
      setSelected(null)
      return
    }
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    if (e.key.toLowerCase() === 'z' && !inEditor) {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (e.key.toLowerCase() === 'y' && !inEditor) {
      e.preventDefault()
      redo()
    }
  }

  /* ── 块操作 ── */

  const cur = () => docRef.current

  const addBlock = (type: BoardBlockType, afterId: string | null) => {
    const d = cur()
    if (!d) return
    const id = nextBlockId(d)
    commit(insertBlock(d, afterId, newBlock(type, id)))
    setSelected(id)
    setFocusId(id)
  }

  const patchBlock = (id: string, patch: Partial<BoardBlock>) => {
    const d = cur()
    if (!d) return
    // 文字块用同一个 key 合并连续输入；勾选 / 换图这类一步一次
    const key = patch.content ? `text:${id}` : ''
    commit(updateBlock(d, id, patch), key)
  }

  const deleteBlock = (id: string) => {
    const d = cur()
    if (!d) return
    const at = d.layout.order.indexOf(id)
    const block = d.blocks[id]
    commit(removeBlock(d, id))
    setSelected(null)
    if (block && (block.type === 'image' || block.type === 'file') && block.src?.startsWith('.dusk/board/')) {
      notify('块已删除；复制进白板的文件没有自动删，避免误删你的资料')
    }
    const prev = d.layout.order[at - 1] ?? d.layout.order[at + 1] ?? null
    if (prev) setFocusId(prev)
  }

  const duplicate = (id: string) => {
    const d = cur()
    if (!d) return
    const r = duplicateBlock(d, id)
    if (!r) return
    commit(r.doc)
    setSelected(r.id)
    setFocusId(r.id)
  }

  const moveBlock = (id: string, step: -1 | 1) => {
    const d = cur()
    if (!d) return
    const at = d.layout.order.indexOf(id)
    if (at < 0) return
    const next = moveBlockTo(d, id, at + (step > 0 ? 2 : -1))
    if (next !== d) commit(next)
    setFocusId(id)
  }

  const handleDrop = () => {
    const d = cur()
    if (d && dragId && dropAt) {
      const target = dropAt.index + (dropAt.after ? 1 : 0)
      const next = moveBlockTo(d, dragId, target)
      if (next !== d) commit(next)
      setSelected(dragId)
    }
    setDropAt(null)
    setDragId(null)
  }

  const onCardDragOver = (e: React.DragEvent, index: number) => {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDropAt({ index, after: e.clientY > r.top + r.height / 2 })
  }

  /* ── 附件：复制 / 引用 ── */

  const requestAsset = (ask: AssetAsk) => {
    if (ask.mode === 'link') {
      setPickFile(ask)
      return
    }
    setAssetAsk(ask)
    if (fileRef.current) {
      fileRef.current.accept = ask.kind === 'image' ? 'image/*' : '*/*'
      fileRef.current.value = ''
      fileRef.current.click()
    }
  }

  /** 把一个 File 复制进白板（`.dusk/board/<boardId>/`），返回仓库内路径 */
  const copyInto = async (d: BoardFileDoc, file: File): Promise<string> => {
    await host.mkdir(copyDirOf(d.boardId))
    const dest = copyAssetPath(d.boardId, file.name)
    await host.write(dest, new Uint8Array(await file.arrayBuffer()))
    return dest
  }

  const insertAssetBlock = (d: BoardFileDoc, src: string, file: { name: string; size?: number }, kind: 'image' | 'file', afterId: string | null, source: BlockSource) => {
    const id = nextBlockId(d)
    const block: BoardBlock =
      kind === 'image'
        ? { ...newBlock('image', id), src, alt: '', source }
        : { ...newBlock('file', id), src, name: file.name, size: file.size, source }
    commit(insertBlock(d, afterId, block))
    setSelected(id)
    setFocusId(id)
  }

  const onAssetPicked = async (file: File) => {
    const ask = assetAsk
    setAssetAsk(null)
    const d = cur()
    if (!ask || !d) return
    try {
      const src = await copyInto(d, file)
      if (ask.id) patchBlock(ask.id, { src, source: 'copy', ...(ask.kind === 'file' ? { name: file.name, size: file.size } : {}) })
      else insertAssetBlock(d, src, file, ask.kind, ask.afterId, 'copy')
      notify(`「${file.name}」已复制进白板（原文件没动）`)
    } catch (e) {
      notify(`没能复制进来：${msg(e)}`)
    }
  }

  const onRepoPicked = (picked: string) => {
    const ask = pickFile
    setPickFile(null)
    const d = cur()
    if (!ask || !d) return
    const kind = ask.kind
    const name = picked.split('/').pop() ?? picked
    if (ask.id) {
      patchBlock(ask.id, { src: picked, source: 'link', ...(kind === 'file' ? { name } : {}) })
    } else {
      insertAssetBlock(d, picked, { name }, kind, ask.afterId, 'link')
    }
    notify(`已引用仓库里的 ${picked}（没有复制文件）`)
  }

  /** 从文件树拖进来 / 从系统拖进来：一律复制进白板 */
  const onDropFiles = async (files: File[], afterId: string | null) => {
    const d = cur()
    if (!d || files.length === 0) return
    let cursor = afterId
    let ok = 0
    for (const f of files) {
      try {
        const src = await copyInto(d, f)
        const img = f.type.startsWith('image/')
        const id = nextBlockId(docRef.current ?? d)
        const block: BoardBlock = img
          ? { ...newBlock('image', id), src, alt: '', source: 'copy' }
          : { ...newBlock('file', id), src, name: f.name, size: f.size, source: 'copy' }
        commit(insertBlock(docRef.current ?? d, cursor, block))
        cursor = id
        ok += 1
      } catch (e) {
        notify(`「${f.name}」没能复制进来：${msg(e)}`)
      }
    }
    if (ok) notify(`已把 ${ok} 个文件复制进这块白板（原文件没动）`)
  }

  /** 桌面端原生拖入：拿到的是绝对路径，先导入仓库再建块 */
  const addExternalPaths = async (paths: string[]) => {
    const d = cur()
    if (!d || paths.length === 0) return
    const { importPath } = await import('../../hosts/tauri')
    let cursor: string | null = d.layout.order[d.layout.order.length - 1] ?? null
    let ok = 0
    const bad: string[] = []
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() ?? p
      try {
        const dest = copyAssetPath(d.boardId, name)
        await importPath(p, host.where, dest)
        const id = nextBlockId(docRef.current ?? d)
        const img = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(name)
        const block: BoardBlock = img
          ? { ...newBlock('image', id), src: dest, alt: '', source: 'copy' }
          : { ...newBlock('file', id), src: dest, name, source: 'copy' }
        commit(insertBlock(docRef.current ?? d, cursor, block))
        cursor = id
        ok += 1
      } catch (e) {
        bad.push(`${name}（${msg(e)}）`)
      }
    }
    if (ok) notify(`已把 ${ok} 个文件复制进这块白板（原文件没动）`)
    if (bad.length) notify(`这些没能导入：${bad.join('；')}`)
  }

  /** 从文件树拖一个文件进来 = **引用**（不复制）。拖的是系统文件 = 复制。 */
  const referenceRepoPath = (p: string, afterId: string | null) => {
    const d = cur()
    if (!d) return
    const hit = repoFiles.find((f) => f.path === p)
    if (!hit) return
    const img = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(p)
    insertAssetBlock(d, p, { name: hit.label }, img ? 'image' : 'file', afterId, 'link')
    notify(`已引用仓库里的 ${p}（没有复制文件）`)
  }

  useEffect(() => {
    if (!onRegisterDrop) return
    onRegisterDrop(path, (paths) => void addExternalPaths(paths))
    return () => onRegisterDrop(path, null)
    // addExternalPaths 每次渲染都是新的，但里面只读 ref —— 故意不放进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, onRegisterDrop])

  /* ── 菜单 ── */

  const blockMenu = (id: string): MenuItem[] => {
    const d = cur()
    const block = d?.blocks[id]
    if (!d || !block) return []
    const items: MenuItem[] = [
      { label: '在下方添加文字', onSelect: () => addBlock('paragraph', id) },
      { label: '复制这个块', onSelect: () => duplicate(id) },
      { label: '上移', onSelect: () => moveBlock(id, -1) },
      { label: '下移', onSelect: () => moveBlock(id, 1) },
      { divider: true, label: '', onSelect: () => {} },
      { label: '连接到…', onSelect: () => setLinkFrom(id) },
    ]
    if (block.type === 'image') {
      items.splice(3, 0, { label: '更换图片（复制进来）…', onSelect: () => requestAsset({ mode: 'copy', kind: 'image', id, afterId: null }) })
      items.splice(4, 0, { label: '改为引用仓库图片…', onSelect: () => requestAsset({ mode: 'link', kind: 'image', id, afterId: null }) })
    }
    if (block.type === 'file') {
      items.splice(3, 0, { label: '更换文件（复制进来）…', onSelect: () => requestAsset({ mode: 'copy', kind: 'file', id, afterId: null }) })
      items.splice(4, 0, { label: '改为引用仓库文件…', onSelect: () => requestAsset({ mode: 'link', kind: 'file', id, afterId: null }) })
    }
    items.push({ divider: true, label: '', onSelect: () => {} })
    items.push({ label: '删除这个块', danger: true, onSelect: () => deleteBlock(id) })
    return items
  }

  const addMenuItems = (afterId: string | null): MenuItem[] => [
    ...ADD_TYPES.map((t) => ({
      label: t.label,
      onSelect: () => {
        if (t.type === 'image' || t.type === 'file') {
          requestAsset({ mode: 'copy', kind: t.type, afterId })
        } else {
          addBlock(t.type, afterId)
        }
      },
    })),
    { divider: true, label: '', onSelect: () => {} },
    { label: '引用仓库里的文件…', onSelect: () => requestAsset({ mode: 'link', kind: 'file', afterId }) },
    { label: '引用仓库里的图片…', onSelect: () => requestAsset({ mode: 'link', kind: 'image', afterId }) },
  ]

  const saveLink = (rel: { to: string; type: LinkType; label: string }) => {
    const d = cur()
    if (!d || !linkFrom) return
    const link: BoardLink = {
      id: `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      from: linkFrom,
      to: rel.to,
      type: rel.type,
      label: rel.label,
      createdAt: Date.now(),
    }
    commit(addLink(d, link))
    setLinkFrom(null)
    setShowLinks(true)
  }

  const scrollToBlock = (id: string) => {
    const el = listRef.current?.querySelector(`[data-dd-board-block="${id}"]`) as HTMLElement | null
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(id)
    window.setTimeout(() => setFlash((c) => (c === id ? null : c)), 1600)
  }

  /* ── 渲染 ── */

  if (load.t === 'loading') {
    return <div className="grid h-full place-items-center text-[12.5px] text-ink-3">正在打开白板…</div>
  }

  if (load.t === 'unsupported' || load.t === 'bad') {
    return (
      <div className="grid h-full place-items-center px-8">
        <div className="max-w-[420px] text-center">
          <p className="text-[13.5px] font-medium text-ink">
            {load.t === 'unsupported' ? '这块白板打不开' : '这不是一块能编辑的白板'}
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">{load.message}</p>
          <p className="mt-2 font-mono text-[10.5px] break-all text-ink-3/80">{path}</p>
        </div>
      </div>
    )
  }

  if (!doc) return null

  const activeId = hover ?? selected
  const linkCount = doc.links.length
  const lastId = doc.layout.order.length ? (doc.layout.order[doc.layout.order.length - 1] ?? null) : null

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-paper" onKeyDown={onKeyDown}>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="rounded-full bg-green-soft px-2 py-0.5 text-[10.5px] tracking-wide text-green">
          .board · 白板
        </span>
        <span
          aria-live="polite"
          className={[
            'text-[10.5px]',
            status === 'error' ? 'text-[#8f1d17]' : status === 'saving' ? 'text-ink-2' : 'text-ink-3',
          ].join(' ')}
        >
          {status === 'saved'
            ? '已保存'
            : status === 'saving'
              ? '保存中…'
              : status === 'error'
                ? '保存失败'
                : '未保存'}
        </span>
        <span className="flex-1" />

        <button
          type="button"
          onClick={undo}
          disabled={past.current.length === 0}
          title="撤销（Ctrl+Z）"
          aria-label="撤销"
          className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink-2 disabled:opacity-35"
        >
          <Undo2 className="size-4" />
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={future.current.length === 0}
          title="重做（Ctrl+Shift+Z）"
          aria-label="重做"
          className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink-2 disabled:opacity-35"
        >
          <Redo2 className="size-4" />
        </button>

        <button
          type="button"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setAddMenu({ x: r.left, y: r.bottom + 4, afterId: null })
          }}
          className="inline-flex items-center gap-1 rounded-md bg-green px-2.5 py-1 text-[11.5px] text-white hover:bg-green-deep"
        >
          <Plus className="size-3.5" />
          添加块
        </button>
        <button
          type="button"
          onClick={() => setShowLinks((v) => !v)}
          aria-pressed={showLinks}
          className={[
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px]',
            showLinks
              ? 'border-green/40 bg-green-soft text-green'
              : 'border-line text-ink-2 hover:bg-surface-2',
          ].join(' ')}
        >
          <Link2 className="size-3.5" />
          连接 {linkCount}
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          data-dd-board-scroll=""
          className="min-h-0 flex-1 overflow-y-auto"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              return
            }
            // 从左侧文件树拖进来的：落下来是"引用"，不是复制
            if (e.dataTransfer.types.includes('text/plain')) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'link'
            }
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length > 0) {
              e.preventDefault()
              void onDropFiles([...e.dataTransfer.files], lastId)
              return
            }
            const p = e.dataTransfer.getData('text/plain')
            if (p) {
              e.preventDefault()
              referenceRepoPath(p, lastId)
            }
          }}
        >
          <div className="mx-auto w-full px-12 pt-8 pb-40" style={{ maxWidth: 'var(--dd-cw)' }}>
            <input
              value={title}
              onChange={(e) => {
                const v = e.target.value
                setTitle(v)
                window.clearTimeout(titleTimer.current)
                titleTimer.current = window.setTimeout(() => {
                  const d = docRef.current
                  if (!d) return
                  commit({ ...d, title: v }, 'title')
                }, 400)
              }}
              onBlur={() => {
                const d = docRef.current
                if (!d) return
                window.clearTimeout(titleTimer.current)
                commit({ ...d, title: title.trim() || titleOfBoardPath(path) }, 'title')
              }}
              aria-label="白板标题"
              placeholder="无标题白板"
              className="dd-board-title"
            />
            <div className="mb-4 flex flex-wrap items-center gap-2 text-[10.5px] text-ink-3">
              <span>{doc.layout.order.length} 块</span>
              <span className="opacity-50">·</span>
              <span>{linkCount} 条连接</span>
              <span className="opacity-50">·</span>
              <span>拖动左侧手柄换顺序；Alt+↑/↓ 也可以</span>
              <span className="opacity-50">·</span>
              <span className="font-mono">{doc.boardId}</span>
            </div>

            {load.warnings.length > 0 && !hideWarnings ? (
              <div role="status" className="mb-4 rounded-lg border border-[#f0e2c4] bg-[#fdf8ec] px-3 py-2">
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 text-[11px] leading-relaxed break-words text-[#7a5b18]">
                    {load.warnings.join('；')}
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

            {doc.layout.mode === 'free' ? (
              <p className="mb-4 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11px] text-ink-2">
                这块白板标记为自由排布（free）。自由画布视图还没做，先按纵向显示；坐标数据原样保留，不会丢。
              </p>
            ) : null}

            {doc.layout.order.length === 0 ? (
              <div className="mt-8 rounded-xl border border-dashed border-line px-6 py-12 text-center">
                <p className="text-[14px] text-ink-2">这块白板还是空的</p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
                  块是独立的小卡片：文字、待办、引用、图片、文件都能单独放、单独拖，还能连起来。
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

            {/* pl-10 = 左侧那条留白：连接线画在里面，拖动手柄也停在那儿，不压正文 */}
            <div ref={listRef} className="relative flex flex-col gap-2 pl-10">
              {lines.length > 0 ? (
                <svg
                  aria-hidden
                  className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                  data-dd-board-links
                >
                  {lines.map((l) => {
                    const hot = activeId === l.from || activeId === l.to
                    return (
                      <path
                        key={l.id}
                        d={l.d}
                        fill="none"
                        stroke={hot ? 'var(--color-green)' : 'var(--color-ink-3)'}
                        strokeWidth={hot ? 1.7 : 1.3}
                        strokeOpacity={hot ? 0.95 : 0.5}
                        strokeLinecap="round"
                        data-link={l.id}
                      />
                    )
                  })}
                </svg>
              ) : null}

              {doc.layout.order.map((id, index) => {
                const block = doc.blocks[id]
                if (!block) return null
                return (
                  <Fragment key={id}>
                    {dropAt && dropAt.index === index && !dropAt.after ? <DropLine /> : null}
                    <BoardBlockCard
                      host={host}
                      block={block}
                      index={index}
                      autoFocus={focusId === id}
                      selected={selected === id}
                      flash={flash === id}
                      linkCount={linksOf(doc, id).length}
                      onChange={patchBlock}
                      onMenu={(blockId, x, y) => setMenu({ id: blockId, x, y })}
                      onSelect={setSelected}
                      onHover={setHover}
                      onEnterEnd={(blockId) => addBlock('paragraph', blockId)}
                      onBackspaceEmpty={deleteBlock}
                      onEditor={registerEditor}
                      onDragStart={setDragId}
                      onDragEnd={() => {
                        setDragId(null)
                        setDropAt(null)
                      }}
                      onDragOver={onCardDragOver}
                      onDrop={handleDrop}
                      onPickAsset={(blockId, kind, mode) =>
                        requestAsset({ mode, kind, id: blockId, afterId: null })
                      }
                      onOpenFile={(p) => onOpenFile?.(p)}
                      onShowLinks={() => setShowLinks(true)}
                      onMove={moveBlock}
                      onNotice={notify}
                    />
                    {dropAt && dropAt.index === index && dropAt.after ? <DropLine /> : null}
                  </Fragment>
                )
              })}

              <div
                className="mt-1 flex h-16 items-center justify-center rounded-lg border border-dashed border-line/70 text-[11px] text-ink-3/60"
                onDragOver={(e) => {
                  if (!dragId) return
                  e.preventDefault()
                  setDropAt({ index: doc.layout.order.length, after: false })
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
                  在末尾添加一个文字块
                </button>
              </div>
            </div>
          </div>
        </div>

        {showLinks ? (
          <aside
            aria-label="块间连接"
            className="flex w-[280px] shrink-0 flex-col border-l border-line bg-surface"
          >
            <header className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2.5">
              <Link2 className="size-3.5 text-ink-3" />
              <span className="text-[11.5px] text-ink-2">连接 {linkCount}</span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setShowLinks(false)}
                aria-label="收起连接面板"
                className="grid size-6 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink-2"
              >
                <X className="size-3.5" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {doc.links.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-ink-3">
                  还没有连接。点任意块左侧 <span className="font-mono">⋯</span> → 「连接到…」，
                  选目标块和关系类型。连好的两块之间会在左侧出现一条弧线。
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {doc.links.map((link) => {
                    const from = doc.blocks[link.from]
                    const to = doc.blocks[link.to]
                    const typeLabel = LINK_TYPES.find((t) => t.id === link.type)?.label ?? link.type
                    return (
                      <li
                        key={link.id}
                        className="group rounded-lg border border-line bg-surface px-2 py-1.5"
                        data-dd-board-link-row={link.id}
                      >
                        <div className="flex items-center gap-1">
                          <span className="rounded bg-surface-2 px-1 py-[1px] text-[9.5px] text-ink-3">
                            {typeLabel}
                          </span>
                          <span className="flex-1" />
                          <button
                            type="button"
                            aria-label="删除连接"
                            onClick={() => commit(removeLink(docRef.current ?? doc, link.id))}
                            className="rounded p-0.5 text-ink-3 opacity-0 hover:bg-surface-2 hover:text-[#b3261e] group-hover:opacity-100"
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            if (to) scrollToBlock(link.to)
                            else if (from) scrollToBlock(link.from)
                          }}
                          className="mt-1 block w-full text-left text-[10.5px] leading-relaxed text-ink-2 hover:text-green"
                        >
                          <span className="block truncate">{blockLabel(from, link.from)}</span>
                          <span className="block pl-1 text-ink-3">→ {blockLabel(to, link.to)}</span>
                        </button>
                        {link.label ? (
                          <p className="mt-1 border-t border-line/60 pt-1 text-[10.5px] leading-relaxed break-words text-ink-3">
                            {link.label}
                          </p>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
              <p className="mt-2 px-2 text-[10px] leading-relaxed text-ink-3/70">
                连接只表示块之间的关系，不会移动块，也不会改变顺序。
              </p>
            </div>
          </aside>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-t border-[#f0c9c5] bg-[#fdf0ef] px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-[#8f1d17]">
            保存失败：{error}（改动还在，可以重试）
          </span>
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
        <ContextMenu x={menu.x} y={menu.y} items={blockMenu(menu.id)} onClose={() => setMenu(null)} />
      ) : null}

      {addMenu ? (
        <ContextMenu
          x={addMenu.x}
          y={addMenu.y}
          items={addMenuItems(addMenu.afterId)}
          onClose={() => setAddMenu(null)}
        />
      ) : null}

      {linkFrom ? (
        <RelationDialog
          fromId={linkFrom}
          blocks={doc.layout.order
            .map((id) => doc.blocks[id])
            .filter((b): b is BoardBlock => Boolean(b))
            .map((b) => ({ id: b.id, label: blockLabel(b, b.id) }))}
          onSave={saveLink}
          onClose={() => setLinkFrom(null)}
        />
      ) : null}

      {pickFile ? (
        <RepoFileDialog files={repoFiles} onPick={onRepoPicked} onClose={() => setPickFile(null)} />
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
