/*
 * `.board` 白板编辑器（**无限画布**）。
 *
 * ## 它和 `.note` 的区别
 *
 *   `.note` 是**一篇文档**：块竖着排，顺序就是阅读顺序，存成一整个目录。
 *   `.board` 是**一块空间**：每块有自己的坐标（`layout.pos`），想放哪儿放哪儿；
 *   画布能无限平移、缩放。顺序在画布上没有排版意义 —— 只作为稳定的枚举顺序留着。
 *
 * ## 三条硬规矩
 *
 *   ① **保存状态必须是真的**。保存失败就停在"保存失败"并留着待存数据，
 *      绝不显示"已保存"而磁盘上其实没写（重试按钮会再写一次）。
 *   ② **改一块只改这一块**。所有编辑走 core 里的纯函数，块内容、坐标、连接互不牵连。
 *   ③ **未知块原样保留**。认不出的块显示成"由更新版本创建"，保存时一个字节不改。
 *
 * 视口（平移到哪儿、缩放多少）是**纯 UI 状态**，存本机 localStorage，不进仓库文件。
 */
import type { Editor } from '@tiptap/core'
import { Link2, Plus, Redo2, RotateCw, Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type AnchorSide,
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
  defaultWidth,
  duplicateBlock,
  insertBlock,
  layoutOf,
  newBlock,
  nextBlockId,
  parseBoardFile,
  removeBlock,
  removeLink,
  reverseLink,
  serializeBoardFile,
  setPos,
  titleOfBoardPath,
  updateBlock,
  updateLink,
} from '../../core/board/file'
import { decodeBytes } from '../../core/model/text'
import type { Host } from '../../core/ports/host'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { RelationDialog } from '../note/RelationDialog'
import { BoardCanvas, type CanvasApi } from './BoardCanvas'
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
type AssetAsk = {
  mode: 'copy' | 'link'
  kind: 'image' | 'file'
  /** 换图 / 换文件时指到某一块；新建时为空 */
  id?: string
  /** 落点（世界坐标）；null = 交给画布找空位 */
  at: { x: number; y: number } | null
  afterId: string | null
}

const ADD_TYPES: { type: BoardBlockType; label: string }[] = [
  { type: 'paragraph', label: '文字' },
  { type: 'heading1', label: '标题' },
  { type: 'heading2', label: '小标题' },
  { type: 'todo', label: '待办' },
  { type: 'quote', label: '引用' },
  { type: 'image', label: '图片（复制进来）' },
  { type: 'file', label: '文件（复制进来）' },
  { type: 'divider', label: '分隔线' },
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
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  /** 正在编辑的连接 id（改类型 / 说明 / 目标） */
  const [linkEdit, setLinkEdit] = useState<string | null>(null)
  /** 当前"活"着的那一块：内容能点、能编辑。默认没有 —— 整块只负责拖动 */
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 「点谁连谁」的源块 */
  const [linkPick, setLinkPick] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedLink, setSelectedLink] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [hideWarnings, setHideWarnings] = useState(false)
  const [assetAsk, setAssetAsk] = useState<AssetAsk | null>(null)
  const [pickFile, setPickFile] = useState<AssetAsk | null>(null)
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
  const fileRef = useRef<HTMLInputElement | null>(null)
  const canvasRef = useRef<CanvasApi | null>(null)
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
    setSelected(null)
    setSelectedLink(null)
    setActiveId(null)
    setLinkPick(null)
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

  /** 落到内存 + 排一次保存。`key` 用来合并连续的同类编辑（打字/方向键微调不产生几十步撤销） */
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
    setSelected((s) => (s && prev.blocks[s] ? s : null))
    setSelectedLink(null)
    setActiveId((s) => (s && prev.blocks[s] ? s : null))
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

  /* 新块 / 新加图片：把焦点交给它的编辑器 */
  useEffect(() => {
    if (!focusId) return
    const t = window.setTimeout(() => {
      editors.current.get(focusId)?.commands.focus('end')
      setFocusId(null)
    }, 90)
    return () => window.clearTimeout(t)
  }, [focusId])

  const registerEditor = useCallback((id: string, ed: Editor | null) => {
    if (ed) editors.current.set(id, ed)
    else editors.current.delete(id)
  }, [])

  /* ── 块操作 ── */

  const addAt = (at: { x: number; y: number }, type: BoardBlockType, afterId: string | null) => {
    const d = docRef.current
    if (!d) return
    const id = nextBlockId(d)
    let next = insertBlock(d, afterId, newBlock(type, id))
    next = setPos(next, id, { x: Math.round(at.x), y: Math.round(at.y), w: defaultWidth(type) })
    commit(next)
    setSelected(id)
    setSelectedLink(null)
    setActiveId(id)
    setFocusId(id)
  }

  const patchBlock = (id: string, patch: Partial<BoardBlock>) => {
    const d = docRef.current
    if (!d) return
    // 文字块用同一个 key 合并连续输入；勾选 / 换图这类一步一次
    const key = patch.content ? `text:${id}` : ''
    commit(updateBlock(d, id, patch), key)
  }

  const moveTo = (id: string, pos: { x: number; y: number; w?: number }) => {
    const d = docRef.current
    if (!d) return
    commit(setPos(d, id, pos))
  }

  const removeOne = (id: string) => {
    const d = docRef.current
    if (!d) return
    const block = d.blocks[id]
    commit(removeBlock(d, id))
    setSelected(null)
    setSelectedLink(null)
    if (activeId === id) setActiveId(null)
    if (
      block &&
      (block.type === 'image' || block.type === 'file') &&
      block.src?.startsWith('.dusk/board/')
    ) {
      notify('块已删除；复制进白板的文件没有自动删，避免误删你的资料')
    }
  }

  const duplicate = (id: string) => {
    const d = docRef.current
    if (!d) return
    const r = duplicateBlock(d, id)
    if (!r) return
    commit(r.doc)
    setSelected(r.id)
    setFocusId(r.id)
  }

  /* ── 键盘：选中块之后才生效，在编辑器里打字一律让编辑器自己处理 ── */

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    if (t?.closest('input, textarea, select')) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    /*
     * 在块里打字时，撤销/删除这些一律交给块自己的编辑器 —— 它有自己的历史，
     * 混着用会一步退两下。**例外**：刚加出来还是空的块，编辑器历史是空的，
     * Ctrl+Z 在那儿等于按了没反应，这时交给画布撤销（把那块收回去）。
     */
    const pm = t?.closest('.ProseMirror') as HTMLElement | null
    const pmEmpty = pm ? (pm.textContent ?? '').trim().length === 0 : false
    if (pm && !pmEmpty) return
    if (pm && pmEmpty && !(mod && (k === 'z' || k === 'y'))) return

    if (mod && k === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (mod && k === 'y') {
      e.preventDefault()
      redo()
      return
    }
    if (mod && e.key === '0') {
      e.preventDefault()
      canvasRef.current?.fit()
      return
    }
    if (mod && e.key === '1') {
      e.preventDefault()
      canvasRef.current?.setZoom(1)
      return
    }
    if (e.key === 'Escape') {
      setSelected(null)
      setSelectedLink(null)
      setLinkPick(null)
      setActiveId(null)
      return
    }
    if (mod && k === 'd' && selected) {
      e.preventDefault()
      duplicate(selected)
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const d = docRef.current
      if (!d) return
      if (selectedLink) {
        e.preventDefault()
        commit(removeLink(d, selectedLink))
        setSelectedLink(null)
        return
      }
      if (selected) {
        e.preventDefault()
        removeOne(selected)
      }
      return
    }
    if (selected && e.key.startsWith('Arrow')) {
      const d = docRef.current
      if (!d) return
      const step = e.shiftKey ? 40 : 8
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
      if (!dx && !dy) return
      e.preventDefault()
      const at = layoutOf(d)[selected]
      if (at) commit(setPos(d, selected, { ...at, x: at.x + dx, y: at.y + dy }), `pos:${selected}`)
    }
  }
  useEffect(() => {
    const fn = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [])

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

  const insertAssetBlock = (
    d: BoardFileDoc,
    src: string,
    file: { name: string; size?: number },
    kind: 'image' | 'file',
    at: { x: number; y: number } | null,
    afterId: string | null,
    source: BlockSource,
  ) => {
    const id = nextBlockId(d)
    const block: BoardBlock =
      kind === 'image'
        ? { ...newBlock('image', id), src, alt: '', source }
        : { ...newBlock('file', id), src, name: file.name, size: file.size, source }
    let next = insertBlock(d, afterId, block)
    // 落点已知就摆在那儿；不知道（菜单里加的）就交给画布找一块空地
    const spot = at ?? canvasRef.current?.nextSpot(kind) ?? { x: 0, y: 0 }
    next = setPos(next, id, { ...spot, w: defaultWidth(kind) })
    commit(next)
    setSelected(id)
    setActiveId(id)
    setFocusId(id)
  }

  const onAssetPicked = async (file: File) => {
    const ask = assetAsk
    setAssetAsk(null)
    const d = docRef.current
    if (!ask || !d) return
    try {
      const src = await copyInto(d, file)
      if (ask.id) {
        patchBlock(ask.id, {
          src,
          source: 'copy',
          ...(ask.kind === 'file' ? { name: file.name, size: file.size } : {}),
        })
      } else {
        insertAssetBlock(d, src, file, ask.kind, ask.at, ask.afterId, 'copy')
      }
      notify(`「${file.name}」已复制进白板（原文件没动）`)
    } catch (e) {
      notify(`没能复制进来：${msg(e)}`)
    }
  }

  const onRepoPicked = (picked: string) => {
    const ask = pickFile
    setPickFile(null)
    const d = docRef.current
    if (!ask || !d) return
    const kind = ask.kind
    const name = picked.split('/').pop() ?? picked
    if (ask.id) {
      patchBlock(ask.id, { src: picked, source: 'link', ...(kind === 'file' ? { name } : {}) })
    } else {
      insertAssetBlock(d, picked, { name }, kind, ask.at, ask.afterId, 'link')
    }
    notify(`已引用仓库里的 ${picked}（没有复制文件）`)
  }

  /** 从系统拖进来：一律复制进白板，落在鼠标那儿 */
  const dropFiles = async (files: File[], at: { x: number; y: number }) => {
    const d = docRef.current
    if (!d || files.length === 0) return
    let ok = 0
    let cursor = at
    for (const f of files) {
      try {
        const src = await copyInto(d, f)
        const img = f.type.startsWith('image/')
        const id = nextBlockId(docRef.current ?? d)
        const block: BoardBlock = img
          ? { ...newBlock('image', id), src, alt: '', source: 'copy' }
          : { ...newBlock('file', id), src, name: f.name, size: f.size, source: 'copy' }
        let next = insertBlock(docRef.current ?? d, null, block)
        next = setPos(next, id, {
          x: Math.round(cursor.x),
          y: Math.round(cursor.y),
          w: defaultWidth(block.type),
        })
        commit(next)
        setSelected(id)
        cursor = { x: cursor.x + 36, y: cursor.y + 36 }
        ok += 1
      } catch (e) {
        notify(`「${f.name}」没能复制进来：${msg(e)}`)
      }
    }
    if (ok) notify(`已把 ${ok} 个文件复制进这块白板（原文件没动）`)
  }

  /** 从文件树拖进来 = **引用**（不复制） */
  const referencePath = (p: string, at: { x: number; y: number }) => {
    const d = docRef.current
    if (!d) return
    const hit = repoFiles.find((f) => f.path === p)
    if (!hit) return
    const img = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(p)
    insertAssetBlock(d, p, { name: hit.label }, img ? 'image' : 'file', at, null, 'link')
    notify(`已引用仓库里的 ${p}（没有复制文件）`)
  }

  /** 桌面端原生拖入：拿到的是绝对路径，先导入仓库再摆到视口中心附近 */
  const addExternalPaths = async (paths: string[]) => {
    const d = docRef.current
    if (!d || paths.length === 0) return
    const { importPath } = await import('../../hosts/tauri')
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
        let next = insertBlock(docRef.current ?? d, null, block)
        const spot = canvasRef.current?.nextSpot(block.type) ?? { x: 0, y: 0 }
        next = setPos(next, id, { ...spot, w: defaultWidth(block.type) })
        commit(next)
        ok += 1
      } catch (e) {
        bad.push(`${name}（${msg(e)}）`)
      }
    }
    if (ok) notify(`已把 ${ok} 个文件复制进这块白板（原文件没动）`)
    if (bad.length) notify(`这些没能导入：${bad.join('；')}`)
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
    const d = docRef.current
    const block = d?.blocks[id]
    if (!d || !block) return []
    const items: MenuItem[] = [
      { label: '复制这个块', onSelect: () => duplicate(id) },
      { label: '连接到…', onSelect: () => setLinkFrom(id) },
    ]
    if (block.type === 'image' || block.type === 'file') {
      const kind = block.type
      const what = kind === 'image' ? '图片' : '文件'
      items.push(
        { divider: true, label: '', onSelect: () => {} },
        {
          label: `更换${what}（复制进来）…`,
          onSelect: () => requestAsset({ mode: 'copy', kind, id, at: null, afterId: null }),
        },
        {
          label: `改为引用仓库${what}…`,
          onSelect: () => requestAsset({ mode: 'link', kind, id, at: null, afterId: null }),
        },
      )
    }
    items.push({ divider: true, label: '', onSelect: () => {} })
    items.push({ label: '删除这个块', danger: true, onSelect: () => removeOne(id) })
    return items
  }

  const addMenuItems = (): MenuItem[] => [
    ...ADD_TYPES.map((t) => ({
      label: t.label,
      onSelect: () => {
        if (t.type === 'image' || t.type === 'file') {
          requestAsset({ mode: 'copy', kind: t.type, at: null, afterId: null })
        } else {
          canvasRef.current?.addAtCenter(t.type)
        }
      },
    })),
    { divider: true, label: '', onSelect: () => {} },
    {
      label: '引用仓库里的文件…',
      onSelect: () => requestAsset({ mode: 'link', kind: 'file', at: null, afterId: null }),
    },
    {
      label: '引用仓库里的图片…',
      onSelect: () => requestAsset({ mode: 'link', kind: 'image', at: null, afterId: null }),
    },
  ]

  const saveLink = (rel: { to: string; type: LinkType; label: string }) => {
    const d = docRef.current
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

  /* ── 连接：拖出来 / 改 / 反向 / 删 ── */

  /**
   * 双击一块 = 让它"活过来"：内容能点、能编辑、能选中文字。
   * 没激活的时候整块只是一个可拖的卡片，点哪儿都是拖。
   */
  const activate = (id: string | null) => {
    setActiveId(id)
    if (!id) return
    setSelected(id)
    setSelectedLink(null)
    setFocusId(id)
  }

  /**
   * 从锚点拖到另一块松手。
   *
   * 这里只补一条默认的「相关」连接 —— 拖拽的意图是"这两块有关系"，
   * 类型和说明可以之后再改（选中线就有工具条）。要是先弹对话框，
   * 拖一下被打断一次，画布上根本连不成串。
   */
  const createLink = (from: string, to: string, fromSide: AnchorSide, toSide: AnchorSide | null) => {
    const d = docRef.current
    if (!d || from === to) return
    const exists = d.links.find((l) => l.from === from && l.to === to)
    if (exists) {
      setSelected(null)
      setSelectedLink(exists.id)
      notify('这两块之间已经有连接了；点住那条线可以改类型或加说明')
      return
    }
    const link: BoardLink = {
      id: `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      from,
      to,
      type: 'related',
      label: '',
      ...(fromSide ? { fromSide } : {}),
      ...(toSide ? { toSide } : {}),
      createdAt: Date.now(),
    }
    commit(addLink(d, link))
    setSelected(null)
    setSelectedLink(link.id)
    notify(
      `已连接「${blockLabel(d.blocks[from], from)}」→「${blockLabel(d.blocks[to], to)}」；点这条线可改类型`,
    )
  }

  /**
   * 工具条上的「连接到…」：进入"点谁连谁"——一条线跟着鼠标，点中哪块就连哪块。
   * 点空白 / 按 Esc / 再点一次源块，都算取消。
   */
  const pickTarget = (to: string | null, sides?: { from: AnchorSide; to: AnchorSide | null }) => {
    const from = linkPick
    setLinkPick(null)
    if (!from) return
    if (!to || to === from) {
      notify('没连上：要点另一张卡片（点空白或按 Esc 取消）')
      return
    }
    createLink(from, to, sides?.from ?? 'right', sides?.to ?? null)
  }

  const editLink = (rel: { to: string; type: LinkType; label: string }) => {
    const d = docRef.current
    const id = linkEdit
    if (!d || !id) return
    const cur = d.links.find((l) => l.id === id)
    if (!cur) return
    setLinkEdit(null)
    commit(
      updateLink(d, id, {
        to: rel.to,
        type: rel.type,
        label: rel.label,
        // 目标换了，原来的入线锚点可能不再朝向起点 —— 清掉，让它按新位置自己选边
        ...(rel.to !== cur.to ? { toSide: undefined } : {}),
      }),
    )
    setSelectedLink(id)
    notify('连接已更新')
  }

  const flipLink = (id: string) => {
    const d = docRef.current
    if (!d) return
    const l = d.links.find((x) => x.id === id)
    if (!l) return
    if (d.links.some((x) => x.id !== id && x.from === l.to && x.to === l.from)) {
      notify('反方向已经有一条连接了，先删掉那条再转')
      return
    }
    commit(reverseLink(d, id))
    setSelectedLink(id)
    notify('方向已调转')
  }

  const dropLink = (id: string) => {
    const d = docRef.current
    if (!d) return
    commit(removeLink(d, id))
    setSelectedLink(null)
    notify('连接已删除（两块本身都还在）')
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

  const linkCount = doc.links.length
  const editingLink = linkEdit ? (doc.links.find((l) => l.id === linkEdit) ?? null) : null
  const dialogBlocks = doc.layout.order
    .map((id) => doc.blocks[id])
    .filter((b): b is BoardBlock => Boolean(b))
    .map((b) => ({ id: b.id, label: blockLabel(b, b.id) }))

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-paper">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <span
          className="shrink-0 rounded-full bg-green-soft px-2 py-0.5 text-[10.5px] tracking-wide text-green"
          title={doc.boardId}
        >
          .board · 画布
        </span>
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
          className="h-7 min-w-0 max-w-[18rem] shrink rounded-md border border-transparent bg-transparent px-1.5 text-[13px] font-medium text-ink outline-none hover:border-line focus:border-green/45 focus:bg-surface"
        />
        <span
          aria-live="polite"
          className={[
            'shrink-0 text-[10.5px]',
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
            setAddMenu({ x: r.left, y: r.bottom + 4 })
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-green px-2.5 py-1 text-[11.5px] text-white hover:bg-green-deep"
        >
          <Plus className="size-3.5" />
          添加元素
        </button>
        <button
          type="button"
          onClick={() => setShowLinks((v) => !v)}
          aria-pressed={showLinks}
          className={[
            'inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11.5px]',
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
        <BoardCanvas
          ref={canvasRef}
          doc={doc}
          host={host}
          selected={selected}
          selectedLink={selectedLink}
          focusId={focusId}
          active={activeId}
          linkPick={linkPick}
          onSelect={(id) => {
            setSelected(id)
            if (id) setSelectedLink(null)
          }}
          onSelectLink={setSelectedLink}
          onActivate={activate}
          onPickTarget={pickTarget}
          onMove={moveTo}
          onChange={patchBlock}
          onMenu={(id, x, y) => setMenu({ id, x, y })}
          onDuplicate={duplicate}
          onDelete={removeOne}
          onConnect={(id) => {
            setLinkPick(id)
            setActiveId(null)
            setSelectedLink(null)
            notify('点另一张卡片就连上；点空白或按 Esc 取消')
          }}
          onCreateLink={createLink}
          onEditLink={(id) => setLinkEdit(id)}
          onReverseLink={flipLink}
          onDeleteLink={dropLink}
          onAdd={addAt}
          onEditor={registerEditor}
          onDropFiles={(files, at) => void dropFiles(files, at)}
          onReferencePath={referencePath}
          onOpenFile={(p) => onOpenFile?.(p)}
          onNotice={notify}
        />

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
                  还没有连接。两种办法：<br />
                  ① 从卡片边上的小圆点，拖到另一块；<br />
                  ② 选中一块，点工具条上的链接按钮 —— 线会跟着鼠标走，点哪块就连哪块。
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
                            canvasRef.current?.centerOn(to ? link.to : link.from)
                            setSelectedLink(link.id)
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
                连接只表示块之间的关系，不会移动块。点一条线可以改类型、调转方向或删除；
                <span className="text-ink-3/80">双击线两端的小圆点直接断开</span>。点条目能把目标块居中。
              </p>
            </div>
          </aside>
        ) : null}
      </div>

      {load.warnings.length > 0 && !hideWarnings ? (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2 border-t border-[#f0e2c4] bg-[#fdf8ec] px-3 py-1.5"
        >
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
      ) : null}

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
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 max-w-[min(520px,86vw)] -translate-x-1/2 rounded-lg border border-line bg-surface px-3 py-2 text-[11px] text-ink-2 shadow-[0_10px_28px_rgba(16,35,28,0.16)]">
          {notice}
        </div>
      ) : null}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={blockMenu(menu.id)} onClose={() => setMenu(null)} />
      ) : null}

      {addMenu ? (
        <ContextMenu x={addMenu.x} y={addMenu.y} items={addMenuItems()} onClose={() => setAddMenu(null)} />
      ) : null}

      {linkFrom ? (
        <RelationDialog
          fromId={linkFrom}
          blocks={dialogBlocks}
          onSave={saveLink}
          onClose={() => setLinkFrom(null)}
        />
      ) : null}

      {editingLink ? (
        <RelationDialog
          fromId={editingLink.from}
          blocks={dialogBlocks}
          initial={{ to: editingLink.to, type: editingLink.type, label: editingLink.label }}
          title="编辑这条连接"
          ariaLabel="编辑块间连接"
          submitLabel="保存"
          hint="改类型或写一句说明；换目标块会重新选一条入线边。"
          onSave={editLink}
          onClose={() => setLinkEdit(null)}
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
