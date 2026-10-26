/*
 * markdown 的渲染组件。
 *
 * ⚠️ 这里被**两个地方**共用：阅读模式（DocPane）和编写模式的块级预览（CM6 里的 widget）。
 *    共用的意义就在这儿 —— "阅读和编写长得一样"不是靠两套 CSS 对齐出来，
 *    而是因为压根就是同一个组件。
 *
 * 排版按「一套尺度」来定，不再各处拍脑袋：
 *   字号阶梯 28 / 20 / 16.5 / 15，正文 15 · 行高 1.85
 *   块间距用 0.25rem 的倍数，标题上方留白比下方大一档（视觉上归组）
 */
import { createContext, useContext } from 'react'
import { type Block, type Inline, tokenize } from '../../core/markdown/parse'
import { Math } from '../Math'
import { resolveImage } from './imageStore'

/**
 * 双击跳转。放 context 里而不是层层传参 —— 渲染树很深（BlockView → InlineView），
 * 而且 CodeMirror 里的 widget 是另一个 React root，拿不到 props 链。
 */
export type JumpKind = 'wiki' | 'path' | 'url'
export const JumpContext = createContext<((target: string, kind: JumpKind) => void) | null>(null)

/**
 * 阅读模式里点任务框：勾上/取消勾。带上块所在行号（1 起算）和想要的勾态，
 * 由 DocPane 改源文件那一行的 `[ ]` / `[x]`。
 *
 * 编写模式不提供这个 context —— 那儿 `- [ ]` 就是正文，直接改字就行。
 */
export const TaskContext = createContext<((line: number, checked: boolean) => void) | null>(null)

/** 任务框。阅读模式里可点；没有回调（比如编写模式的 widget）就是只读样子 */
function TaskBox({ checked, line }: { checked: boolean; line: number }) {
  const toggle = useContext(TaskContext)
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? '已完成，点此取消' : '未完成，点此勾选'}
      disabled={!toggle}
      onClick={() => toggle?.(line, !checked)}
      title={toggle ? (checked ? '标记为未做' : '标记为已完成') : undefined}
      className={[
        'mt-[0.36em] grid size-[15px] shrink-0 place-items-center rounded-[5px] border transition-colors',
        checked ? 'border-green bg-green text-white' : 'border-line bg-surface',
        toggle ? 'cursor-pointer hover:border-green/60' : 'cursor-default',
      ].join(' ')}
    >
      {checked ? (
        <svg
          viewBox="0 0 16 16"
          className="size-2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3.5 8.5l3 3 6-6.5" />
        </svg>
      ) : null}
    </button>
  )
}

export function InlineView({ items }: { items: Inline[] }) {
  const jump = useContext(JumpContext)
  return (
    <>
      {items.map((it, i) => {
        switch (it.t) {
          case 'br':
            return <br key={i} />
          // 里面可能还套着行内码/链接，所以递归解析一遍，别把反引号原样吐出来
          case 'bold':
            return (
              <strong key={i} className="font-semibold text-ink">
                <InlineView items={tokenize(it.v)} />
              </strong>
            )
          case 'italic':
            return (
              <em key={i} className="italic">
                <InlineView items={tokenize(it.v)} />
              </em>
            )
          case 'strike':
            return (
              <del key={i} className="text-ink-3 line-through decoration-ink-3/50">
                <InlineView items={tokenize(it.v)} />
              </del>
            )
          case 'code':
            return (
              <code
                key={i}
                className="rounded-[5px] border border-line/60 bg-surface-2 px-[0.35em] py-[0.1em] font-mono text-[0.86em] text-green-deep"
              >
                {it.v}
              </code>
            )
          case 'wiki':
            return (
              <span
                key={i}
                className="cursor-pointer whitespace-nowrap"
                title={jump ? `双击打开「${it.v}」` : it.v}
                onDoubleClick={(e) => {
                  e.preventDefault()
                  jump?.(it.v, 'wiki')
                }}
              >
                <span className="text-ink-3/40">[[</span>
                <span className="border-b border-green/30 pb-px text-green">{it.v}</span>
                <span className="text-ink-3/40">]]</span>
              </span>
            )
          case 'tag':
            return (
              <span
                key={i}
                className="whitespace-nowrap rounded-full bg-green-soft px-[0.45em] py-[0.1em] text-[0.87em] text-green"
              >
                <span className="text-green/50">#</span>
                {it.v}
              </span>
            )
          case 'link': {
            // 仓库内的相对路径 = 站内跳转；http(s)/mailto = 交给浏览器
            const external = /^(https?:|mailto:)/i.test(it.href)
            return (
              <a
                key={i}
                role="link"
                tabIndex={0}
                className="cursor-pointer text-green underline decoration-green/35 underline-offset-2"
                title={jump ? `双击打开 ${it.href}` : it.href}
                onDoubleClick={(e) => {
                  e.preventDefault()
                  jump?.(it.href, external ? 'url' : 'path')
                }}
              >
                {/* 链接文字里也允许行内语法：`[**粗体**](地址)` */}
                <InlineView items={tokenize(it.v)} />
              </a>
            )
          }
          case 'math':
            return <Math key={i} tex={it.v} />
          case 'image': {
            const url = resolveImage(it.src)
            // 还没读到字节（或在别的仓库里）：老实显示占位，别装加载成功
            if (!url) {
              return (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2/60 px-1.5 py-0.5 text-[12px] text-ink-3"
                  title={it.src}
                >
                  <span aria-hidden>▧</span>
                  {it.alt || it.src}
                </span>
              )
            }
            return (
              <img
                key={i}
                src={url}
                alt={it.alt}
                className="mx-auto my-4 block max-h-[30rem] max-w-full rounded-lg border border-line/70 shadow-[0_1px_3px_rgba(16,35,28,0.06)]"
                loading="lazy"
              />
            )
          }
          default:
            return <span key={i}>{it.v}</span>
        }
      })}
    </>
  )
}

/**
 * 标题按 **em** 写，跟着 `--dd-fs` 走 —— 设置里调一次字号，整篇的层级一起缩放，
 * 不用把每个标题的 px 再改一遍。
 */
const H: Record<1 | 2 | 3 | 4, string> = {
  1: 'mt-[0.5em] mb-[1.1em] text-[1.87em] leading-[1.24] font-semibold tracking-[-0.024em] text-ink',
  2: 'mt-[2em] mb-[0.6em] text-[1.33em] leading-[1.35] font-semibold tracking-[-0.012em] text-ink',
  3: 'mt-[1.6em] mb-[0.4em] text-[1.1em] leading-[1.45] font-semibold text-ink',
  4: 'mt-[1.2em] mb-[0.3em] text-[1em] leading-[1.5] font-semibold tracking-[0.01em] text-ink-2',
}

export function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case 'heading': {
      const cls = H[b.level]
      if (b.level === 1)
        return (
          <h1 className={cls}>
            <InlineView items={b.inlines} />
          </h1>
        )
      if (b.level === 2)
        return (
          <h2 className={cls}>
            <InlineView items={b.inlines} />
          </h2>
        )
      if (b.level === 3)
        return (
          <h3 className={cls}>
            <InlineView items={b.inlines} />
          </h3>
        )
      return (
        <h4 className={cls}>
          <InlineView items={b.inlines} />
        </h4>
      )
    }

    case 'li':
      // 任务项：一个可点的框（阅读模式）。勾态只改源文件里那个 `[x]`
      if (b.checked !== null) {
        return (
          <div
            data-dd-li="task"
            data-dd-checked={b.checked ? 'true' : 'false'}
            className="group mb-1.5 flex items-start gap-2.5"
          >
            <TaskBox checked={b.checked} line={b.from} />
            <p className="min-w-0 flex-1 text-ink">
              <InlineView items={b.inlines} />
            </p>
          </div>
        )
      }
      // 有序列表：显示记号里的数字（`3.` 就是 3，不重新编号 —— 源码是什么样就什么样）
      if (b.ordered) {
        return (
          <div data-dd-li="ordered" className="group mb-1.5 flex items-start gap-2.5">
            <span
              aria-hidden
              data-dd-num=""
              className="mt-[0.72em] w-[1.6em] shrink-0 text-right font-mono text-[0.88em] tabular-nums text-green-deep"
            >
              {b.start}.
            </span>
            <p className="min-w-0 flex-1 text-ink">
              <InlineView items={b.inlines} />
            </p>
          </div>
        )
      }
      return (
        <div data-dd-li="bullet" className="group mb-1.5 flex items-start gap-2.5">
          {/* 圆点用 em 定位，跟着字号走，不再靠魔数像素 */}
          <span
            aria-hidden
            className="mt-[0.72em] size-[5px] shrink-0 rounded-full bg-green/55 ring-2 ring-green-soft/70"
          />
          <p className="min-w-0 flex-1 text-ink">
            <InlineView items={b.inlines} />
          </p>
        </div>
      )

    case 'hr':
      return <hr className="my-8 border-0 border-t border-line/80" />

    case 'quote':
      return (
        <blockquote className="my-6 rounded-r-lg border-l-[3px] border-green/35 bg-surface-2/40 py-2 pr-3 pl-4 text-[14.5px] leading-[1.8] text-ink-2">
          <InlineView items={b.inlines} />
        </blockquote>
      )

    case 'code':
      return (
        <div className="mb-6 overflow-hidden rounded-xl border border-line/80 bg-surface-2/55">
          <div className="flex items-center justify-between border-b border-line/60 px-3.5 py-1.5">
            <span className="font-mono text-[10.5px] tracking-wide text-ink-3 uppercase">
              {b.lang || 'text'}
            </span>
            <span className="text-[10.5px] text-ink-3/60">{b.text.split('\n').length} 行</span>
          </div>
          <pre className="overflow-x-auto px-4 py-3 font-mono text-[0.87em] leading-[1.7] text-green-deep">
            <code>{b.text}</code>
          </pre>
        </div>
      )

    case 'table':
      return (
        <div className="mb-6 overflow-hidden rounded-xl border border-line/80">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.93em]">
              <thead>
                <tr className="bg-surface-2/60">
                  {b.head.map((cell, i) => (
                    <th
                      key={i}
                      // 对齐来自分隔行 `:--` / `:-:` / `--:`；没写就不指定
                      style={b.align[i] ? { textAlign: b.align[i] as 'left' | 'center' | 'right' } : undefined}
                      className="border-b border-line px-3.5 py-2.5 text-left text-[13px] font-medium tracking-wide text-ink-2"
                    >
                      <InlineView items={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, ri) => (
                  <tr key={ri} className="transition-colors hover:bg-surface-2/30">
                    {row.map((cell, ci) => (
                      <td
                        key={ci}
                        style={b.align[ci] ? { textAlign: b.align[ci] as 'left' | 'center' | 'right' } : undefined}
                        className="border-b border-line/50 px-3.5 py-2.5 align-top text-ink [tr:last-child_&]:border-b-0"
                      >
                        <InlineView items={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )

    case 'mathblock':
      return (
        <div className="my-6 rounded-xl bg-surface-2/40 py-3">
          <Math tex={b.tex} block />
        </div>
      )

    default: {
      // 一段里只有一张图 = 独立图片：居中成"图"，alt 当图注
      const onlyImage = b.inlines.length === 1 && b.inlines[0]?.t === 'image'
      if (onlyImage && b.inlines[0]?.t === 'image') {
        const alt = b.inlines[0].alt
        return (
          <figure data-image-block className="my-6 flex flex-col items-center">
            <InlineView items={b.inlines} />
            {alt ? (
              <figcaption className="mt-1.5 text-[0.8em] text-ink-3">{alt}</figcaption>
            ) : null}
          </figure>
        )
      }
      return (
        <p className="mb-[var(--dd-pg)] text-ink">
          <InlineView items={b.inlines} />
        </p>
      )
    }
  }
}
