/*
 * `.note` 里的**白板引用块**。
 *
 * 它只保存三样东西：`boardId`（身份）、`path`（定位提示）、`view`（显示方式）。
 * **不复制白板内容** —— 打开就是那块 `.board` 本身，改动两边永远一致。
 *
 * 找不到的时候必须**明说**：显示"白板找不到"，并把过期路径原样列出来，
 * 给一个「重新定位」。绝不显示上一次看到的旧内容 —— 那等于骗人。
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowUpRight, RefreshCw } from 'lucide-react'
import {
  type BoardFileDoc,
  boardPlainText,
  parseBoardFile,
  titleOfBoardPath,
} from '../../core/board/file'
import type { BoardBlock } from '../../core/note/board'
import { type BoardEntry, resolveBoard } from '../../core/board/refs'
import { decodeBytes } from '../../core/model/text'
import type { Host } from '../../core/ports/host'
import { FileGlyph } from '../fileIcon'

type Props = {
  host: Host
  block: BoardBlock
  boards: BoardEntry[]
  onOpen: (path: string) => void
  onRelocate: (blockId: string) => void
}

type Preview = { state: 'loading' | 'ok' | 'bad'; doc?: BoardFileDoc }

/** 预览卡片要读一眼那块白板：几块、几条连接、头两行字 */
function useBoardPreview(host: Host, path: string | null, on: boolean): Preview {
  const [preview, setPreview] = useState<Preview>({ state: 'loading' })

  useEffect(() => {
    if (!on || !path) return
    let alive = true
    setPreview({ state: 'loading' })
    void (async () => {
      try {
        const parsed = parseBoardFile(decodeBytes(await host.read(path)), titleOfBoardPath(path))
        if (!alive) return
        if (parsed.kind === 'ok') setPreview({ state: 'ok', doc: parsed.doc })
        else setPreview({ state: 'bad' })
      } catch {
        if (alive) setPreview({ state: 'bad' })
      }
    })()
    return () => {
      alive = false
    }
  }, [host, path, on])

  return preview
}

export function BoardRefBlock({ host, block, boards, onOpen, onRelocate }: Props) {
  const ref = {
    boardId: block.boardId ?? '',
    path: block.path ?? '',
    view: block.view === 'preview' ? ('preview' as const) : ('compact' as const),
  }
  const hit = resolveBoard(ref, boards)
  const preview = useBoardPreview(host, hit?.entry.path ?? null, ref.view === 'preview')
  const missing = !hit

  const title = hit?.entry.title ?? (ref.path.split('/').pop() || '白板')
  const stale = hit && hit.via === 'path'

  if (missing) {
    return (
      <div className="rounded-xl border border-dashed border-[#e4b4af] bg-[#fdf0ef] px-4 py-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 shrink-0 text-[#8f1d17]" />
          <span className="min-w-0 flex-1 text-[12.5px] font-medium text-[#8f1d17]">白板找不到</span>
          <button
            type="button"
            onClick={() => onRelocate(block.id)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[#e4b4af] px-2 py-1 text-[11px] text-[#8f1d17] hover:bg-[#fbe4e2]"
          >
            <RefreshCw className="size-3" />
            重新定位
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-[#8f1d17]/85">
          原来指向的那块白板已经被删掉、或被搬到了别的地方。引用记录里的路径是：
        </p>
        <p className="mt-1 font-mono text-[10.5px] break-all text-[#8f1d17]/75">
          {ref.path || '（没有记录路径）'}
          {ref.boardId ? ` · ${ref.boardId}` : ''}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3 transition-colors hover:border-green/35">
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-green-soft text-green">
          <FileGlyph path={hit.entry.path} size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] text-ink" title={hit.entry.title}>
              {title}
            </span>
            <span className="shrink-0 rounded bg-surface-2 px-1 text-[9.5px] text-ink-3">白板</span>
          </span>
          <span className="block truncate font-mono text-[10px] text-ink-3">{hit.entry.path}</span>
        </span>
        <button
          type="button"
          onClick={() => onOpen(hit.entry.path)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-ink-2 hover:border-green/40 hover:bg-green-soft hover:text-green"
        >
          打开
          <ArrowUpRight className="size-3" />
        </button>
      </div>

      {stale ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-[#fdf8ec] px-2 py-1 text-[10.5px] leading-relaxed text-[#7a5b18]">
          <AlertTriangle className="mt-[2px] size-3 shrink-0" />
          引用记录的 id 和这块白板对不上，现在按路径找到的是它。点「重新定位」可以把引用重新绑定到这块白板。
          <button
            type="button"
            onClick={() => onRelocate(block.id)}
            className="ml-auto shrink-0 underline decoration-dotted"
          >
            重新定位
          </button>
        </p>
      ) : null}

      {ref.view === 'preview' && !stale ? (
        <div className="mt-2 border-t border-line/70 pt-2">
          {preview.state === 'loading' ? (
            <p className="text-[10.5px] text-ink-3">正在读这块白板…</p>
          ) : preview.state === 'bad' || !preview.doc ? (
            <p className="text-[10.5px] text-ink-3">白板读不出来（文件可能坏了），打开看看。</p>
          ) : (
            <>
              <p className="text-[10.5px] text-ink-3">
                {preview.doc.layout.order.length} 块 · {preview.doc.links.length} 条连接
              </p>
              <p className="mt-1 line-clamp-3 text-[11.5px] leading-relaxed text-ink-2">
                {boardPlainText(preview.doc).replace(/\n+/g, ' · ').slice(0, 220) || '（这块白板还是空的）'}
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
