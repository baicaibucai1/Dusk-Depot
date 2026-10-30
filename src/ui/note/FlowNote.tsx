/*
 * 文档流编辑器（`.note` v2）。
 *
 * 数据流跟画布版完全一样，只是"排版"这一层换成了顺序：
 *   打开 : `.note/` 文件 → FlowDoc → PM 文档（块按 order.json 竖排）
 *   编辑 : ProseMirror 独占文档，我们一行 DOM 都不碰
 *   保存 : PM 文档 → FlowDoc → diff → 只写变动的块文件（顺序变了才写 order.json）
 *
 * 保存的两条纪律，都是踩过坑的：
 *   ① **改到哪一份、写到哪一份**：每次改动就把快照和 dir 一起记下来，
 *      定时器只写那份快照 —— 切标签时旧编辑器的延迟保存不会写到新文档里。
 *   ② 写失败 **不清 dirty**：错误显示出来、可以重试，绝不假装存好了。
 */
import { Link } from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { TextSelection } from '@tiptap/pm/state'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useCallback, useEffect, useRef, useState } from 'react'
import { attachName, attachPath } from '../../core/model/attach'
import { encodeText } from '../../core/model/text'
import { type FlowBlock, blockText, flowOutline, flowSnapshot, pmFromFlow } from '../../core/note/flow'
import {
  type FlowDoc,
  diffFlowDoc,
  removedFlowBlockFiles,
} from '../../core/note/flowDoc'
import type { PmDoc } from '../../core/note/pm'
import type { Host } from '../../core/ports/host'
import { putImage } from '../markdown/imageStore'
import { BlockChrome } from './BlockChrome'
import { BubbleBar } from './BubbleBar'
import { SlashMenu } from './SlashMenu'
import { insertImageBlock } from './flowCommands'
import {
  FlowBlockIds,
  FlowBulletList,
  FlowCode,
  FlowColumn,
  FlowColumns,
  FlowHeading,
  FlowImage,
  FlowKeys,
  FlowOrderedList,
  FlowParagraph,
  FlowQuote,
  FlowRule,
  FlowTaskItem,
  FlowTaskList,
  FlowUnknown,
} from './flowExtensions'
import { SlashTrigger, composing } from './slash'
import type { NoteInfo } from '../NoteEditor'
import type { JumpKind } from '../markdown/render'

const ATTACH_DIR = '附件'

type Props = {
  host: Host
  dir: string
  doc: FlowDoc
  onInfo?: (dir: string, info: NoteInfo) => void
  onJump?: (target: string, kind: JumpKind) => void
  notes?: { path: string; title: string }[]
}

type Status = 'saved' | 'dirty' | 'saving' | 'error'

export function FlowNote({ host, dir, doc, onInfo, onJump, notes }: Props) {
  const [title, setTitle] = useState(doc.meta.title)
  const [status, setStatus] = useState<Status>('saved')
  const [error, setError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const savedByDir = useRef(new Map<string, FlowDoc>())
  const pending = useRef<{ dir: string; doc: FlowDoc } | null>(null)
  const timer = useRef(0)
  const titleTimer = useRef(0)
  const metaRef = useRef(doc.meta)
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
        // 这些换成带块 id / 带回车语义的版本
        paragraph: false,
        heading: false,
        blockquote: false,
        codeBlock: false,
        bulletList: false,
        orderedList: false,
        horizontalRule: false,
        // 链接单独配（要关掉 openOnClick），下划线不在这一期范围
        link: false,
        underline: false,
      }),
      FlowParagraph,
      FlowHeading.configure({ levels: [1, 2] }),
      FlowQuote,
      FlowCode,
      FlowBulletList,
      FlowOrderedList,
      FlowTaskList,
      FlowTaskItem,
      FlowRule,
      FlowImage.configure({ inline: false, allowBase64: false }),
      FlowUnknown,
      FlowColumns,
      FlowColumn,
      FlowBlockIds,
      FlowKeys,
      SlashTrigger,
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      Placeholder.configure({ placeholder: '输入 “/” 选择块，或直接开始写…', showOnlyCurrent: true }),
    ],
    content: contentOf(doc) as never,
    editable: true,
    editorProps: {
      attributes: { class: 'dd-flow', 'data-dd-flow': '' },

      handlePaste: (_view, event) => {
        const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
        if (!file) return false
        event.preventDefault()
        void (async () => {
          const path = await storeImageRef.current(file)
          if (path) insertImageBlock(editor, path, file.name)
        })()
        return true
      },

      handleDrop: (view, event) => {
        const file = event.dataTransfer?.files?.[0]
        if (!file || !file.type.startsWith('image/')) return false
        event.preventDefault()
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        if (typeof at === 'number') {
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))))
        }
        void (async () => {
          const path = await storeImageRef.current(file)
          if (path) insertImageBlock(editor, path, file.name)
        })()
        return true
      },

      handleClick: (_view, _pos, event) => {
        const a = (event.target as HTMLElement | null)?.closest?.('a')
        if (!a) return false
        if (!(event.metaKey || event.ctrlKey)) return false
        event.preventDefault()
        const href = a.getAttribute('href') ?? ''
        if (href) onJump?.(href, 'path')
        return true
      },

      handleDOMEvents: {
        compositionstart: () => {
          composing.current = true
          return false
        },
        compositionend: () => {
          composing.current = false
          return false
        },
      },
    },
  })

  /* ── 保存 ── */

  const saveNow = useCallback(async () => {
    const job = pending.current
    if (!job) return
    pending.current = null

    const before = savedByDir.current.get(job.dir) ?? null
    const changed = diffFlowDoc(job.dir, before, job.doc)
    const removed = removedFlowBlockFiles(job.dir, before, job.doc)
    if (Object.keys(changed).length === 0 && removed.length === 0) {
      savedByDir.current.set(job.dir, job.doc)
      if (job.dir === dir) {
        setStatus('saved')
        setError(null)
      }
      return
    }

    if (job.dir === dir) setStatus('saving')
    try {
      await host.mkdir(job.dir)
      await host.mkdir(`${job.dir}/blocks`)
      for (const [path, text] of Object.entries(changed)) {
        await host.write(path, encodeText(text))
      }
      for (const path of removed) await host.remove(path)
      savedByDir.current.set(job.dir, job.doc)
      if (job.dir === dir) {
        setStatus('saved')
        setError(null)
      }
    } catch (e) {
      // 失败就把这份改动放回去（除非期间又有更新的改动在排队），状态留在 dirty —— 不许假装存好了
      if (!pending.current) pending.current = job
      if (job.dir === dir) {
        setStatus('error')
        setError(`保存失败：${String(e)}`)
      }
    }
  }, [host, dir])

  flushRef.current = saveNow

  const schedule = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void flushRef.current()
    }, 450)
  }, [])

  const snapshot = useCallback((): FlowDoc | null => {
    if (!editor || editor.isDestroyed) return null
    const pm = editor.getJSON() as unknown as PmDoc
    const snap = flowSnapshot(pm)
    return {
      meta: metaRef.current,
      order: snap.order,
      blocks: snap.blocks,
      version: 2,
      layoutMode: 'flow',
    }
  }, [editor])

  const touch = useCallback(() => {
    const next = snapshot()
    if (!next) return
    pending.current = { dir, doc: next }
    setStatus('dirty')
    schedule()
  }, [snapshot, dir, schedule])

  /* 编辑 → 记快照 + 防抖保存 */
  useEffect(() => {
    if (!editor) return
    const onUpdate = () => touch()
    editor.on('update', onUpdate)
    return () => {
      editor.off('update', onUpdate)
    }
  }, [editor, touch])

  /* 卸载 / 换文档：把没写完的那份立刻落盘（写的是它自己的 dir） */
  useEffect(() => {
    return () => {
      window.clearTimeout(timer.current)
      window.clearTimeout(titleTimer.current)
      void flushRef.current()
    }
  }, [])

  /* 重试按钮：以**当前编辑器里的内容**为准重存一次，不依赖上次失败留下的那份快照 */
  const retry = () => {
    const next = snapshot()
    if (!next) return
    pending.current = { dir, doc: next }
    void flushRef.current()
  }

  /* ── 图片进图床 ── */
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

  /* 图片块换图：node view 抛上来的事件 */
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

  /* ── 大纲 / 正文交给右栏 ── */
  useEffect(() => {
    if (!editor || !onInfo) return
    const report = () => {
      const snap = flowSnapshot(editor.getJSON() as unknown as PmDoc)
      const blocks = snap.order
        .map((id) => snap.blocks[id])
        .filter((b): b is FlowBlock => Boolean(b))
      onInfo(dir, {
        outline: flowOutline(blocks),
        text: blocks.map((b) => blockText(b!)).join('\n\n'),
      })
    }
    report()
    editor.on('update', report)
    return () => {
      editor.off('update', report)
    }
  }, [editor, dir, onInfo])

  /* ── 标题 ── */
  const onTitleChange = (value: string) => {
    setTitle(value)
    window.clearTimeout(titleTimer.current)
    titleTimer.current = window.setTimeout(() => {
      metaRef.current = { ...metaRef.current, title: value }
      touch()
    }, 400)
  }

  if (!editor) {
    return <div className="grid h-full place-items-center text-[12.5px] text-ink-3">正在载入编辑器…</div>
  }

  return (
    <div
      ref={scrollRef}
      data-dd-flow-scroll=""
      className="relative h-full overflow-y-auto bg-paper"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) editor.commands.focus('end')
      }}
    >
      <div className="mx-auto w-full pt-9 pb-40" style={{ maxWidth: 'var(--dd-cw)' }}>
        <div className="dd-flow-head">
          <span className="dd-flow-badge">.note · 文档流</span>
          <span className="dd-flow-status" data-status={status}>
            {status === 'saved' ? '已保存' : status === 'saving' ? '保存中…' : status === 'dirty' ? '未保存' : '保存失败'}
          </span>
          {status === 'error' ? (
            <button type="button" className="dd-flow-retry" onClick={retry}>
              重试
            </button>
          ) : null}
          <span className="dd-flow-count">{editor.state.doc.childCount} 块</span>
        </div>

        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          aria-label="文档标题"
          placeholder="无标题"
          className="dd-flow-title"
        />

        <EditorContent editor={editor} />

        {error ? (
          <p className="dd-flow-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <BlockChrome editor={editor} scrollRef={scrollRef} />
      <SlashMenu editor={editor} />
      <BubbleBar editor={editor} notes={notes} />
    </div>
  )
}

/** 空文档 / 只有坏块时也要给一个能落光标的段落 */
function contentOf(doc: FlowDoc) {
  const pm = pmFromFlow(doc.order, doc.blocks)
  if (pm.content.length > 0) return pm
  return { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'b1' } }] }
}
