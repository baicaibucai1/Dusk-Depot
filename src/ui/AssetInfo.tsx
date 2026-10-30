import type { ReactNode } from 'react'
import { FileImage, FileType } from 'lucide-react'
import { kindOf } from '../core/model/fileKind'
import { extOf, nameOf, parentOf } from '../core/model/path'

/*
 * 右栏在"打开的不是 markdown"时的样子。
 *
 * 为什么单独一个组件：Aside 里全是大纲 / 反链 / 悬空链接，这些只对文本有意义。
 * 对着一张图片去算"引用这篇的"，除了浪费一次全库扫描，还会显示出无关内容。
 * 这里只给这一类文件真正有的信息，并且**明说它是只读的**。
 */

type Props = {
  path: string
  open: boolean
  width: number
  onClose: () => void
  resizer?: ReactNode
}

export function AssetInfo({ path, open, width, onClose, resizer }: Props) {
  const kind = kindOf(path)
  const isPdf = kind === 'pdf'
  const ext = extOf(path).replace('.', '').toUpperCase() || '未知'
  const dir = parentOf(path)

  const rows: { label: string; value: string }[] = [
    { label: '名称', value: nameOf(path) },
    { label: '格式', value: ext },
    { label: '位置', value: dir || '仓库根目录' },
    { label: '打开方式', value: '只读预览' },
  ]

  return (
    <aside
      aria-label="文件信息"
      aria-hidden={!open}
      style={{ width: open ? width : 0 }}
      className={[
        'relative flex shrink-0 overflow-hidden bg-surface transition-[width] duration-200 ease-out',
        open ? 'border-l border-line' : 'pointer-events-none',
      ].join(' ')}
    >
      <div style={{ width }} className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="text-[12.5px] font-medium text-ink">文件信息</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭右栏"
            className="ml-auto grid size-7 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-2"
          >
            <span className="text-[15px] leading-none">×</span>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="mb-3 flex items-center gap-2">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-green-soft text-green">
              {isPdf ? <FileType className="size-5" /> : <FileImage className="size-5" />}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[12.5px] text-ink" title={path}>
                {nameOf(path)}
              </span>
              <span className="block text-[11px] text-ink-3">
                {isPdf ? 'PDF 文档' : '图片'}
              </span>
            </span>
          </div>

          <dl className="space-y-2">
            {rows.map((r) => (
              <div key={r.label} className="rounded-md bg-surface-2/50 px-2.5 py-2">
                <dt className="text-[10.5px] tracking-wide text-ink-3">{r.label}</dt>
                <dd className="mt-0.5 break-all text-[12px] text-ink-2" title={r.value}>
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>

          <p className="mt-3 px-1 text-[11px] leading-relaxed text-ink-3">
            这类文件只能看，不能改 —— 所以没有字数、大纲和反链。
          </p>
        </div>
      </div>
      {open ? resizer : null}
    </aside>
  )
}
