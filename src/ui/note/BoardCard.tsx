/*
 * v3 的一张块卡片。
 *
 * 卡片本身只负责"长什么样、点了算谁的"，所有改数据的事都回调给 BoardNote。
 * 左侧留白里放拖动手柄和菜单 —— 不压正文、不推对齐线。
 */
import type { Editor } from '@tiptap/core'
import { FileText, GripVertical, Image as ImageIcon, Link2, MoreHorizontal, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BoardBlock } from '../../core/note/board'
import type { Inline } from '../../core/note/flow'
import type { Host } from '../../core/ports/host'
import { putImage, resolveImage } from '../markdown/imageStore'
import { BoardTextEditor } from './BoardTextEditor'

type Props = {
  host: Host
  block: BoardBlock
  index: number
  autoFocus: boolean
  flash: boolean
  relationCount: number
  onChange: (id: string, patch: Partial<BoardBlock>) => void
  onMenu: (id: string, x: number, y: number) => void
  onEnterEnd: (id: string) => void
  onBackspaceEmpty: (id: string) => void
  onEditor: (id: string, editor: Editor | null) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent, index: number) => void
  onDrop: () => void
  onPickAsset: (id: string, kind: 'image' | 'file') => void
  onShowRelations: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
  onNotice: (text: string) => void
}

export function BoardCard({
  host,
  block,
  index,
  autoFocus,
  flash,
  relationCount,
  onChange,
  onMenu,
  onEnterEnd,
  onBackspaceEmpty,
  onEditor,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onPickAsset,
  onShowRelations,
  onMove,
  onNotice,
}: Props) {
  const isText =
    block.type === 'paragraph' ||
    block.type === 'heading1' ||
    block.type === 'heading2' ||
    block.type === 'quote' ||
    block.type === 'todo'

  const cardTone = [
    'relative rounded-lg px-3 py-1.5 transition-colors',
    flash ? 'bg-green-soft ring-1 ring-green/30' : 'hover:bg-surface-2/60',
  ].join(' ')

  return (
    <div
      data-block-id={block.id}
      data-block-type={block.type}
      className="group relative"
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
    >
      <div className="absolute top-1 -left-9 flex flex-col items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          draggable
          aria-label={`拖动块：${block.id}`}
          title="拖动排序（Alt+↑/↓ 也可以）"
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('application/x-dusk-note-block', block.id)
            onDragStart(block.id)
          }}
          onDragEnd={onDragEnd}
          onKeyDown={(e) => {
            if (!e.altKey) return
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              onMove(block.id, -1)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              onMove(block.id, 1)
            }
          }}
          className="grid size-6 cursor-grab place-items-center rounded text-ink-3/70 hover:bg-surface-2 hover:text-ink-2 active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={`块 ${block.id} 的菜单`}
          title="块菜单"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            onMenu(block.id, r.left - 150, r.bottom + 4)
          }}
          className="grid size-6 place-items-center rounded text-ink-3/70 hover:bg-surface-2 hover:text-ink-2"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </div>

      {relationCount > 0 ? (
        <button
          type="button"
          onClick={() => onShowRelations(block.id)}
          className="absolute -top-2 right-1 z-10 inline-flex items-center gap-0.5 rounded-full border border-line bg-surface px-1.5 py-[1px] text-[9.5px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:text-green"
          title="查看这个块的连接"
        >
          <Link2 className="size-2.5" />
          {relationCount}
        </button>
      ) : null}

      <div className={cardTone}>
        {isText ? (
          block.type === 'todo' ? (
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={Boolean(block.checked)}
                onChange={(e) => onChange(block.id, { checked: e.target.checked })}
                aria-label="勾选待办"
                className="mt-[7px] size-[14px] shrink-0 cursor-pointer accent-[var(--color-green)]"
              />
              <div className={['min-w-0 flex-1', block.checked ? 'dd-board-todo-done' : ''].join(' ')}>
                <BoardTextEditor
                  block={block}
                  autoFocus={autoFocus}
                  onChange={(content: Inline[]) => onChange(block.id, { content })}
                  onEnterEnd={() => onEnterEnd(block.id)}
                  onBackspaceEmpty={() => onBackspaceEmpty(block.id)}
                  onEditor={onEditor}
                />
              </div>
            </div>
          ) : block.type === 'quote' ? (
            <div className="border-l-[3px] border-[#d5e6dd] pl-3 text-ink-2">
              <BoardTextEditor
                block={block}
                autoFocus={autoFocus}
                onChange={(content) => onChange(block.id, { content })}
                onEnterEnd={() => onEnterEnd(block.id)}
                onBackspaceEmpty={() => onBackspaceEmpty(block.id)}
                onEditor={onEditor}
              />
            </div>
          ) : (
            <BoardTextEditor
              block={block}
              autoFocus={autoFocus}
              onChange={(content) => onChange(block.id, { content })}
              onEnterEnd={() => onEnterEnd(block.id)}
              onBackspaceEmpty={() => onBackspaceEmpty(block.id)}
              onEditor={onEditor}
            />
          )
        ) : block.type === 'divider' ? (
          <div className="py-2">
            <hr className="border-0 border-t border-line" />
          </div>
        ) : block.type === 'image' ? (
          <ImageBlock host={host} block={block} onPick={() => onPickAsset(block.id, 'image')} />
        ) : block.type === 'file' ? (
          <FileBlock host={host} block={block} onPick={() => onPickAsset(block.id, 'file')} onNotice={onNotice} />
        ) : (
          <UnknownBlock block={block} />
        )}
      </div>
    </div>
  )
}

function UnknownBlock({ block }: { block: BoardBlock }) {
  const type = typeof block.raw?.type === 'string' ? block.raw.type : 'unknown'
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-line px-2.5 py-2 text-[11.5px] text-ink-3">
      <RotateCw className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        这个块由更新版本创建（<span className="font-mono text-[10.5px]">{type}</span>），原样保留，不会丢
      </span>
    </div>
  )
}

function ImageBlock({ host, block, onPick }: { host: Host; block: BoardBlock; onPick: () => void }) {
  const { url, state } = useAssetUrl(host, block.src)
  if (!block.src || state === 'missing') {
    return (
      <button
        type="button"
        onClick={onPick}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line px-3 py-6 text-[12px] text-ink-3 hover:border-green/40 hover:text-green"
      >
        <ImageIcon className="size-4" />
        {block.src ? '图片加载失败，点这里重新选择' : '选择一张图片（会复制进本笔记的 assets/）'}
      </button>
    )
  }
  return (
    <figure className="py-1">
      {state === 'loading' ? (
        <div className="grid h-[140px] place-items-center rounded-lg bg-surface-2 text-[11.5px] text-ink-3">正在读取图片…</div>
      ) : (
        <img src={url ?? ''} alt={block.alt ?? ''} className="max-h-[460px] max-w-full rounded-lg" />
      )}
      {block.alt ? <figcaption className="mt-1 text-[11px] text-ink-3">{block.alt}</figcaption> : null}
    </figure>
  )
}

function FileBlock({
  host,
  block,
  onPick,
  onNotice,
}: {
  host: Host
  block: BoardBlock
  onPick: () => void
  onNotice: (text: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const name = block.name || block.src?.split('/').pop() || '文件'
  const open = async () => {
    if (!block.src) return onPick()
    setBusy(true)
    try {
      const bytes = await host.read(block.src)
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]))
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.rel = 'noopener'
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch (e) {
      onNotice(`这个文件读不出来：${String(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2 text-ink-3">
        <FileText className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-ink">{name}</span>
        <span className="block text-[10.5px] text-ink-3">
          {typeof block.size === 'number' && block.size > 0 ? formatSize(block.size) : '已复制进本笔记'}
        </span>
      </span>
      <button
        type="button"
        onClick={() => void open()}
        disabled={busy}
        className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 hover:bg-surface-2 disabled:opacity-50"
      >
        {block.src ? (busy ? '读取中…' : '打开') : '选择文件'}
      </button>
      {block.src ? (
        <button
          type="button"
          onClick={onPick}
          className="shrink-0 rounded-md px-1.5 py-1 text-[10.5px] text-ink-3 hover:bg-surface-2 hover:text-ink-2"
        >
          更换
        </button>
      ) : null}
    </div>
  )
}

function useAssetUrl(host: Host, src: string | undefined): { url: string | null; state: 'loading' | 'ok' | 'missing' } {
  const [url, setUrl] = useState<string | null>(() => (src ? resolveImage(src) : null))
  const [state, setState] = useState<'loading' | 'ok' | 'missing'>(() => {
    if (!src) return 'missing'
    return resolveImage(src) ? 'ok' : 'loading'
  })

  useEffect(() => {
    let alive = true
    if (!src) {
      setUrl(null)
      setState('missing')
      return
    }
    const cached = resolveImage(src)
    if (cached) {
      setUrl(cached)
      setState('ok')
      return
    }
    setState('loading')
    void (async () => {
      try {
        const bytes = await host.read(src)
        const next = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]))
        putImage(src, next)
        if (alive) {
          setUrl(next)
          setState('ok')
        }
      } catch {
        if (alive) setState('missing')
      }
    })()
    return () => {
      alive = false
    }
  }, [host, src])

  return { url, state }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
