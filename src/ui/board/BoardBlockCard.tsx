/*
 * `.board` 一块卡片的**内容**（不含定位、拖动、工具条 —— 那些在 BoardCanvas 里）。
 *
 * 为什么拆开：画布那一层负责"在哪儿、多大、选中没选中"，这一层只负责
 * "这块是什么类型、长什么样、点了算谁的"。两块职责混在一起的话，
 * 想改画布手势就得动内容渲染，迟早互相绊住。
 *
 * 图片和文件有两种来路，卡片上必须说清楚：
 *   · 已复制 —— 文件在 `.dusk/board/<boardId>/` 里，原文件删了也不影响
 *   · 引用   —— 只记仓库里的路径，原文件改名/删掉就会失效（红条 + 重新选择）
 */
import type { Editor } from '@tiptap/core'
import { Copy, FileText, Image as ImageIcon, Link2, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BoardBlock, BlockSource } from '../../core/board/file'
import { kindOf } from '../../core/model/fileKind'
import { decodeBytes } from '../../core/model/text'
import type { Inline } from '../../core/note/flow'
import type { Host } from '../../core/ports/host'
import { useAssetExists, useAssetUrl } from '../assetUrl'
import { FileGlyph } from '../fileIcon'
import { BoardTextEditor } from '../note/BoardTextEditor'

type Props = {
  host: Host
  block: BoardBlock
  autoFocus: boolean
  onChange: (id: string, patch: Partial<BoardBlock>) => void
  onEnterEnd: (id: string) => void
  onBackspaceEmpty: (id: string) => void
  onEditor: (id: string, editor: Editor | null) => void
  onOpenFile: (path: string) => void
  onNotice: (text: string) => void
  /** 换图 / 换文件：mode 决定是复制进来还是引用仓库文件 */
  onPickAsset?: (id: string, kind: 'image' | 'file', mode: BlockSource) => void
}

const TEXT = new Set(['paragraph', 'heading1', 'heading2', 'quote', 'todo'])

export function BoardBlockBody(props: Props) {
  const { block, onChange } = props

  if (TEXT.has(block.type)) {
    if (block.type === 'todo') {
      return (
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
              autoFocus={props.autoFocus}
              onChange={(content: Inline[]) => onChange(block.id, { content })}
              onEnterEnd={() => props.onEnterEnd(block.id)}
              onBackspaceEmpty={() => props.onBackspaceEmpty(block.id)}
              onEditor={props.onEditor}
            />
          </div>
        </div>
      )
    }
    if (block.type === 'quote') {
      return (
        <div className="border-l-[3px] border-[#d5e6dd] pl-3 text-ink-2">
          <BoardTextEditor
            block={block}
            autoFocus={props.autoFocus}
            onChange={(content) => onChange(block.id, { content })}
            onEnterEnd={() => props.onEnterEnd(block.id)}
            onBackspaceEmpty={() => props.onBackspaceEmpty(block.id)}
            onEditor={props.onEditor}
          />
        </div>
      )
    }
    return (
      <BoardTextEditor
        block={block}
        autoFocus={props.autoFocus}
        onChange={(content) => onChange(block.id, { content })}
        onEnterEnd={() => props.onEnterEnd(block.id)}
        onBackspaceEmpty={() => props.onBackspaceEmpty(block.id)}
        onEditor={props.onEditor}
      />
    )
  }

  if (block.type === 'divider') {
    return (
      <div className="py-2">
        <hr className="border-0 border-t border-line" />
      </div>
    )
  }

  if (block.type === 'image') {
    return (
      <ImageBody
        host={props.host}
        block={block}
        onPick={(mode) => props.onPickAsset?.(block.id, 'image', mode)}
        onOpen={() => block.src && props.onOpenFile(block.src)}
      />
    )
  }

  if (block.type === 'file') {
    return (
      <FileBody
        host={props.host}
        block={block}
        onPick={(mode) => props.onPickAsset?.(block.id, 'file', mode)}
        onOpen={() => block.src && props.onOpenFile(block.src)}
        onNotice={props.onNotice}
      />
    )
  }

  return <UnknownBlock block={block} />
}

function SourceBadge({ source }: { source: BlockSource }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-1.5 py-[1px] text-[9.5px] text-ink-3"
      title={
        source === 'copy'
          ? '这个文件是复制进白板的；原文件删了也不影响'
          : '只记了仓库里的路径；原文件改名/删掉后会失效'
      }
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

function ImageBody({
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
    <figure>
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
        <img src={url ?? ''} alt={block.alt ?? ''} className="max-h-[460px] w-full rounded-lg object-contain" />
      )}
      {block.alt ? <figcaption className="mt-1 text-[11px] text-ink-3">{block.alt}</figcaption> : null}
    </figure>
  )
}

function FileBody({
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

  const kind = block.src ? kindOf(block.src) : 'unknown'
  const openable = Boolean(block.src) && kind !== 'unknown'
  const preview = useTextPreview(host, block.src, kind)

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
          onClick={() => (openable ? onOpen() : void download())}
          disabled={busy || !block.src}
          title={openable ? '在文件区打开（双击卡片也行）' : '这是二进制文件，点了直接下载'}
          className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 hover:bg-surface-2 disabled:opacity-50"
        >
          {!block.src ? '选择文件' : busy ? '读取中…' : openable ? '打开' : '下载'}
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
      {preview ? (
        <div
          data-dd-file-preview
          className="overflow-hidden rounded-lg border border-line/70 bg-surface-2/60 px-2.5 py-2"
        >
          <pre className="m-0 max-h-[120px] overflow-hidden font-mono text-[10.5px] leading-[1.7] whitespace-pre-wrap text-ink-2">
            {preview.text}
            {preview.more ? '…' : ''}
          </pre>
        </div>
      ) : null}
      {block.src && kind === 'pdf' ? (
        <p className="text-[10.5px] text-ink-3">PDF 文档 · 双击卡片在文件区打开</p>
      ) : null}
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

/**
 * 纯文本类文件读个开头当预览。
 *
 * 只对"确定是文字"的类型读：PDF/压缩包读出来是乱码，不如不读。
 * 上限 600 字，够看清这是什么文件，又不会把一张卡片撑爆。
 */
const PREVIEW_KINDS = new Set(['md', 'text', 'code', 'sheet'])

function useTextPreview(
  host: Host,
  src: string | undefined,
  kind: string,
): { text: string; more: boolean } | null {
  const [preview, setPreview] = useState<{ text: string; more: boolean } | null>(null)
  useEffect(() => {
    if (!src || !PREVIEW_KINDS.has(kind)) {
      setPreview(null)
      return
    }
    let alive = true
    void (async () => {
      try {
        const bytes = await host.read(src)
        if (!alive) return
        const full = decodeBytes(bytes)
        const text = full.slice(0, 600).trimEnd()
        setPreview({ text, more: full.length > 600 })
      } catch {
        // 读不出来就不预览 —— 卡面上还有名字和"失效"提示，不影响别的
        if (alive) setPreview(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [host, src, kind])
  return preview
}
