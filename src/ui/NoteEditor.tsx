/*
 * `.note` 的门房：把目录读成文件表，看清版本，再交给对应的编辑器。
 *
 *   v1（`canvas`）→ CanvasNote：自由画布，块带 layout，行为跟以前一模一样
 *   v2（`flow`）  → FlowNote：文档流，块按 order.json 竖排，Notion 式块操作
 *
 * 为什么要在这一层分：两种布局语义不能混在一个编辑器里（混了就会出现
 * "新文档的块被自动摆到坐标上"这种谁都不想看到的事）。分开之后，
 * v1 的代码路径一个字节都没动，老笔记不可能因为这次改动而变样。
 *
 * 这一层还负责两件两种格式都要做的事：读文件、把图片读成 Blob URL。
 */
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { decodeBytes } from '../core/model/text'
import { type NoteDoc, inferNoteMarker, parseNoteDoc, readNoteMarker } from '../core/note/format'
import { type FlowDoc, parseFlowDoc } from '../core/note/flowDoc'
import type { FlowBlock } from '../core/note/flow'
import type { Host } from '../core/ports/host'
import { putImage, resolveImage } from './markdown/imageStore'
import type { JumpKind } from './markdown/render'

const CanvasNote = lazy(() => import('./note/CanvasNote').then((m) => ({ default: m.CanvasNote })))
const FlowNote = lazy(() => import('./note/FlowNote').then((m) => ({ default: m.FlowNote })))

export type NoteInfo = {
  /** 块大纲：标题块用 level，其它块按正文条目 */
  outline: { level: number; text: string }[]
  /** 所有块文字拼起来（右栏的关系/反链要用） */
  text: string
}

type Props = {
  host: Host
  dir: string
  onInfo?: (dir: string, info: NoteInfo) => void
  onJump?: (target: string, kind: JumpKind) => void
  /** 链接编辑里可以选的笔记清单 */
  notes?: { path: string; title: string }[]
}

type Loaded =
  | { kind: 'canvas'; doc: NoteDoc }
  | { kind: 'flow'; doc: FlowDoc }

/** 文档流里图片可能藏在分栏里，挨个找出来 */
function flowImages(blocks: Record<string, FlowBlock>): string[] {
  const out: string[] = []
  const walk = (b: FlowBlock) => {
    if (b.type === 'image' && b.src) out.push(b.src)
    if (b.type === 'columns') for (const c of b.columns ?? []) for (const child of c.blocks) walk(child)
  }
  for (const b of Object.values(blocks)) walk(b)
  return out
}

export function NoteEditor({ host, dir, onInfo, onJump, notes }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoaded(null)
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
        if (!alive) return

        const marker = readNoteMarker(dir, files) ?? inferNoteMarker(dir, files)

        if (marker.layoutMode === 'flow') {
          const doc = parseFlowDoc(dir, files)
          if (!doc) {
            setError('这个目录不是 .note 文档（缺标记文件）')
            return
          }
          // 图片先读成 Blob URL，块里只存路径
          for (const src of flowImages(doc.blocks)) {
            if (resolveImage(src)) continue
            try {
              const bytes = await host.read(src)
              putImage(src, URL.createObjectURL(new Blob([bytes as unknown as BlobPart])))
            } catch {
              /* 图没了就显示占位 */
            }
          }
          if (!alive) return
          setLoaded({ kind: 'flow', doc })
          return
        }

        const doc = parseNoteDoc(dir, files)
        if (!doc) {
          setError('这个目录不是 .note 文档（缺标记文件）')
          return
        }
        for (const b of Object.values(doc.blocks)) {
          if (b.type !== 'image' || !b.src || resolveImage(b.src)) continue
          try {
            const bytes = await host.read(b.src)
            putImage(b.src, URL.createObjectURL(new Blob([bytes as unknown as BlobPart])))
          } catch {
            /* 图没了就显示占位 */
          }
        }
        if (!alive) return
        setLoaded({ kind: 'canvas', doc })
      } catch (e) {
        if (alive) setError(String(e))
      }
    })()

    return () => {
      alive = false
    }
  }, [host, dir])

  const body = useMemo(() => {
    if (!loaded) return null
    if (loaded.kind === 'flow') {
      return <FlowNote key={dir} host={host} dir={dir} doc={loaded.doc} onInfo={onInfo} onJump={onJump} notes={notes} />
    }
    return <CanvasNote key={dir} host={host} dir={dir} doc={loaded.doc} onInfo={onInfo} />
  }, [loaded, host, dir, onInfo, onJump, notes])

  if (error) {
    return (
      <div className="grid h-full place-items-center px-8">
        <p className="text-[13px] text-ink-3">{error}</p>
      </div>
    )
  }

  if (!loaded) {
    return (
      <div className="grid h-full place-items-center text-[12.5px] text-ink-3">正在打开…</div>
    )
  }

  return <Suspense fallback={null}>{body}</Suspense>
}
