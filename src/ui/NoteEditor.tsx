/*
 * `.note` 块编辑器 —— 用 ProseMirror（TipTap）当引擎。
 *
 * 为什么换引擎：自己拿 contentEditable 拼块编辑器，输入法、选区、撤销、拖拽这些
 * 坑永远填不完（上一版就是死在输入法上）。ProseMirror 是专业编辑器内核，
 * 这些它都处理好了，我们只管"块长什么样"和"怎么落盘"。
 *
 * 数据流：
 *   打开  : `.note/` 目录文件 → NoteDoc → PM 文档
 *   编辑  : PM 管文档，我们一个字都不碰 DOM
 *   保存  : PM 文档 → NoteDoc → diffDoc → 只写变动的块文件
 */
import { Link } from '@tiptap/extension-link'
import type { EditorView } from '@tiptap/pm/view'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef, useState } from 'react'
import { attachName, attachPath } from '../core/model/attach'
import { decodeBytes, encodeText } from '../core/model/text'
import {
  type NoteDoc,
  diffDoc,
  parseNoteDoc,
  removedBlockFiles,
} from '../core/note/format'
import { type PmDoc, blocksToPm, pmToSnapshot } from '../core/note/pm'
import type { Host } from '../core/ports/host'
import { putImage, resolveImage } from './markdown/imageStore'
import { nextBlockId } from './note/BlockViews'
import {
  BlockColumn,
  BlockColumns,
  BlockHeading,
  BlockIds,
  BlockImage,
  BlockParagraph,
} from './note/extensions'

export type NoteInfo = {
  /** 块大纲：标题块用 level，其它块按正文条目 */
  outline: { level: number; text: string }[]
  /** 所有块文字拼起来（右栏的关系/反链要用） */
  text: string
}

type Props = {
  host: Host
  dir: string
  /** 把大纲和正文报给 App —— 右栏需要它（.note 不该是"没有右栏"的次等公民） */
  onInfo?: (dir: string, info: NoteInfo) => void
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
export function NoteEditor({ host, dir, onInfo }: Props) {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [title, setTitle] = useState('')

  const savedRef = useRef<NoteDoc | null>(null)
  const metaRef = useRef<NoteDoc['meta']>({ title: '', createdAt: '' })
  const saveTimer = useRef(0)
  const titleTimer = useRef(0)
  const storeImageRef = useRef<(file: File) => Promise<string | null>>(async () => null)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // 换成我们自己的"块"版本
        paragraph: false,
        heading: false,
        // 第一批块只有三种，别的先关掉
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
    content: { type: 'doc', content: [] },
    editable: false,
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

  /** 保存（防抖 500ms，只写变动的文件） */
  const scheduleSave = useRef<() => void>(() => {})
  scheduleSave.current = () => {
    if (!editor) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void (async () => {
        const snapshot = pmToSnapshot(editor.getJSON() as unknown as PmDoc)
        const doc: NoteDoc = {
          meta: metaRef.current,
          order: snapshot.order,
          blocks: snapshot.blocks,
        }
        const changed = diffDoc(dir, savedRef.current, doc)
        const removed = removedBlockFiles(dir, savedRef.current, doc)
        if (Object.keys(changed).length === 0 && removed.length === 0) return

        setSaving(true)
        try {
          await host.mkdir(dir)
          await host.mkdir(`${dir}/blocks`)
          for (const [path, text] of Object.entries(changed)) {
            await host.write(path, encodeText(text))
          }
          for (const path of removed) await host.remove(path)
          savedRef.current = doc
        } catch (e) {
          setError(`保存失败：${String(e)}`)
        } finally {
          setSaving(false)
        }
      })()
    }, 500)
  }

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

  /* ── 打开 ── */
  useEffect(() => {
    if (!editor) return
    let alive = true
    setReady(false)
    setError(null)

    void (async () => {
      try {
        const entries = await host.list()
        const files: Record<string, string> = {}
        for (const e of entries) {
          if (e.kind !== 'file') continue
          if (!e.path.startsWith(`${dir}/`)) continue
          files[e.path] = decodeBytes(await host.read(e.path))
        }
        const parsed = parseNoteDoc(dir, files)
        if (!alive) return
        if (!parsed) {
          setError('这个目录不是 .note 文档（缺标记文件）')
          return
        }

        // 图片先读成 Blob URL
        for (const b of Object.values(parsed.blocks)) {
          if (b.type !== 'image' || !b.src || resolveImage(b.src)) continue
          try {
            const bytes = await host.read(b.src)
            putImage(b.src, URL.createObjectURL(new Blob([bytes as unknown as BlobPart])))
          } catch {
            /* 图没了就显示占位 */
          }
        }

        savedRef.current = parsed
        metaRef.current = parsed.meta
        setTitle(parsed.meta.title)

        editor.commands.setContent(blocksToPm(parsed) as never, { emitUpdate: false })
        editor.setEditable(true)
        if (alive) setReady(true)
      } catch (e) {
        if (alive) setError(String(e))
      }
    })()

    return () => {
      alive = false
    }
  }, [editor, host, dir])

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
    const onUpdate = () => scheduleSave.current()
    editor.on('update', onUpdate)
    return () => {
      editor.off('update', onUpdate)
    }
  }, [editor])

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

  if (error) {
    return (
      <div className="grid h-full place-items-center px-8">
        <p className="text-[13px] text-ink-3">{error}</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="mx-auto w-full px-8 pt-10 pb-32" style={{ maxWidth: 'var(--dd-cw)' }}>
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-full bg-green-soft px-2 py-0.5 text-[10.5px] tracking-wide text-green">
            .note · 块文档
          </span>
          <span className="text-[10.5px] text-ink-3">
            {!ready ? '正在打开…' : saving ? '保存中…' : '已保存'}
          </span>
          <span className="ml-auto text-[10.5px] text-ink-3">
            {editor?.state.doc.childCount ?? 0} 块
          </span>
        </div>

        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          aria-label="文档标题"
          placeholder="无标题"
          className="mb-5 w-full border-0 bg-transparent text-[2em] leading-[1.2] font-semibold tracking-[-0.025em] text-ink outline-none placeholder:text-ink-3/40"
        />

        <EditorContent editor={editor} />

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
      </div>
    </div>
  )
}
