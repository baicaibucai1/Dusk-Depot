import { useEffect, useState } from 'react'

/*
 * 数学渲染。KaTeX 压缩后两百多 KB，**只在文档里真的出现数学时才拉**。
 *
 * 加载中 / 失败 / 语法错：老实显示原始 TeX（等宽、浅底），不装作渲染好了。
 * 这就是当初把编辑器拆成懒加载 chunk 的同一条规矩。
 */

type Katex = { renderToString: (tex: string, opts: Record<string, unknown>) => string }
let loading: Promise<Katex> | null = null

function loadKatex(): Promise<Katex> {
  if (!loading) {
    loading = (async () => {
      const mod = await import('katex')
      await import('katex/dist/katex.min.css')
      return (mod.default ?? mod) as unknown as Katex
    })()
  }
  return loading
}

export function Math({ tex, block }: { tex: string; block?: boolean }) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setHtml(null)
    void loadKatex()
      .then((k) => {
        if (!alive) return
        try {
          setHtml(
            k.renderToString(tex, {
              displayMode: Boolean(block),
              throwOnError: false,
              strict: false,
              output: 'html',
            }),
          )
        } catch {
          setHtml(null)
        }
      })
      .catch(() => {
        if (alive) setHtml(null)
      })
    return () => {
      alive = false
    }
  }, [tex, block])

  // 还没渲染出来（或渲染失败）：显示原文，别留一片空白
  if (html === null) {
    return (
      <code className="rounded bg-surface-2 px-1 font-mono text-[13px] text-green-deep">{tex}</code>
    )
  }

  if (block) {
    return (
      <div
        className="my-4 overflow-x-auto text-center"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX 生成的受限 HTML，输入是本地笔记
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  return (
    <span
      className="inline-block align-middle"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: 同上
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
