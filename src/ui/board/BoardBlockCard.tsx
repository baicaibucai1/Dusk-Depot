/*
 * `.board` 的一张块卡片。
 *
 * 和 `.note` 的 BoardCard 是两套东西，别合并：
 *   · `.note` 的块属于"一篇文档"，菜单里是转换/连接；
 *   · `.board` 的块属于"一块白板"，菜单里是复制/复制到白板/引用仓库文件，
 *     而且图片和文件要**说清楚自己是复制的还是引用的**（见卡片右上角的小标记）。
 *
 * 卡片只负责长什么样、点了算谁的；所有改数据的事回调给 BoardEditor。
 */
import type { Editor } from '@tiptap/core'
import { Copy, FileText, GripVertical, Image as ImageIcon, Link2, MoreHorizontal, RotateCw } from 'lucide-react'
import { useState } from 'react'
import type { BoardBlock, BlockSource } from '../../core/board/file'
import type { Inline } from '../../core/note/flow'
import { kindOf } from '../../core/model/fileKind'
import type { Host } from '../../core/ports/host'
import { useAssetExists, useAssetUrl } from '../assetUrl'
import { FileGlyph } from '../fileIcon'
import { BoardTextEditor } from '../note/BoardTextEditor'

type Props = {
  host: Host
  block: BoardBlock
  index: number
  autoFocus: boolean
  selected: boolean
  flash: boolean
  linkCount: number
  onChange: (id: string, patch: Partial<BoardBlock>) => void
  onMenu: (id: string, x: number, y: number) => void
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
  onEnterEnd: (id: string) => void
  onBackspaceEmpty: (id: string) => void
  onEditor: (id: string, editor: Editor | null) => void
  onDragStart: (id: string) => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent, index: number) => void
  onDrop: () => void
  /** 复制进来的图片 / 文件 */
  onPickAsset: (id: string, kind: 'image' | 'file', mode: BlockSource) => void
  /** 打开仓库里的一个文件（md / pdf / 图片 / 白板） */
  onOpenFile: (path: string) => void
  onShowLinks: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
  onNotice: (text: string) => void
}

const TEXT = new Set(['paragraph', 'heading1', 'heading2', 'quote', 'todo'])

export function BoardBlockCard(props: Props) {
  const { block, index, selected, flash, linkCount } = props
  const bare = block.type === 'heading1' || block.type === 'heading2' || block.type === 'divider'

  const shell = [
    'group relative rounded-xl transition-[background-color,box-shadow]',
    bare ? 'px-3 py-1' : 'border border-line bg-surface px-4 py-3',
    flash
      ? 'bg-green-soft ring-1 ring-green/35'
      : selected
        ? 'ring-1 ring-green/45'
        : bare
          ? 'hover:bg-surface-2/60'
          : 'hover:border-line hover:bg-surface-2/20',
  ].join(' ')

  return (
    <div
      data-dd-board-block={block.id}
      data-block-type={block.type}
      data-selected={selected ? 'true' : undefined}
      className="relative"
      onMouseDown={() => props.onSelect(block.id)}
      onMouseEnter={() => props.onHover(block.id)}
      onMouseLeave={() => props.onHover(null)}
      onDragOver={(e) => props.onDragOver(e, index)}
      onDrop={(e) => {
        e.preventDefault()
        props.onDrop()
      }}
    >
      {/* 左侧留白里的操作：不压正文，也不推对齐线 */}
      <div className="absolute top-1.5 -left-8 flex flex-col items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          draggable
          aria-label={`拖动块：${block.id}`}
          title="拖动排序（Alt+↑/↓ 也可以）"
          onDragStart={(e) => {
            e.stopPropagation()
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('application/x-dusk-board-block', block.id)
            props.onDragStart(block.id)
          }}
          onDragEnd={props.onDragEnd}
          onKeyDown={(e) => {
            if (!e.altKey) return
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              props.onMove(block.id, -1)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              props.onMove(block.id, 1)
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
            props.onMenu(block.id, r.left - 150, r.bottom + 4)
          }}
          className="grid size-6 place-items-center rounded text-ink-3/70 hover:bg-surface-2 hover:text-ink-2"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </div>

      {linkCount > 0 ? (
        <button
          type="button"
          onClick={() => props.onShowLinks(block.id)}
          className="absolute -top-2 right-2 z-10 inline-flex items-center gap-0.5 rounded-full border border-line bg-surface px-1.5 py-[1px] text-[9.5px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:text-green"
          title="查看这个块的连接"
        >
          <Link2 className="size-2.5" />
          {linkCount}
        </button>
      ) : null}

      <div className={shell}>
        {TEXT.has(block.type) ? (
          block.type === 'todo' ? (
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={Boolean(block.checked)}
                onChange={(e) => props.onChange(block.id, { checked: e.target.checked })}
                aria-label="勾选待办"
                className="mt-[7px] size-[14px] shrink-0 cursor-pointer accent-[var(--color-green)]"
              />
              <div className={['min-w-0 flex-1', block.checked ? 'dd-board-todo-done' : ''].join(' ')}>
                <BoardTextEditor
                  block={block}
                  autoFocus={props.autoFocus}
                  onChange={(content: Inline[]) => props.onChange(block.id, { content })}
                  onEnterEnd={() => props.onEnterEnd(block.id)}
                  onBackspaceEmpty={() => props.onBackspaceEmpty(block.id)}
                  onEditor={props.onEditor}
                />
              </div>
            </div>
          ) : block.type === 'quote' ? (
            <div className="border-l-[3px] border-[#d5e6dd] pl-3 text-ink-2">
              <BoardTextEditor
                block={block}
                autoFocus={props.autoFocus}
                onChange={(content) => props.onChange(block.id, { content })}
                onEnterEnd={() => props.onEnterEnd(block.id)}
                onBackspaceEmpty={() => props.onBackspaceEmpty(block.id)}
                onEditor={props.onEditor}
              />
            </div>
          ) : (
            <BoardTextEditor
              block={block}
              autoFocus={props.autoFocus}
              onChange={(content) => props.onChange(block.id, { content })}
              onEnterEnd={() => props.onEnterEnd(block.id)}
              onBackspaceEmpty={() => props.onBackspaceEmpty(block.id)}
              onEditor={props.onEditor}
            />
          )
        ) : block.type === 'divider' ? (
          <div className="py-2">
            <hr className="border-0 border-t border-line" />
          </div>
        ) : block.type === 'image' ? (
          <ImageCard
            host={props.host}
            block={block}
            onPick={(mode) => props.onPickAsset(block.id, 'image', mode)}
            onOpen={() => block.src && props.onOpenFile(block.src)}
          />
        ) : block.type === 'file' ? (
          <FileCard
            host={props.host}
            block={block}
            onPick={(mode) => props.onPickAsset(block.id, 'file', mode)}
            onOpen={() => block.src && props.onOpenFile(block.src)}
            onNotice={props.onNotice}
          />
        ) : (
          <UnknownBlock block={block} />
        )}
      </div>
    </div>
  )
}

function SourceBadge({ source }: { source: BlockSource }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-1.5 py-[1px] text-[9.5px] text-ink-3"
      title={source === 'copy' ? '这个文件是复制进白板的；原文件删了也不影响' : '只记了仓库里的路径；原文件改名/删掉后会失效'}
    >
      {source === 'copy' ? <Copy className="size-2.5" /> : <Link2 className="size-2.5" />}
      {source === 'copy' ? '已复制' : '引用'}
    </span>
  )
}

function MissingHint({ label, onPick }: { label: string; onPick: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-[#e4b4af] bg-[#fdf0ef] px-2.5 py-2">
      <span className="min-w-0 flex-1 truncate text-[11px] text-[#8f1d17]">{label}</span>
      <button
        type="button"
        onClick={onPick}
        className="shrink-0 rounded border border-[#e4b4af] px-1.5 py-0.5 text-[10.5px] text-[#8f1d17] hover:bg-[#fbe4e2]"
      >
        重新选择
      </button>
    </div>
  )
}

function ImageCard({
  host,
  block,
  onPick,
  onOpen,
}: {
  host: Host
  block: BoardBlock
  onPick: (mode: BlockSource) => void
  onOpen: () => void
}) {
  const { url, state } = useAssetUrl(host, block.src)
  const source: BlockSource = block.source ?? 'copy'

  if (!block.src || state === 'missing') {
    return (
      <div className="flex flex-col gap-2">
        {block.src ? <MissingHint label={`找不到图片：${block.src}`} onPick={() => onPick(source)} /> : null}
        <button
          type="button"
          onClick={() => onPick('copy')}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line px-3 py-6 text-[12px] text-ink-3 hover:border-green/40 hover:text-green"
        >
          <ImageIcon className="size-4" />
          {block.src ? '换一张（复制进白板）' : '选择一张图片（会复制进白板）'}
        </button>
      </div>
    )
  }

  return (
    <figure className="py-1">
      <div className="mb-1.5 flex items-center gap-2">
        <SourceBadge source={source} />
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-3">{block.src}</span>
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-ink-3 hover:bg-surface-2 hover:text-ink-2"
        >
          打开
        </button>
      </div>
      {state === 'loading' ? (
        <div className="grid h-[140px] place-items-center rounded-lg bg-surface-2 text-[11.5px] text-ink-3">
          正在读取图片…
        </div>
      ) : (
        <img src={url ?? ''} alt={block.alt ?? ''} className="max-h-[460px] max-w-full rounded-lg" />
      )}
      {block.alt ? <figcaption className="mt-1 text-[11px] text-ink-3">{block.alt}</figcaption> : null}
    </figure>
  )
}

function FileCard({
  host,
  block,
  onPick,
  onOpen,
  onNotice,
}: {
  host: Host
  block: BoardBlock
  onPick: (mode: BlockSource) => void
  onOpen: () => void
  onNotice: (text: string) => void
}) {
  const source: BlockSource = block.source ?? 'copy'
  const name = block.name || block.src?.split('/').pop() || '文件'
  const exists = useAssetExists(host, block.src)
  const [busy, setBusy] = useState(false)

  const download = async () => {
    if (!block.src) return onPick('copy')
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
    <div className="flex flex-col gap-2">
      {exists === false ? <MissingHint label={`找不到文件：${block.src}`} onPick={() => onPick(source)} /> : null}
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2 text-ink-3">
          {block.src ? <FileGlyph path={block.src} size={16} /> : <FileText className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] text-ink">{name}</span>
            {block.src ? <SourceBadge source={source} /> : null}
          </span>
          <span className="block truncate font-mono text-[10px] text-ink-3">
            {block.src || '还没选文件'}
            {typeof block.size === 'number' && block.size > 0 ? ` · ${formatSize(block.size)}` : ''}
          </span>
        </span>
        <button
          type="button"
          onClick={() => (kindOf(block.src ?? '') === 'unknown' || !block.src ? void download() : onOpen())}
          disabled={busy || !block.src}
          className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 hover:bg-surface-2 disabled:opacity-50"
        >
          {!block.src ? '选择文件' : busy ? '读取中…' : '打开'}
        </button>
        {block.src ? (
          <button
            type="button"
            onClick={() => onPick(source)}
            className="shrink-0 rounded-md px-1.5 py-1 text-[10.5px] text-ink-3 hover:bg-surface-2 hover:text-ink-2"
          >
            更换
          </button>
        ) : null}
      </div>
      {block.src ? (
        <button
          type="button"
          onClick={() => onPick('copy')}
          className="self-start text-[10px] text-ink-3 hover:text-green"
        >
          把这份文件复制进白板（之后不再依赖原文件）
        </button>
      ) : null}
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

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
