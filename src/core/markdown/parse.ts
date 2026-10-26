/*
 * 把 markdown 解成一棵很浅的块树。零依赖、零 DOM —— 跑在 Node 里，所以能直接单测。
 *
 * 故意不引 markdown 库：我们要渲染的东西就这么多，而"自己写的解析器"能保证
 *   · 只认我们关心的语法（别的原样当文字，不猜）
 *   · 输出是数据结构而不是 HTML 字符串 —— 渲染层用 React 拼，天然没有 XSS 面
 * 不认的语法一律退化成普通段落文字，不做"猜你想表达什么"。
 *
 * 每个块带 `from`/`to`（1 起算的行号）。编辑器靠它判断"光标在哪个块里"：
 * 不在的那个块整块渲染，在的那个显示源码。
 *
 * 认的东西（2026-10 对齐参考编辑器——Vditor / Cherry / Milkdown——的基线）：
 *   标题 1-4、段落、列表（无序 / 有序 / 任务）、引用、代码围栏（``` 与 ~~~）、
 *   表格（带列对齐）、分割线、数学（行内 `$x$` / 块 `$$…$$`）、
 *   `**粗体**`、`*斜体*`、`~~划掉~~`、`` `行内码` ``、`[[双链]]`、`#标签`、
 *   `![图](地址)`、`[文字](地址)`、裸 URL 自动链接、反斜杠转义、硬换行。
 *
 * 几处照着参考编辑器的规矩办：
 *   · 行内码优先于强调（`` `a*b*c` `` 里的星号不当天文）
 *   · `$` 前后不能贴空白 —— 否则"省 $5 到 $10"会被当成公式
 *   · `[文字](地址 "标题")` 的标题只服务于别的工具，这里剥掉
 *   · 独占一行的 `---` / `***` 是分割线，不当 setext 标题（后者没人用）
 */

import { splitRow } from './table'

export type Align = 'left' | 'center' | 'right' | null

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'code'; v: string }
  | { t: 'wiki'; v: string }
  | { t: 'tag'; v: string }
  /** 行内数学，原样交给 KaTeX */
  | { t: 'math'; v: string }
  /** `![文字](地址)` */
  | { t: 'image'; alt: string; src: string }
  /** `[文字](地址)`，或裸 URL 自动链接（两者都是 link） */
  | { t: 'link'; v: string; href: string }
  /** `~~划掉~~` */
  | { t: 'strike'; v: string }
  /** 硬换行：行尾两个空格或一个反斜杠 */
  | { t: 'br' }

/** 块的内容（位置另加） */
export type BlockBody =
  | { t: 'heading'; level: 1 | 2 | 3 | 4; inlines: Inline[] }
  | { t: 'para'; inlines: Inline[] }
  /** 列表项。ordered=有序；start=记号里的数字（无序恒为 1）；checked=null 表示不是任务项 */
  | { t: 'li'; ordered: boolean; start: number; checked: boolean | null; inlines: Inline[] }
  | { t: 'quote'; inlines: Inline[] }
  | { t: 'code'; lang: string; text: string }
  /** 表格：表头一行 + 若干数据行；align 按列，null=不指定 */
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: Align[] }
  /** 分割线 */
  | { t: 'hr' }
  /** 块级数学（`$$…$$`），原样交给 KaTeX */
  | { t: 'mathblock'; tex: string }

/** 块 + 它在原文里占的行（1 起算，首尾都含） */
export type Block = BlockBody & { from: number; to: number }

/*
 * 行内语法。**顺序有讲究**：
 *   ① 转义打头 —— `\*` 不能被粗体抢走
 *   ② 行内码次之 —— 和 CommonMark 一样，代码区间里没有强调
 *   ③ 图片在链接前 —— `![图](a)` 里的 `[图](a)` 完全符合链接写法
 *   ④ 自动链接在标签前 —— URL 片段里的 `#锚点` 不是标签
 *   ⑤ 粗体在斜体前 —— `**x**` 不能被 `*x*` 抢走
 */
const INLINE = new RegExp(
  [
    /\\([\\`*_{}[\]()#+\-.!>~|$])/.source, // 1 转义
    /`([^`\n]+)`/.source, // 2 行内码
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.source, // 3 4 图片
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.source, // 5 6 链接
    /\[\[([^\]]+)\]\]/.source, // 7 双链
    /(https?:\/\/[^\s<>]+)/.source, // 8 裸链接
    /\*\*([^*]+)\*\*/.source, // 9 粗体
    /\*([^*]+)\*/.source, // 10 斜体
    /~~([^~\n]+)~~/.source, // 11 划掉
    /#([\p{L}\p{N}_/-]+)/u.source, // 12 标签
    /\$([^\s$](?:[^$\n]*[^\s$])?)\$/.source, // 13 行内数学
  ].join('|'),
  'gu',
)


/**
 * 切掉自动链接尾巴上的标点。
 *
 * 中英文句读一律切；右括号讲究一点：只有比左括号多才切 ——
 * `https://en.wikipedia.org/wiki/Foo_(bar)` 里的括号是路径的一部分，不能吃。
 */
export function trimUrlTail(url: string): string {
  const PUNCT = /[.,;:!?'"’”》。，！？；：、\]]+$/
  let s = url.replace(PUNCT, '')
  while (s.endsWith(')')) {
    const open = (s.match(/\(/g) ?? []).length
    const close = (s.match(/\)/g) ?? []).length
    if (close <= open) break
    s = s.slice(0, -1).replace(PUNCT, '')
  }
  return s
}


export function tokenize(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0

  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) })

    const [, esc, code, imgAlt, imgSrc, linkText, linkHref, wiki, url, bold, italic, strike, tag, math] = m
    if (esc !== undefined) out.push({ t: 'text', v: esc })
    else if (code !== undefined) out.push({ t: 'code', v: code })
    else if (imgSrc !== undefined) out.push({ t: 'image', alt: imgAlt ?? '', src: imgSrc })
    else if (linkHref !== undefined) out.push({ t: 'link', v: linkText ?? '', href: linkHref })
    else if (wiki !== undefined) out.push({ t: 'wiki', v: wiki })
    else if (url !== undefined) {
      // 尾巴上的标点切掉，留在正文里
      const clean = trimUrlTail(url)
      out.push({ t: 'link', v: clean, href: clean })
      last = at + clean.length
      continue
    } else if (bold !== undefined) out.push({ t: 'bold', v: bold })
    else if (italic !== undefined) out.push({ t: 'italic', v: italic })
    else if (strike !== undefined) out.push({ t: 'strike', v: strike })
    else if (tag !== undefined) out.push({ t: 'tag', v: tag })
    else if (math !== undefined) out.push({ t: 'math', v: math })

    last = at + m[0].length
  }

  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })

  // 相邻的纯文字合成一段：转义和 URL 切尾巴都会留下碎文本，
  // 不合并的话 `\*不斜\*` 会解成三个 token，纯文本和测试都对不齐
  const merged: Inline[] = []
  for (const tok of out) {
    const prev = merged[merged.length - 1]
    if (tok.t === 'text' && prev?.t === 'text') prev.v += tok.v
    else merged.push(tok)
  }
  return merged
}

const HEADING = /^(#{1,6})\s+(.*)$/
/** 代码围栏：``` 或 ~~~（三个以上），后面跟语言名 */
const FENCE = /^(`{3,}|~{3,})(\S*)$/
const QUOTE = /^>\s?(.*)$/
const UL = /^\s*[-*+]\s+(.*)$/
const OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
/** 任务项：`- [ ] 甲` / `1. [x] 乙` */
const TASK = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+\[([ xX])\]\s+(.*)$/
/** 分割线：--- / *** / ___（中间可以带空格，如 - - -） */
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
/** 一行表格：| a | b |（首尾竖线可有可无） */
const TABLE_ROW = /^\s*\|.*\|\s*$/
/** 分隔行：|---|---| 或 |:--|--:|。短横一个就够（GFM 是 `-+`，`:-:` 也认） */
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** 统一成 LF、去掉 BOM —— 落盘前的文本纪律，解析前也先过一遍 */
export function normalizeText(src: string): string {
  return src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** `| a | b |` → ['a','b']；竖线里的 `\|` 当转义的竖线（和 table.ts 同一把尺子） */
function cells(line: string): string[] {
  return splitRow(line)
}

/** `| :-- | --: | :-: |` → 每列的对齐；认不出来的列给 null */
function alignOf(sep: string[], cols: number): Align[] {
  const out: Align[] = []
  for (let i = 0; i < cols; i++) {
    const c = sep[i] ?? ''
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    out.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null)
  }
  return out
}

/** 一段里的一行：正文 + 它结尾处是不是硬换行（行尾两空格或一个反斜杠） */
type ParaLine = { text: string; hard: boolean }

export function parseMarkdown(src: string): Block[] {
  const lines = normalizeText(src).split('\n')
  const out: Block[] = []
  let para: ParaLine[] = []
  let paraFrom = 0

  const add = (b: BlockBody, from: number, to: number) => {
    out.push({ ...b, from, to } as Block)
  }

  const flush = (lineNo: number) => {
    if (para.length === 0) return
    const inlines: Inline[] = []
    para.forEach((ln, i) => {
      // 行与行之间：上一行结尾有硬换行标记就断行，否则并成一段（原有行为）
      if (i > 0) inlines.push(para[i - 1]?.hard ? { t: 'br' } : { t: 'text', v: ' ' })
      inlines.push(...tokenize(ln.text))
    })
    add({ t: 'para', inlines }, paraFrom, lineNo)
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const lineNo = i + 1

    if (line.trim() === '') {
      flush(lineNo - 1)
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      flush(lineNo - 1)
      const ticks = fence[1] ?? '```'
      const lang = fence[2] ?? ''
      const close = new RegExp(`^${ticks[0] ?? '`'}{3,}\\s*$`)
      const body: string[] = []
      const start = lineNo
      i++
      while (i < lines.length && !close.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '')
        i++
      }
      add({ t: 'code', lang, text: body.join('\n') }, start, Math.min(i + 1, lines.length))
      continue
    }

    // 块级数学：$$tex$$ 或者 $$ 折行 $$
    if (line.trim().startsWith('$$')) {
      const rest = line.trim().slice(2)
      if (rest.endsWith('$$') && rest.length >= 2) {
        flush(lineNo - 1)
        add({ t: 'mathblock', tex: rest.slice(0, -2).trim() }, lineNo, lineNo)
        continue
      }
      if (rest.trim() === '') {
        flush(lineNo - 1)
        const body: string[] = []
        const start = lineNo
        i++
        while (i < lines.length && !(lines[i] ?? '').trim().endsWith('$$')) {
          body.push(lines[i] ?? '')
          i++
        }
        const tail = (lines[i] ?? '').trim()
        if (tail && tail !== '$$') body.push(tail.slice(0, -2))
        add({ t: 'mathblock', tex: body.join('\n').trim() }, start, i + 1)
        continue
      }
    }

    // 表格：这一行是 |…|，下一行是分隔行
    if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[i + 1] ?? '')) {
      flush(lineNo - 1)
      const start = lineNo
      const headCells = cells(line).map((c) => tokenize(c))
      const sepCells = cells(lines[i + 1] ?? '')
      const cols = Math.max(1, headCells.length, sepCells.length)
      while (headCells.length < cols) headCells.push([])
      const align = alignOf(sepCells, cols)
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && TABLE_ROW.test(lines[i] ?? '')) {
        const row = cells(lines[i] ?? '').map((c) => tokenize(c))
        while (row.length < cols) row.push([])
        rows.push(row)
        i++
      }
      i--
      add({ t: 'table', head: headCells, rows, align }, start, i + 1)
      continue
    }

    // 分割线。放在列表前面 —— `- - -` 既是分割线也是"内容为 - - 的列表项"
    if (HR.test(line)) {
      flush(lineNo - 1)
      add({ t: 'hr' }, lineNo, lineNo)
      continue
    }

    const task = TASK.exec(line)
    if (task) {
      flush(lineNo - 1)
      const ordered = task[3] !== undefined
      const start = ordered ? Number(task[3]) : 1
      add(
        { t: 'li', ordered, start, checked: (task[4] ?? ' ').toLowerCase() === 'x', inlines: tokenize(task[5] ?? '') },
        lineNo,
        lineNo,
      )
      continue
    }

    const ol = OL.exec(line)
    if (ol) {
      flush(lineNo - 1)
      add({ t: 'li', ordered: true, start: Number(ol[2] ?? 1), checked: null, inlines: tokenize(ol[3] ?? '') }, lineNo, lineNo)
      continue
    }

    const head = HEADING.exec(line)
    if (head) {
      flush(lineNo - 1)
      const level = Math.min((head[1] ?? '#').length, 4) as 1 | 2 | 3 | 4
      add({ t: 'heading', level, inlines: tokenize(head[2] ?? '') }, lineNo, lineNo)
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      flush(lineNo - 1)
      add({ t: 'quote', inlines: tokenize(quote[1] ?? '') }, lineNo, lineNo)
      continue
    }

    const li = UL.exec(line)
    if (li) {
      flush(lineNo - 1)
      add({ t: 'li', ordered: false, start: 1, checked: null, inlines: tokenize(li[1] ?? '') }, lineNo, lineNo)
      continue
    }

    // 段落累积。硬换行的标记要在 trim 之前看 ——  trim 会把行尾空格吃掉
    const hard = /(?: {2,}|\\)$/.test(line)
    const text = (hard ? line.replace(/(?: {2,}|\\)$/, '') : line).trim()
    if (para.length === 0) paraFrom = lineNo
    para.push({ text, hard })
  }

  flush(paraFrom + para.length - 1)
  return out
}

/** 行内 token 的纯文本（大纲、标题、引用文字要用） */
export function plainText(items: Inline[]): string {
  return items.map((i) => (i.t === 'image' ? i.alt : 'v' in i ? i.v : '')).join('')
}

/** 大纲：只取标题，右栏用 */
export function outlineOf(src: string): { level: number; text: string }[] {
  return parseMarkdown(src).flatMap((b) =>
    b.t === 'heading' ? [{ level: b.level, text: plainText(b.inlines) }] : [],
  )
}
