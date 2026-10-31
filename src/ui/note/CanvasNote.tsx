/*
 * 画布版 `.note` 编辑器（v1）。
 *
 * 这是原来 `NoteEditor` 的正文，一行逻辑没动，只是把"读文件"那一步提到了外面
 * （见 `NoteEditor.tsx`）：v1 / v2 两种格式要先看标记才知道该用哪个编辑器。
 *
 * 自由排版：块带 `layout {x,y,w}`，位置是用户的决定，程序只在块高度变化时把画布撑高。
 */
import { Link } from '@tiptap/extension-link'
import type { EditorView } from '@tiptap/pm/view'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useCallback, useEffect, useRef, useState } from 'react'
import { attachName, attachPath } from '../../core/model/attach'
import { encodeText } from '../../core/model/text'
import { type NoteDoc, diffDoc, removedBlockFiles } from '../../core/note/format'
import { type PmDoc, blocksToPm, pmToSnapshot } from '../../core/note/pm'
import type { Host } from '../../core/ports/host'
import { putImage } from '../markdown/imageStore'
import { nextBlockId } from './BlockViews'
import {
  BlockColumn,
  BlockColumns,
  BlockHeading,
  BlockIds,
  BlockImage,
  BlockParagraph,
} from './extensions'

type Props = {
  host: Host
  dir: string
  doc: NoteDoc
  onInfo?: (dir: string, info: { outline: { level: number; text: string }[]; text: string }) => void
  /** v1 旧画布：只读打开，不写盘、不改格式 */
  readOnly?: boolean
}

const ATTACH_DIR = '附件'
const BLOCK_TYPES = [
  { id: 'heading', label: '标题', glyph: 'H' },
  { id: 'paragraph', label: '正文', glyph: 'T' },
  { id: 'image', label: '图片', glyph: '▧' },
  { id: 'columns', label: '分栏', glyph: '▥' },
] as const

/** 在指定位置插一个图片块（id 自动取下一个） */
function insertImageAt(view: EditorView, pos: number, src: string, alt: string): void {
  let max = 0
  view.state.doc.forEach((n) => {
    const m = /^b(\d+)$/.exec(String(n.attrs.id ?? ''))
    if (m) max = Math.max(max, Number(m[1]))
  })
  const image = view.state.schema.nodes.image
  if (!image) return
  view.dispatch(view.state.tr.insert(pos, image.create({ id: `b${max + 1}`, src, alt })))
}

export function CanvasNote({ host, dir, doc, onInfo, readOnly = false }: Props) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState(doc.meta.title)

  const savedByDir = useRef(new Map<string, NoteDoc>())
  const pending = useRef<{ dir: string; doc: NoteDoc } | null>(null)
  const saveTimer = useRef(0)
  const titleTimer = useRef(0)
  const metaRef = useRef<NoteDoc['meta']>(doc.meta)
  const storeImageRef = useRef<(file: File) => Promise<string | null>>(async () => null)
  const flushRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    if (!savedByDir.current.has(dir)) savedByDir.current.set(dir, doc)
    metaRef.current = doc.meta
    setTitle(doc.meta.title)
  }, [dir, doc])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // 换成我们自己的"块"版本
        paragraph: false,
        heading: false,
        // 画布版只有三种块，别的先关掉
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      BlockParagraph,
      BlockHeading.configure({ levels: [1, 2] }),
      BlockImage.configure({ inline: false, allowBase64: false }),
      BlockColumns,
      BlockColumn,
      BlockIds,
      Link.configure({ openOnClick: false, autolink: false }),
    ],
    content: blocksToPm(doc) as never,
    editable: !readOnly,
    editorProps: {
      attributes: { class: 'dd-note-canvas' },

      /*
       * 图片粘贴 / 拖入**必须走编辑器的 handlePaste/handleDrop**。
       * 之前是在 DOM 上挂原生监听，依赖 `editor.view.dom` —— 懒加载之后
       * 挂载顺序变了，直接抛 "The editor view is not available"。
       */
      handlePaste: (view, event) => {
        const file = [...(event.clipboardData?.files ?? [])].find((f) =>
          f.type.startsWith('image/'),
        )
        if (!file) return false
        event.preventDefault()
        void (async () => {
          const path = await storeImageRef.current(file)
          if (!path) return
          insertImageAt(view, view.state.selection.to, path, file.name)
        })()
        return true
      },
      handleDrop: (view, event) => {
        const file = event.dataTransfer?.files?.[0]
        if (!file || !file.type.startsWith('image/')) return false
        event.preventDefault()
        const at =
          view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
          view.state.doc.content.size
        void (async () => {
          const path = await storeImageRef.current(file)
          if (!path) return
          insertImageAt(view, at, path, file.name)
        })()
        return true
      },
    },
  })

  /* ── 保存（防抖 500ms，只写变动的文件） ── */
  const flush = useCallback(async () => {
    const job = pending.current
    if (!job) return
    pending.current = null

    const before = savedByDir.current.get(job.dir) ?? null
    const changed = diffDoc(job.dir, before, job.doc)
    const removed = removedBlockFiles(job.dir, before, job.doc)
    if (Object.keys(changed).length === 0 && removed.length === 0) {
      savedByDir.current.set(job.dir, job.doc)
      return
    }

    setSaving(true)
    try {
      await host.mkdir(job.dir)
      await host.mkdir(`${job.dir}/blocks`)
      for (const [path, text] of Object.entries(changed)) {
        await host.write(path, encodeText(text))
      }
      for (const path of removed) await host.remove(path)
      savedByDir.current.set(job.dir, job.doc)
      if (job.dir === dir) setError(null)
    } catch (e) {
      // 写失败要留在 dirty，能重试 —— 不能假装存好了
      pending.current = job
      if (job.dir === dir) setError(`保存失败：${String(e)}`)
    } finally {
      setSaving(false)
    }
  }, [host, dir])

  flushRef.current = flush

  const scheduleSave = useRef<() => void>(() => {})
  scheduleSave.current = () => {
    if (!editor) return
    // 快照**当场**取：定时器里再取就成了"新文档的内容写到旧路径"
    const snapshot = pmToSnapshot(editor.getJSON() as unknown as PmDoc)
    pending.current = {
      dir,
      doc: { meta: metaRef.current, order: snapshot.order, blocks: snapshot.blocks },
    }
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void flushRef.current()
    }, 500)
  }

  /* 卸载 / 换文档：把没写完的那份立刻落盘（写它自己的 dir） */
  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimer.current)
      window.clearTimeout(titleTimer.current)
      void flushRef.current()
    }
  }, [])

  /** 把一张图存进图库，返回仓库相对路径 */
  storeImageRef.current = async (file: File) => {
    try {
      await host.mkdir(ATTACH_DIR)
      const name = attachName(file.name || 'image', file.type)
      const path = attachPath(name)
      await host.write(path, new Uint8Array(await file.arrayBuffer()))
      putImage(path, URL.createObjectURL(file))
      return path
    } catch (e) {
      setError(`图片存不进图库：${String(e)}`)
      return null
    }
  }

  /* ── 把大纲/正文交给 App（右栏用） ── */
  useEffect(() => {
    if (!editor || !onInfo) return
    const report = () => {
      const snap = pmToSnapshot(editor.getJSON() as unknown as PmDoc)
      const blocks = snap.order
        .map((id) => snap.blocks[id])
        .filter((b): b is NonNullable<typeof b> => Boolean(b))
      const outline = blocks
        .filter((b) => b.type === 'heading')
        .map((b) => ({ level: b.level ?? 1, text: (b.text ?? '').trim() }))
        .filter((x) => x.text.length > 0)
      const text = blocks
        .map((b) => (b.type === 'image' ? `![](${b.src ?? ''})` : (b.text ?? '')))
        .join('\n\n')
      onInfo(dir, { outline, text })
    }
    report()
    editor.on('update', report)
    return () => {
      editor.off('update', report)
    }
  }, [editor, dir, onInfo])

  /* ── 编辑 → 防抖保存 ── */
  useEffect(() => {
    if (!editor) return
    const onUpdate = () => {
      if (!readOnly) scheduleSave.current()
    }
    editor.on('update', onUpdate)
    return () => {
      editor.off('update', onUpdate)
    }
  }, [editor, readOnly])

  /* ── 图片块换图：node view 抛上来的事件 ── */
  useEffect(() => {
    if (!editor) return
    const handler = (payload: unknown) => {
      const { pos, file } = payload as { pos: number; file: File }
      void (async () => {
        const path = await storeImageRef.current(file)
        if (!path) return
        editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeAttribute(pos, 'src', path)
            tr.setNodeAttribute(pos, 'alt', file.name)
            return true
          })
          .run()
      })()
    }
    editor.on('dd:image-drop' as never, handler as never)
    return () => {
      editor.off('dd:image-drop' as never, handler as never)
    }
  }, [editor])

  /*
   * 只给"还没摆过位置"的块补位置，**绝不改动已有位置**。
   *
   * 这是自由排版和流式排版的分界线：位置一旦存下来就是用户的决定，
   * 程序只在块高度变化时把画布撑高，不会去挪块 —— 否则"我摆好的版面自己跑掉了"。
   */
  useEffect(() => {
    if (!editor || editor.isDestroyed) return

    const init = () => {
      if (editor.isDestroyed) return
      const canvas = editor.view.dom
      const nodes: { pos: number; id: string; layout: { x: number; y: number; w: number } | null }[] = []
      editor.state.doc.descendants((n, pos) => {
        if (n.isTextblock || n.type.name === 'image') {
          nodes.push({
            pos,
            id: String(n.attrs.id ?? ''),
            layout: (n.attrs.layout as { x: number; y: number; w: number } | null) ?? null,
          })
        }
        return true
      })
      if (nodes.length === 0) return

      const el = (id: string) => canvas.querySelector<HTMLElement>('[data-block-id="' + id + '"]')
      const h = (id: string) => el(id)?.getBoundingClientRect().height ?? 40

      // 已有位置里的最低点
      let bottom = 0
      for (const n of nodes) {
        if (n.layout) bottom = Math.max(bottom, n.layout.y + h(n.id) + 14)
      }

      const tr = editor.state.tr
      let changed = false
      for (const n of nodes) {
        if (n.layout) continue
        tr.setNodeAttribute(n.pos, 'layout', { x: 0, y: Math.round(bottom), w: 100 })
        bottom += h(n.id) + 14
        changed = true
      }
      if (changed) editor.view.dispatch(tr)

      // 画布撑到"最低那块 + 余量"：上下无界
      let maxBottom = 0
      for (const n of nodes) {
        const l = (editor.state.doc.nodeAt(n.pos)?.attrs.layout ?? n.layout) as { y: number } | null
        if (l) maxBottom = Math.max(maxBottom, l.y + h(n.id))
      }
      canvas.style.minHeight = Math.max(420, Math.ceil(maxBottom + 160)) + 'px'
    }

    const timer = window.setTimeout(init, 420)
    editor.on('update', init)
    window.addEventListener('resize', init)
    return () => {
      window.clearTimeout(timer)
      editor.off('update', init)
      window.removeEventListener('resize', init)
    }
  }, [editor])

  /* ── 标题 ── */
  const onTitleChange = (value: string) => {
    setTitle(value)
    window.clearTimeout(titleTimer.current)
    titleTimer.current = window.setTimeout(() => {
      metaRef.current = { ...metaRef.current, title: value }
      scheduleSave.current()
    }, 400)
  }

  /* ── 加块 ── */
  const addBlock = (type: 'heading' | 'paragraph' | 'image' | 'columns') => {
    if (!editor) return
    const end = editor.state.doc.content.size
    const id = nextBlockId(editor)
    if (type === 'columns') {
      // 两列起步：每列一个空正文块（列里必须有块，否则光标进不去）
      const para = editor.state.schema.nodes.paragraph
      const colNode = editor.state.schema.nodes.column
      if (!para || !colNode) return
      editor
        .chain()
        .insertContentAt(end, {
          type: 'columns',
          attrs: { id, width: null },
          content: [
            { type: 'column', attrs: { width: 50 }, content: [{ type: 'paragraph', attrs: { id: nextBlockId(editor) } }] },
            { type: 'column', attrs: { width: 50 }, content: [{ type: 'paragraph', attrs: { id: `${id}c2` } }] },
          ],
        })
        .run()
      return
    }
    if (type === 'image') {
      editor
        .chain()
        .insertContentAt(end, { type: 'image', attrs: { id, src: '' } })
        .run()
      return
    }
    editor
      .chain()
      .insertContentAt(end, {
        type: type === 'heading' ? 'heading' : 'paragraph',
        attrs: { id, level: 1 },
      })
      .focus(end + 1)
      .run()
  }

  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="mx-auto w-full px-8 pt-10 pb-32" style={{ maxWidth: 'var(--dd-cw)' }}>
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-full bg-green-soft px-2 py-0.5 text-[10.5px] tracking-wide text-green">
            .note · 画布
          </span>
          <span className="text-[10.5px] text-ink-3">
            {saving ? '保存中…' : '已保存'}
          </span>
          <span className="ml-auto text-[10.5px] text-ink-3">
            {editor?.state.doc.childCount ?? 0} 块
          </span>
        </div>

        <input
          value={title}
          readOnly={readOnly}
          onChange={(e) => onTitleChange(e.target.value)}
          aria-label="文档标题"
          placeholder="无标题"
          className="mb-5 w-full border-0 bg-transparent text-[2em] leading-[1.2] font-semibold tracking-[-0.025em] text-ink outline-none placeholder:text-ink-3/40"
        />

        <EditorContent editor={editor} />

        {readOnly ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-ink-3">添加块</span>
          {BLOCK_TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => addBlock(t.id)}
              title={
                t.id === 'columns'
                  ? '插入多列布局：每一列里可以堆多块（标题 / 正文 / 图片）'
                  : `插入${t.label}块`
              }
              className="flex items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-1.5 text-[11.5px] text-ink-3 transition-colors hover:border-green/40 hover:text-green"
            >
              <span className="font-mono text-[10px] opacity-70">{t.glyph}</span>
              {t.label}
            </button>
          ))}
        </div>
        )}

        {error ? (
          <p className="mt-4 text-[11.5px] text-red-600" role="alert">
            {error}
            <button type="button" className="ml-2 underline" onClick={() => void flushRef.current()}>
              重试
            </button>
          </p>
        ) : null}
      </div>
    </div>
  )
}
