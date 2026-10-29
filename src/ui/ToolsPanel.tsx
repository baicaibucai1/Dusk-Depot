import { useMemo } from 'react'
import type { FileMap } from '../core/model/library'
import { outgoingRefs, resolvePath, resolveWiki } from '../core/markdown/links'
import {
  IconDuplicate,
  IconFile,
  IconLink,
  IconTag,
  IconTrash,
  IconTool,
} from './icons'

/*
 * 左栏「工具」页。
 *
 * ⚠️ 计数纪律（宪法第三条「不假装」）：算不出来的就写「待接」，
 *    绝不填一个好看的数字。现在只有「坏链」是真算的 —— 它只需要扫一遍现有文件。
 *    孤儿 / 标签 / 查重 / 回收站要等索引（R2）和工具带（R5）。
 */

type Props = {
  files: FileMap
  /** `.note` 目录数（还没退役，先计入篇数） */
  noteDocs: number
}

const HEAD = 'flex flex-col gap-2'

function Row({
  Icon,
  title,
  hint,
  value,
  tone,
}: {
  Icon: typeof IconFile
  title: string
  hint: string
  value: string
  tone?: 'warn' | 'muted'
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5">
      <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-surface-2 text-ink-3">
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] text-ink">{title}</span>
        <span className="mt-0.5 block text-[11.5px] text-ink-3">{hint}</span>
      </span>
      <span
        className={[
          'shrink-0 pt-0.5 font-mono text-[12px]',
          tone === 'warn' ? 'text-[#a35b1c]' : 'text-ink-3',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  )
}

export function ToolsPanel({ files, noteDocs }: Props) {
  const paths = Object.keys(files)
  const total = paths.length + noteDocs

  /**
   * 坏链：扫每篇的引用，解析不到目标的就是坏链。
   * 文件太多时不算 —— resolveWiki 是线性的，整库扫是 O(n²)；
   * 与其卡住，不如老实说"篇数太多，等索引"。
   */
  const broken = useMemo(() => {
    if (paths.length > 600) return null
    let n = 0
    for (const p of paths) {
      for (const ref of outgoingRefs(files[p] ?? '')) {
        const hit =
          ref.kind === 'wiki'
            ? resolveWiki(files, ref.value)
            : // 相对路径要按"这一篇所在的目录"算，否则子目录里的 ../ 会被当成坏链
              resolvePath(files, ref.value, p)
        if (!hit) n++
      }
    }
    return n
  }, [files, paths])

  return (
    <div data-dd-tools className="min-h-0 flex-1 overflow-y-auto p-2.5">
      <div className={HEAD}>
        <div className="rounded-xl bg-green-soft px-3 py-2.5 text-green-deep">
          <div className="text-[12px]">索引还没建</div>
          <div className="mt-0.5 text-[11px] text-green-deep/70">
            {total} 篇文档 · 全文搜索要等索引（R2）
          </div>
        </div>

        <Row
          Icon={IconLink}
          title="坏链报告"
          hint="指向不存在的笔记"
          value={broken === null ? '待接' : `${broken} 条`}
          tone={broken ? 'warn' : 'muted'}
        />
        <Row Icon={IconFile} title="孤儿笔记" hint="没有任何一篇引用它" value="待接" />
        <Row Icon={IconTag} title="标签整理" hint="改名、合并、清空标签" value="待接" />
        <Row Icon={IconDuplicate} title="按指纹查重" hint="内容完全相同才报" value="待接" />
        <Row Icon={IconTrash} title="回收站" hint="删掉的先进 .dusk/trash" value="待接" />

        <p className="px-1 pt-1 text-[11px] leading-relaxed text-ink-3">
          工具带按 R5 落地：现在只有「坏链」是真算的，其余等索引。
        </p>
      </div>
    </div>
  )
}

/** 工具页签上的小图标，给 TreePanel 用 */
export const ToolTabIcon = IconTool
