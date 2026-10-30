import { history, defaultKeymap, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState, StateEffect, StateField, type Range, type Text } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  drawSelection,
  keymap,
} from '@codemirror/view'
import { tags as tg } from '@lezer/highlight'
import { createRoot, type Root } from 'react-dom/client'
import type { Block } from '../../core/markdown/parse'
import type { Align } from '../../core/markdown/parse'
import { parseMarkdown, trimUrlTail } from '../../core/markdown/parse'
import { linkAt } from '../../core/markdown/links'
import { mathContextAt } from '../../core/markdown/mathPanel'
import { tableAt } from '../../core/markdown/table'
import { Math as MathView } from '../Math'
import { resolveImage } from '../markdown/imageStore'
import { BlockView } from '../markdown/render'
import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref } from 'react'

/*
 * 正文编辑器。两种形态共用一份：
 *   live = true   **编写**（实时预览）：默认渲染出来，只有**光标所在那一行**露出记号
 *   live = false  **原代码**：记号全露，只压灰
 *
 * 做法全部是 decoration，不动文档、不改 schema：
 *   · 记号（#、>、-、**、`、[[ ]]）在非当前行用 `Decoration.replace` 藏掉
 *   · 藏掉之后给里面的文字套 mark 样式（标题放大、粗体、链接色、标签药丸）
 *   · 当前行不藏、只压灰 —— 于是"想改语法"的时候它就在那儿
 *
 * ⚠️ 记号不用 highlight tag。试过 `processingInstruction`，markdown 语言没把它落到
 *    行首的 `#` / `-` / `>` 上，一个都没变色。自己按正则算位置是确定的。
 */

const hl = HighlightStyle.define([
  { tag: tg.heading, color: 'var(--color-ink)', fontWeight: '600' },
  { tag: tg.strong, color: 'var(--color-ink)', fontWeight: '600' },
  { tag: tg.emphasis, fontStyle: 'italic' },
  { tag: tg.link, color: 'var(--color-green)' },
  { tag: tg.monospace, fontFamily: 'var(--font-mono)', fontSize: '13px' },
  { tag: tg.quote, color: 'var(--color-ink-2)' },
  { tag: tg.labelName, color: 'var(--color-green)' },
])

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--color-ink)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-sans)', overflow: 'auto' },
    '.cm-content': {
      // 尺寸全部来自设置面板写的 CSS 变量，跟阅读模式保持同一套
      maxWidth: 'var(--dd-cw)',
      margin: '0 auto',
      padding: '40px 40px 112px',
      fontSize: 'var(--dd-fs)',
      lineHeight: 'var(--dd-lh)',
      fontFamily: 'var(--dd-font)',
      caretColor: 'var(--color-green)',
    },
    '.cm-line': { padding: '0' },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--color-green)',
      borderLeftWidth: '2px',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--color-green-soft)',
    },
    '.cm-activeLine': { backgroundColor: 'transparent' },


    '.dd-bullet': { color: 'rgba(14,155,102,0.55)', marginRight: '10px' },
    // 有序列表序号：等宽数字，和 bullet 同一个槽位
    '.dd-num': {
      color: 'var(--color-green-deep)',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.88em',
      fontVariantNumeric: 'tabular-nums',
      marginRight: '7px',
    },
    // 任务框：`- [ ]` 换成的方框。编写模式只是样子 —— 改勾态直接改字
    '.dd-check': {
      display: 'inline-block',
      width: '13px',
      height: '13px',
      borderRadius: '4px',
      border: '1.5px solid var(--color-line)',
      backgroundColor: 'var(--color-surface)',
      verticalAlign: '-1px',
      marginRight: '8px',
    },
    '.dd-check-on': {
      backgroundColor: 'var(--color-green)',
      borderColor: 'var(--color-green)',
      color: '#fff',
    },
    '.dd-check svg': { display: 'block', width: '9px', height: '9px', margin: '1px' },
    '.dd-strike': { textDecoration: 'line-through', color: 'var(--color-ink-3)' },
    // 块 widget 会继承正文行高（1.85），表格这类按字号算高度的元素会因此变高
    '.dd-block': { margin: '0', lineHeight: '1.5' },
    // 渲染层给块留了 my-5（阅读时好看），编辑器里太松，收一收
    '.dd-block > div': { margin: '10px 0' },
    '.dd-block .katex-display': { margin: '0' },
    '.dd-fence-label': {
      display: 'inline-block',
      fontFamily: 'var(--font-mono)',
      fontSize: '10.5px',
      color: 'var(--color-ink-3)',
      background: 'var(--color-surface-2)',
      borderRadius: '4px',
      padding: '1px 6px',
    },
    '.dd-nothing': { display: 'none' },
    '.dd-math-raw': { color: 'var(--color-green)' },
    // 渲染出来的行内公式是可点的（点进去就还原成源码），光标要给个提示
    '.dd-math': { cursor: 'text', borderRadius: '4px', padding: '0 1px' },
    '.dd-math:hover': { background: 'var(--color-green-soft)' },
    /*
     * 链接做成胶囊，不是换个颜色。
     * 用 inset 阴影画描边而不是 border —— border 会改变行高，整段文字会抖。
     */
    '.dd-link': {
      color: 'var(--color-green-deep)',
      background: 'var(--color-green-soft)',
      borderRadius: '999px',
      padding: '1px 6px',
      boxShadow: 'inset 0 0 0 1px rgba(14,155,102,0.22)',
    },
    '.dd-img': {
      maxHeight: '28rem',
      maxWidth: '100%',
      borderRadius: '6px',
      verticalAlign: 'middle',
      margin: '2px 0',
    },
    '.dd-img-chip': {
      color: 'var(--color-ink-3)',
      background: 'var(--color-surface-2)',
      borderRadius: '4px',
      padding: '1px 6px',
      fontSize: '12px',
    },
    // 代码围栏：围栏符号压暗、里面按等宽整行铺底色（行级装饰才能铺满整行）
    '.dd-fence': { color: 'var(--color-ink-3)', opacity: '0.5', fontSize: '13px' },
    '.dd-code-line': {
      fontFamily: 'var(--font-mono)',
      fontSize: '13px',
      lineHeight: '1.7',
      color: 'var(--color-green-deep)',
      background: 'var(--color-surface-2)',
    },

    // 记号
    '.dd-mark': { color: 'rgba(139,154,147,0.55)' },

    // 渲染出来的样子
    '.dd-strong': { fontWeight: '600', color: 'var(--color-ink)' },
    '.dd-em': { fontStyle: 'italic' },
    '.dd-code': {
      fontFamily: 'var(--font-mono)',
      fontSize: '13px',
      color: 'var(--color-green-deep)',
      background: 'var(--color-surface-2)',
      borderRadius: '3px',
      padding: '1px 3px',
    },
    '.dd-wiki': {
      color: 'var(--color-green-deep)',
      background: 'var(--color-green-soft)',
      borderRadius: '999px',
      padding: '1px 6px',
      boxShadow: 'inset 0 0 0 1px rgba(14,155,102,0.22)',
    },
    '.dd-tag': {
      color: 'var(--color-green)',
      background: 'var(--color-green-soft)',
      borderRadius: '3px',
      padding: '1px 4px',
    },
    // 原代码模式里标签只染色、不做药丸 —— "不渲染"就得真的不渲染
    '.dd-tag-raw': { color: 'var(--color-green)' },

    // 行级
    '.dd-h1': { fontSize: '28px', fontWeight: '600', lineHeight: '1.24', letterSpacing: '-0.024em', paddingTop: '8px' },
    '.dd-h2': {
      fontSize: '20px',
      fontWeight: '600',
      lineHeight: '1.35',
      letterSpacing: '-0.012em',
      paddingTop: '32px',
      paddingBottom: '4px',
    },
    '.dd-h3': { fontSize: '16.5px', fontWeight: '600', lineHeight: '1.45', paddingTop: '24px' },
    '.dd-quote': {
      borderLeft: '3px solid rgba(14,155,102,0.35)',
      paddingLeft: '16px',
      color: 'var(--color-ink-2)',
    },
  },
  { dark: false },
)

/* ── 块级渲染 ────────────────────────────────────────────────────────
 *
 * 编写模式不再是"用行样式假装渲染"。做法是：**不在光标所在的那个块**，
 * 整块换成渲染后的 DOM；光标所在的那个块才显示源码。
 *
 * 好处是阅读和编写用的是**同一个 BlockView 组件** —— 两边长得一样是构造出来的，
 * 不是靠两套 CSS 对齐出来的。
 */

type Span = { from: number; to: number }

/** 行内记号：正则、套在里面的样式、开闭各占几个字符 */
const INLINE: { re: RegExp; cls: string; open: number; close: number }[] = [
  { re: /\[\[([^\]\n]+)\]\]/g, cls: 'dd-wiki', open: 2, close: 2 },
  { re: /`([^`\n]+)`/g, cls: 'dd-code', open: 1, close: 1 },
  /*
   * 前后都要断言：`**粗体**、*斜体*` 这种连在一起时，
   * 斜体的正则会从粗体的收尾 `*` 开始，凑成 `*、*` 把斜体的开头 `*` 吃掉，
   * 结果正文里漏一个 `*`。加 lookaround 之后各认各的。
   */
  { re: /(?<!\*)\*\*([^*\n]+)\*\*(?!\*)/g, cls: 'dd-strong', open: 2, close: 2 },
  { re: /(?<!\*)\*([^*\n]+)\*(?!\*)/g, cls: 'dd-em', open: 1, close: 1 },
  { re: /(?<!\~)~~([^~\n]+)~~(?!\~)/g, cls: 'dd-strike', open: 2, close: 2 },
]

const TAGS = /#[\p{L}\p{N}_/-]+/gu

/** Decoration 是不可变对象，按 class 缓存一份，别每次重建 */
const MARK_CACHE = new Map<string, Decoration>()
function mark(cls: string): Decoration {
  let d = MARK_CACHE.get(cls)
  if (!d) {
    d = Decoration.mark({ class: cls })
    MARK_CACHE.set(cls, d)
  }
  return d
}



const DIM = mark('dd-mark')
const HIDE = Decoration.replace({})

class Bullet extends WidgetType {
  override eq() {
    return true
  }
  override toDOM() {
    const el = document.createElement('span')
    el.className = 'dd-bullet'
    el.textContent = '•'
    return el
  }
}
const BULLET = Decoration.replace({ widget: new Bullet() })

/** 有序列表的序号：`3.` 换成一个等宽数字（不重新编号，源码是几就是几） */
class Num extends WidgetType {
  constructor(private readonly n: number) {
    super()
  }
  override eq(other: Num) {
    return other.n === this.n
  }
  override toDOM() {
    const el = document.createElement('span')
    el.className = 'dd-num'
    el.textContent = `${this.n}.`
    return el
  }
}

/** 任务框：`- [ ]` / `- [x]` 换成的小方框。点它直接改文档里的那个字符 */
class Check extends WidgetType {
  constructor(
    private readonly on: boolean,
    /** `[` 和 `]` 之间那个字符在文档里的位置（空格或 x） */
    private readonly at: number,
  ) {
    super()
  }
  override eq(other: Check) {
    return other.on === this.on && other.at === this.at
  }
  override toDOM() {
    const el = document.createElement('span')
    el.className = this.on ? 'dd-check dd-check-on' : 'dd-check'
    el.setAttribute('role', 'checkbox')
    el.setAttribute('aria-checked', this.on ? 'true' : 'false')
    el.title = this.on ? '点一下取消' : '点一下勾上'
    if (this.on) {
      el.innerHTML =
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5"/></svg>'
    }

    // 别让点击把光标塞进 widget 里；点一下就把 `[ ]` / `[x]` 改掉
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    el.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const view = EditorView.findFromDOM(el)
      if (!view) return
      view.dispatch({ changes: { from: this.at, to: this.at + 1, insert: this.on ? ' ' : 'x' } })
    })

    return el
  }
}

/**
 * 行内公式：$x$ 直接渲染成 KaTeX。
 *
 * ⚠️ 这个 widget **必须可点**。CM6 的 `WidgetType.ignoreEvent()` 默认返回 true，
 *    意思是"组件里发生的鼠标事件，编辑器一概不处理" —— 于是点在渲染出来的公式上
 *    光标不动，公式永远不还原成源码，人就没法改它（用户的原话：无法交互）。
 *    所以这里自己接管 mousedown：把光标送进公式范围，StateField 收到 selection
 *    变化后会重建装饰，源码随即露出来。
 */
class MathWidget extends WidgetType {
  constructor(
    private readonly tex: string,
    /** 公式在文档里的起始偏移（含开头的 $） */
    private readonly at: number,
    /** 开头定界符长度：`$…$` 是 1，`$$…$$` 是 2 */
    private readonly open: number,
  ) {
    super()
  }
  override eq(other: MathWidget) {
    return other.tex === this.tex && other.at === this.at && other.open === this.open
  }
  override toDOM() {
    const el = document.createElement('span')
    el.className = 'dd-math'
    el.title = '点一下编辑公式'
    const root = createRoot(el)
    root.render(<MathView tex={this.tex} />)
    ;(el as DomWithRoot).__root = root

    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const view = EditorView.findFromDOM(el)
      if (!view) return
      /*
       * 落点按点击的左右半边定：
       *   点左半 → 公式开头（想改第一个符号）
       *   点右半 → 公式末尾（想接着写）
       * KaTeX 的排版和源码位置对不上，做不了"精确到字符"，但两档已经比
       * 永远跳开头自然得多。
       */
      const box = el.getBoundingClientRect()
      const right = e.clientX > box.left + box.width / 2
      const anchor = right ? this.at + this.open + this.tex.length : this.at + this.open
      view.dispatch({ selection: { anchor }, scrollIntoView: true })
      view.focus()
    })

    return el
  }
  override destroy(el: HTMLElement) {
    const root = (el as DomWithRoot).__root
    if (!root) return
    queueMicrotask(() => root.unmount())
  }
}

/** 行内图片：仓库里的图片读到 Blob URL 后直接画出来 */
class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
  ) {
    super()
  }
  override eq(other: ImageWidget) {
    return other.src === this.src
  }
  override toDOM() {
    const url = resolveImage(this.src)
    if (!url) {
      const chip = document.createElement('span')
      chip.className = 'dd-img-chip'
      chip.textContent = `▧ ${this.alt || this.src}`
      return chip
    }
    const img = document.createElement('img')
    img.src = url
    img.alt = this.alt
    img.className = 'dd-img'
    return img
  }
}

const IMAGE_INLINE = /!\[([^\]]*)\]\(([^)\n]+)\)/g
/** 标准链接 `[文字](路径)`：编写模式里只显示文字，地址藏起来 */
const LINK_INLINE = /\[([^\]]+)\]\(([^)\n]+)\)/g

/** 代码块开头那行：把 ```ts 换成一个语言小标签 */
class FenceLabel extends WidgetType {
  constructor(private readonly lang: string) {
    super()
  }
  override eq(other: FenceLabel) {
    return other.lang === this.lang
  }
  override toDOM() {
    const el = document.createElement('span')
    el.className = 'dd-fence-label'
    el.textContent = this.lang || '代码'
    return el
  }
}

/** 空 widget：把 ``` 那行变成零宽（行还在，但看不见东西） */
class Nothing extends WidgetType {
  override eq() {
    return true
  }
  override toDOM() {
    const el = document.createElement('span')
    el.className = 'dd-nothing'
    return el
  }
}
const NOTHING = Decoration.replace({ widget: new Nothing() })

/**
 * 点块级 widget 时交给外面处理（表格 → 打开网格编辑器；公式/HTML → 光标进块）。
 *
 * ⚠️ 只有表格 / 公式 / HTML 这三类块会被换成 widget —— 它们本来就不是"一行字"，
 *    没法用文字装饰表示。其余（标题/段落/列表/引用/代码）**全是真的文本**，
 *    所以拖选、点选、正常编辑都不受影响。
 */
export const BLOCK_CLICK = new WeakMap<EditorView, (from: number, to: number, kind: string) => void>()

type DomWithRoot = HTMLElement & { __root?: Root }

class BlockWidget extends WidgetType {
  private readonly key: string

  constructor(
    private readonly block: Block,
    private readonly from: number,
    private readonly to: number,
  ) {
    super()
    this.key = JSON.stringify(block)
  }

  override eq(other: BlockWidget) {
    return other.key === this.key
  }

  override toDOM() {
    const dom = document.createElement('div')
    dom.className = 'dd-block dd-block-' + this.block.t
    const root = createRoot(dom)
    root.render(<BlockView b={this.block} />)
    ;(dom as DomWithRoot).__root = root

    dom.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      /*
       * 只有**双击**才进编辑。单击必须留给"放光标 / 拖选"，
       * 否则滚一下滚动条、点一下正文就弹出编辑器，非常烦。
       * mousedown 的 detail 就是连击数：第二下才是 2。
       */
      /*
       * preventDefault 必须无条件做：否则第一下单击就会把光标放进块里，
       * 块随即被还原成源码 —— 第二下就再也点不到它了，双击永远等不到。
       */
      e.preventDefault()
      // 只有双击（第二下 detail=2）才进编辑
      if (e.detail < 2) return
      const view = EditorView.findFromDOM(dom)
      if (!view) return
      BLOCK_CLICK.get(view)?.(this.from, this.to, this.block.t)
    })

    return dom
  }

  override destroy(dom: HTMLElement) {
    const root = (dom as DomWithRoot).__root
    if (!root) return
    queueMicrotask(() => root.unmount())
  }
}

/** 一行普通文字的所有装饰（标题、引用、列表、行内记号、标签） */
function decorateLine(
  out: Range<Decoration>[],
  doc: Text,
  n: number,
  head: number,
) {
  const line = doc.line(n)
  const text = line.text
  const lineRaw = n === doc.lineAt(head).number
  const inElement = (from: number, to: number) => head >= from && head <= to

  const heading = /^(#{1,6})\s+/.exec(text)
  if (heading) {
    const level = Math.min(heading[1]?.length ?? 1, 4)
    out.push(Decoration.line({ class: `dd-h${level}` }).range(line.from))
    const end = line.from + heading[0].length
    out.push((lineRaw ? DIM : HIDE).range(line.from, end))
  }

  const quote = /^(?:\s*>\s?)+/.exec(text)
  if (quote && !heading) {
    out.push(Decoration.line({ class: 'dd-quote' }).range(line.from))
    const end = line.from + quote[0].length
    out.push((lineRaw ? DIM : HIDE).range(line.from, end))
  }

  /*
   * 列表记号整段换掉：任务项 → 方框，有序 → 等宽序号，无序 → 圆点。
   * 光标所在行不换，只压灰 —— 想改勾态/序号的时候它就在那儿。
   * 顺序：任务项最先（它的前缀也符合有序/无序的写法）。
   */
  const task = heading || quote ? null : /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]\s+/.exec(text)
  const ol = heading || quote ? null : /^(\s*)(\d{1,9})[.)]\s+/.exec(text)
  const ul = heading || quote ? null : /^(\s*)([-*+])\s+/.exec(text)
  if (task) {
    const end = line.from + task[0].length
    if (lineRaw) {
      out.push(DIM.range(line.from, end))
    } else {
      // `[` 后面那个字符（空格/x）在文档里的位置 —— 点方框就改它
      const open = task[0].indexOf('[')
      const markAt = line.from + (open >= 0 ? open + 1 : task[0].length - 2)
      const on = (task[2] ?? ' ').toLowerCase() === 'x'
      out.push(Decoration.replace({ widget: new Check(on, markAt) }).range(line.from, end))
    }
  } else if (ol) {
    const start = line.from + (ol[1]?.length ?? 0)
    const end = line.from + ol[0].length
    out.push(lineRaw ? DIM.range(start, end) : Decoration.replace({ widget: new Num(Number(ol[2] ?? 1)) }).range(start, end))
  } else if (ul) {
    const start = line.from + (ul[1]?.length ?? 0)
    const end = line.from + ul[0].length
    out.push(lineRaw ? DIM.range(start, end) : BULLET.range(start, end))
  }

  const claimed: Span[] = []

  /*
   * 藏记号（`**` / `*` / `~~` / 围栏）必须去重：CodeMirror 的 replace 装饰**范围不能重叠**，
   * 比如 `**粗体**` 里，斜体的正则会把粗体的 `*` 也当成自己的记号，
   * 两段 replace 一叠，其中一段会被丢掉，结果就是正文里漏出一个 `*`。
   */
  const hidden: Span[] = []
  const hideRange = (from: number, to: number, dim: boolean) => {
    if (from >= to) return
    if (dim) {
      out.push(DIM.range(from, to))
      return
    }
    if (hidden.some((c) => from < c.to && c.from < to)) return
    hidden.push({ from, to })
    out.push(HIDE.range(from, to))
  }

  /*
   * ⚠️ 顺序很重要：**图片要在链接之前**。
   * `![图](路径)` 里的 `[图](路径)` 完全符合链接的写法，链接先跑就会把它抢走，
   * 于是只显示一个绿色下划线的"图"，前面还留下一个孤零零的 `!`。
   */
  for (const m of text.matchAll(IMAGE_INLINE)) {
    const at = m.index ?? 0
    const end = at + m[0].length
    if (claimed.some((c) => at < c.to && c.from < end)) continue
    claimed.push({ from: at, to: end })
    out.push(
      Decoration.replace({
        widget: new ImageWidget((m[2] ?? '').trim(), m[1] ?? ''),
      }).range(line.from + at, line.from + end),
    )
  }

  // 标准链接：只留文字，`[` 和 `](地址)` 藏起来（光标进去才露）
  for (const m of text.matchAll(LINK_INLINE)) {
    const at = m.index ?? 0
    // 前面是 `!` 的说明它是图片，已经处理过了
    if (at > 0 && text[at - 1] === '!') continue
    const end = at + m[0].length
    if (claimed.some((c) => at < c.to && c.from < end)) continue
    claimed.push({ from: at, to: end })

    const innerFrom = at + 1
    const innerTo = innerFrom + (m[1] ?? '').length
    const absFrom = line.from + at
    const absTo = line.from + end
    const here = inElement(absFrom, absTo)

    out.push(mark('dd-link').range(line.from + innerFrom, line.from + innerTo))
    hideRange(absFrom, line.from + innerFrom, here)
    hideRange(line.from + innerTo, absTo, here)
  }



  /*
   * 裸 URL：只染色、不藏字。`[文字](地址)` 里的地址已被上面认领，不会重复染色。
   * 尾巴上的标点不算 URL 的一部分（和解析器同一把尺子）。
   */
  for (const m of text.matchAll(/https?:\/\/[^\s<>]+/g)) {
    const at = m.index ?? 0
    const clean = trimUrlTail(m[0])
    const end = at + clean.length
    if (end <= at) continue
    if (claimed.some((c) => at < c.to && c.from < end)) continue
    claimed.push({ from: at, to: end })
    out.push(mark('dd-link').range(line.from + at, line.from + end))
  }

  /*
   * $$…$$ 必须比单个 $ 先认领。
   * 否则 `公式：$$\int_a^b f(x)dx$$` 会被单个 $ 的正则从第二个 $ 开始匹配，
   * 屏幕上就真的出现两个美元符号（这个坑用户截图指出过）。
   */
  for (const m of text.matchAll(/\$\$([^$\n]+?)\$\$/g)) {
    const at = m.index ?? 0
    const end = at + m[0].length
    if (claimed.some((c) => at < c.to && c.from < end)) continue
    claimed.push({ from: at, to: end })
    const absFrom = line.from + at
    const absTo = line.from + end
    out.push(
      inElement(absFrom, absTo)
        ? mark('dd-math-raw').range(absFrom, absTo)
        : Decoration.replace({ widget: new MathWidget(m[1] ?? "", absFrom, 2) }).range(absFrom, absTo),
    )
  }

  // $行内公式$：光标不在里面就渲染成公式，在里面就露源码
  // 守卫和解析器一致：$ 前后不能贴空白，否则"省 $5 到 $10"会被当成公式
  for (const m of text.matchAll(/\$([^\s$](?:[^$\n]*[^\s$])?)\$/g)) {
    const at = m.index ?? 0
    const end = at + m[0].length
    if (claimed.some((c) => at < c.to && c.from < end)) continue
    claimed.push({ from: at, to: end })
    const absFrom = line.from + at
    const absTo = line.from + end
    out.push(
      inElement(absFrom, absTo)
        ? mark('dd-math-raw').range(absFrom, absTo)
        : Decoration.replace({ widget: new MathWidget(m[1] ?? "", absFrom, 1) }).range(absFrom, absTo),
    )
  }

  for (const { re, cls, open, close } of INLINE) {
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0
      const end = at + m[0].length
      const inner = { from: at + open, to: end - close }
      if (inner.to <= inner.from) continue

      /*
       * 记号（`**` / `\`` / `~~`）本身几乎不会和别人冲突，**先无脑藏掉**；
       * 只有"内部文字"被别人认领（比如 `**\`代码\`**` 里的行内码）时才跳过加样式。
       * 以前是一检测到重叠就整段跳过，结果 `**` 原样露在正文里。
       */
      const absFrom = line.from + at
      const absTo = line.from + end
      const here = inElement(absFrom, absTo)

      const innerTaken = claimed.some((c) => inner.from < c.to && c.from < inner.to)
      if (!innerTaken) {
        claimed.push(inner)
        out.push(mark(cls).range(line.from + inner.from, line.from + inner.to))
      }
      if (open > 0) hideRange(absFrom, line.from + inner.from, here)
      if (close > 0) hideRange(line.from + inner.to, absTo, here)
    }
  }

  for (const m of text.matchAll(TAGS)) {
    const at = m.index ?? 0
    const span = { from: at, to: at + m[0].length }
    if (claimed.some((c) => span.from < c.to && c.from < span.to)) continue
    claimed.push(span)
    out.push(mark('dd-tag').range(line.from + span.from, line.from + span.to))
  }
}

/**
 * 编写模式的装饰。
 *
 * 分三类处理：
 *   ① 表格 / 公式 / HTML —— 换成**块 widget**（它们不是"一行字"）
 *   ② 代码围栏 —— 围栏行换成语言标签或隐藏，代码行等宽铺底色，里面不解析行内记号
 *   ③ 其余 —— 全是真的文本，只加行内/行级装饰（拖选、点选完全正常）
 */
/** 图片是异步读进来的：读完之后要让编辑器重算一次装饰，否则 widget 永远停在占位 */
const refreshDecos = StateEffect.define<null>()

function buildDecos(state: EditorState, live: boolean): DecorationSet {
  if (!live) return Decoration.none

  const doc = state.doc
  const blocks = parseMarkdown(doc.toString())
  const out: Range<Decoration>[] = []

  const head = state.selection.main.head
  const cursorLine = doc.lineAt(head).number
  const sel = state.selection.main
  /** 选区压在这段范围上就不能换成 widget —— CM6 明确禁止替换选区 */
  const overlaps = (from: number, to: number) => sel.from < to && sel.to > from

  for (const b of blocks) {
    /*
     * 行号夹在文档范围内。解析器给了界外的行号时（比如没收尾的 $$），
     * doc.line() 会抛 RangeError，而这是在事务里抛 —— 用户看到的是"这一次按键没反应"，
     * 连报错都没有。宁可少画一个装饰，也不能让编辑器停摆。
     */
    const fromLine = Math.min(Math.max(1, b.from), doc.lines)
    const toLine = Math.min(Math.max(fromLine, b.to), doc.lines)
    const fromPos = doc.line(fromLine).from
    const toPos = doc.line(toLine).to
    const active = (cursorLine >= b.from && cursorLine <= b.to) || overlaps(fromPos, toPos)

    // ① 不是"一行字"的块：换 widget；光标在里面时显示源码
    //   表格 / 公式 / 分割线 —— 分割行也换，否则 `---` 会傻傻地以原文样子杵在正文里
    /*
     * 没闭合的块公式：只露源码，不换 widget。
     * 它此时会一路吃到文档末尾，换成 widget 等于把后面整篇藏起来 ——
     * 写一半的公式本来就是"半成品"，让它老实显示比装作渲染好。
     */
    if (b.t === 'mathblock' && b.closed === false) {
      for (let n = b.from; n <= b.to; n++) decorateLine(out, doc, n, head)
      continue
    }

    if (b.t === 'table' || b.t === 'mathblock' || b.t === 'hr') {
      if (!active) {
        out.push(
          Decoration.replace({
            block: true,
            widget: new BlockWidget(b, fromPos, toPos),
          }).range(fromPos, toPos),
        )
      } else {
        for (let n = b.from; n <= b.to; n++) decorateLine(out, doc, n, head)
      }
      continue
    }

    // ② 代码块：围栏行收起来，代码行等宽
    if (b.t === 'code') {
      const opening = b.from
      const closing = b.to > b.from ? b.to : -1

      for (let n = b.from; n <= b.to; n++) {
        const line = doc.line(n)
        const onEdge = n === opening || n === closing
        if (onEdge && n !== cursorLine) {
          out.push(
            (n === opening
              ? Decoration.replace({ widget: new FenceLabel(b.lang) })
              : NOTHING
            ).range(line.from, line.to),
          )
          continue
        }
        if (onEdge) {
          out.push(DIM.range(line.from, line.to))
          continue
        }
        out.push(Decoration.line({ class: 'dd-code-line' }).range(line.from))
      }
      continue
    }

    // ③ 普通文本块
    for (let n = b.from; n <= b.to; n++) decorateLine(out, doc, n, head)
  }

  return Decoration.set(out, true)
}

function decos(live: boolean) {
  return StateField.define<DecorationSet>({
    create: (state) => buildDecos(state, live),
    update(deco, tr) {
      const forced = tr.effects.some((e) => e.is(refreshDecos))
      if (!tr.docChanged && !tr.selection && !forced) return deco
      return buildDecos(tr.state, live)
    },
    provide: (f) => EditorView.decorations.from(f),
  })
}

/** 光标所在位置的上下文，工具栏据此改变自己（比如"编辑表格"按钮） */
export type EditorContext = { inTable: boolean; heading: number | null }


type Props = {
  /** 换文件时改它 —— 光标与撤销历史跟着一起换 */
  docKey: string
  value: string
  /** true = 实时预览（编写）；false = 原代码 */
  live: boolean
  onChange: (text: string) => void
  /** 光标上下文变了（进/出表格、标题级别） */
  onContext: (ctx: EditorContext) => void
  /** 点了渲染出来的表格（用网格编辑器打开） */
  onOpenTable: (from: number, to: number) => void
  /** 点了渲染出来的块公式（用弹窗编辑） */
  onOpenMath?: (from: number, to: number) => void
  /** 双击双链 / 链接时跳过去 */
  onJump?: (target: string, kind: 'wiki' | 'path' | 'url') => void
  /** `[[` 提示要的清单：每篇带可选的小节 */
  linkTargets?: { path: string; title: string; headings: string[] }[]
  /** 编辑辅助：hints 才浮符号条；plain 什么都不弹 */
  assist?: 'hints' | 'plain'
  /** 符号条上的「更多」：交给外层开公式弹窗 */
  onMoreMath?: () => void
  /** 给外面的格式化工具条用 */
  ref?: Ref<EditorHandle>
}

/** 文档顶部那排按钮通过它来动光标/选区 */
export type EditorHandle = {
  wrap: (before: string, after: string, placeholder: string) => void
  linePrefix: (prefix: string) => void
  /** 原地插入一段（表格骨架这类多行东西） */
  insert: (text: string) => void
  /** 把当前行设成某一级标题（null = 正文） */
  setHeading: (level: number | null) => void
  /** 光标所在的那张表；不在表格里返回 null。align 按列，保存时原样写回 */
  tableAtCursor: () => { from: number; to: number; cells: string[][]; align: Align[] } | null
  /** 让编辑器重算一次装饰（图片读完之后要用） */
  refresh: () => void
  /** 用新文本替换一段范围 */
  replaceRange: (from: number, to: number, text: string) => void
}

/** 把当前行设成某一级标题；传 null 就是去掉标题 */
function applyHeading(view: EditorView, level: number | null) {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.from)
  const had = /^#{1,6}\s+/.exec(line.text)
  const next = level === null ? "" : "#".repeat(level) + " "
  const from = line.from
  const to = line.from + (had ? had[0].length : 0)
  if (had && had[0] === next) return

  // 光标在同一行里：前缀长度变了要跟着挪
  const offset = Math.max(0, sel.head - to)
  view.dispatch({
    changes: { from, to, insert: next },
    selection: { anchor: from + next.length + offset },
    scrollIntoView: true,
  })
  view.focus()
}

/** 在光标处插入，插完光标落到插入内容之后 */
function insertText(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  })
  view.focus()
}

/** 把选中内容用记号包起来；没选就插一段占位并选中它，方便直接替换 */
function wrapSelection(view: EditorView, before: string, after: string, placeholder: string) {
  const { from, to } = view.state.selection.main
  const sel = view.state.sliceDoc(from, to)
  const body = sel || placeholder
  view.dispatch({
    changes: { from, to, insert: `${before}${body}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + body.length },
    scrollIntoView: true,
  })
  view.focus()
}

/** 给选中行加/去前缀（标题、列表、引用）。
 *
 * 两个坑都在这函数里踩过：
 *   ① 标题不能盲目加前缀 —— `# 标题` 上再加 `## ` 会变成 `## # 标题`（看起来像两个 ##）。
 *      所以先剥掉已有的 `#{1,6} `，再按目标级别重写；已经是这个级别就整段去掉（开关）。
 *   ② `dispatch` 的默认选区映射会把光标留在插入点**之前**，于是点完 H 光标停在 `##` 前面。
 *      单光标时自己算偏移，把光标挪到前缀后面。
 */
function toggleLinePrefix(view: EditorView, prefix: string) {
  const sel = view.state.selection.main
  const first = view.state.doc.lineAt(sel.from).number
  const last = view.state.doc.lineAt(sel.to).number

  const isHeading = prefix.startsWith('#')
  const HEAD = /^#{1,6}\s+/

  const lines = []
  for (let n = first; n <= last; n++) lines.push(view.state.doc.line(n))

  // 按准确级别判断：`# 标题` 上点 H 要变成 `## 标题`，不是被当成已是标题而删掉
  const marked = (t: string) => t.startsWith(prefix)
  const all = lines.every((l) => marked(l.text))

  type Ch = { from: number; to: number; insert: string }
  const changes: Ch[] = []
  let delta = 0
  let total = 0

  for (const l of lines) {
    const m = isHeading ? HEAD.exec(l.text) : null

    if (all) {
      const len = isHeading ? (m ? m[0].length : 0) : prefix.length
      if (len === 0) continue
      changes.push({ from: l.from, to: l.from + len, insert: '' })
      total -= len
      if (l.number === first) delta -= Math.min(len, Math.max(0, sel.head - l.from))
    } else if (m) {
      changes.push({ from: l.from, to: l.from + m[0].length, insert: prefix })
      total += prefix.length - m[0].length
      if (l.number === first) delta += prefix.length - m[0].length
    } else {
      changes.push({ from: l.from, to: l.from, insert: prefix })
      total += prefix.length
      if (l.number === first) delta += prefix.length
    }
  }

  if (changes.length === 0) return

  // 单光标时显式给位置；多行选区交给 CM 自己映射
  if (sel.from === sel.to) {
    const limit = view.state.doc.length + total
    const head = Math.max(0, Math.min(limit, sel.head + delta))
    view.dispatch({ changes, selection: { anchor: head }, scrollIntoView: true })
  } else {
    view.dispatch({ changes, scrollIntoView: true })
  }

  view.focus()
}

/** 行内公式符号条上的常客：够用就好，剩下靠「更多」 */
const HINT_ITEMS = [
  { t: '\\pm', l: '±' },
  { t: '\\times', l: '×' },
  { t: '\\div', l: '÷' },
  { t: '\\sqrt{$0}', l: '√' },
  { t: '\\sum_{$0}^{}', l: '∑' },
  { t: '\\int_{$0}^{}', l: '∫' },
  { t: '\\approx', l: '≈' },
  { t: '\\leq', l: '≤' },
  { t: '\\geq', l: '≥' },
  { t: '\\pi', l: 'π' },
]

export function CodeEditor({
  docKey,
  value,
  live,
  onChange,
  onContext,
  onOpenTable,
  onOpenMath,
  onJump,
  linkTargets,
  assist = 'hints',
  onMoreMath,
  ref,
}: Props) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const emit = useRef(onChange)
  const emitCtx = useRef(onContext)
  const onTableClick = useRef(onOpenTable)
  const onMathClick = useRef(onOpenMath)
  const jump = useRef(onJump)
  const targets = useRef(linkTargets ?? [])
  const slot = useRef(new Compartment())
  /** 行内公式的符号条：只在 assist=hints 且光标在 $…$ 里时出现 */
  const [hint, setHint] = useState<{ x: number; y: number } | null>(null)
  const assistRef = useRef(assist)
  const moreMath = useRef(onMoreMath)

  /** 符号条上点一下：插进光标处（`$0` 标记插完光标的位置） */
  function insertSnippet(snippet: string) {
    const v = view.current
    if (!v) return
    const cut = snippet.indexOf('$0')
    const text = cut < 0 ? snippet : snippet.slice(0, cut) + snippet.slice(cut + 2)
    const pos = v.state.selection.main.head
    v.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + (cut < 0 ? text.length : cut) },
    })
    v.focus()
  }



  useImperativeHandle(
    ref,
    () => ({
      wrap: (before, after, placeholder) => {
        const v = view.current
        if (v) wrapSelection(v, before, after, placeholder)
      },
      linePrefix: (prefix) => {
        const v = view.current
        if (v) toggleLinePrefix(v, prefix)
      },
      insert: (text) => {
        const v = view.current
        if (v) insertText(v, text)
      },
      setHeading: (level) => {
        const v = view.current
        if (v) applyHeading(v, level)
      },
      tableAtCursor: () => {
        const v = view.current
        if (!v) return null
        const find = tableAt(v.state.doc.toString().split("\n"), v.state.doc.lineAt(v.state.selection.main.head).number)
        if (!find) return null
        return {
          from: v.state.doc.line(find.fromLine).from,
          to: v.state.doc.line(find.toLine).to,
          cells: find.cells,
          align: find.align,
        }
      },
      refresh: () => {
        view.current?.dispatch({ effects: refreshDecos.of(null) })
      },
      replaceRange: (from, to, text) => {
        const v = view.current
        if (!v) return
        v.dispatch({ changes: { from, to, insert: text } })
        v.focus()
      },

    }),
    [],
  )

  useEffect(() => {
    emit.current = onChange
    emitCtx.current = onContext
    onTableClick.current = onOpenTable
    onMathClick.current = onOpenMath
    jump.current = onJump
    targets.current = linkTargets ?? []
    assistRef.current = assist
    moreMath.current = onMoreMath
  }, [onChange, onContext, onOpenTable, onOpenMath, onJump, linkTargets, assist, onMoreMath])

  // 只在换文件时重建
  useEffect(() => {
    const el = host.current
    if (!el) return


    /** 光标进 `$…$` 就浮一条符号；plain 模式完全不出现 */
    const syncHint = (v2: EditorView) => {
      if (assistRef.current !== 'hints') {
        setHint(null)
        return
      }
      const pos = v2.state.selection.main.head
      const ctx = mathContextAt(v2.state.doc.toString(), pos)
      const el = host.current
      if (!ctx || ctx.kind !== 'inline' || !el) {
        setHint(null)
        return
      }
      const c = v2.coordsAtPos(pos)
      if (!c) {
        setHint(null)
        return
      }
      const box = el.getBoundingClientRect()
      setHint({
        x: Math.min(c.left - box.left, Math.max(0, box.width - 320)),
        y: Math.max(0, c.top - box.top - 38),
      })
    }

    const v = new EditorView({
      parent: el,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown(),
          syntaxHighlighting(hl),
          slot.current.of(decos(live)),
          theme,
          keymap.of([...defaultKeymap, ...historyKeymap]),
          /*
           * 编辑模式里跳转有两把钥匙：
           *   · 双击 —— 手不用离开鼠标
           *   · Ctrl/⌘ + 单击 —— 编辑器里的通行做法，尤其是习惯了的人
           * 单击本身不能跳：那一步是"放光标"。
           */
          EditorView.domEventHandlers({
            click: (e, v2) => {
              if (!(e.ctrlKey || e.metaKey)) return false
              const pos = v2.posAtCoords({ x: e.clientX, y: e.clientY })
              if (pos == null) return false
              const hit = linkAt(v2.state.doc.toString(), pos)
              if (!hit) return false
              e.preventDefault()
              jump.current?.(hit.target, hit.kind)
              return true
            },
            dblclick: (e, v2) => {
              const pos = v2.posAtCoords({ x: e.clientX, y: e.clientY })
              if (pos == null) return false
              const hit = linkAt(v2.state.doc.toString(), pos)
              if (!hit) return false
              e.preventDefault()
              jump.current?.(hit.target, hit.kind)
              return true
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) emit.current(u.state.doc.toString())
            if (!(u.docChanged || u.selectionSet || u.focusChanged)) return

            // 光标上下文：在不在表格里、当前行是几级标题 —— 工具栏据此换开关
            const st = u.state
            const line = st.doc.lineAt(st.selection.main.head)
            const h = /^(#{1,6})\s+/.exec(line.text)
            const inTable = Boolean(tableAt(st.doc.toString().split("\n"), line.number))

            emitCtx.current({ inTable, heading: h ? (h[1] ?? "").length : null })
            syncHint(u.view)
          }),
        ],
      }),
    })

    view.current = v

    // 点渲染出来的块：表格开网格编辑器，公式/HTML 把光标放进块里显示源码
    BLOCK_CLICK.set(v, (from, to, kind) => {
      if (kind === 'table') {
        onTableClick.current?.(from, to)
        return
      }
      // 块公式：交给外层弹窗编辑，不在正文里改
      if (kind === 'mathblock') {
        onMathClick.current?.(from, to)
        return
      }
      v.dispatch({ selection: { anchor: from }, scrollIntoView: true })
      v.focus()
    })

    // DEV-only：把编辑器实例挂出去，验收脚本才能"把光标放到某处"再断言渲染结果
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>
      w.__dd_view = v
    }

    return () => {
      if (import.meta.env.DEV) {
        const w = window as unknown as Record<string, unknown>
        w.__dd_view = null
      }
      v.destroy()
      view.current = null
    }
    // value / live 故意不进依赖：它们变了不该重建编辑器（会丢光标）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  // 切模式：只换 decoration，不动文档、不动光标
  useEffect(() => {
    view.current?.dispatch({ effects: slot.current.reconfigure(decos(live)) })
  }, [live])

  // 外部改了内容（换了篇）时同步；一致时什么都不做
  useEffect(() => {
    const v = view.current
    if (!v) return
    const now = v.state.doc.toString()
    if (now === value) return
    v.dispatch({ changes: { from: 0, to: now.length, insert: value } })
  }, [value])

  return (
    <div className="relative h-full">
      <div ref={host} className="h-full" />
      {hint ? (
        <div
          data-dd-math-hint
          className="absolute z-30 flex h-8 items-center gap-0.5 rounded-lg border border-line bg-surface px-1 shadow-[0_10px_26px_-10px_rgba(16,35,28,0.3)]"
          style={{ left: hint.x, top: hint.y }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {HINT_ITEMS.map((it) => (
            <button
              key={it.t}
              type="button"
              title={it.t}
              onClick={() => insertSnippet(it.t)}
              className="grid size-7 cursor-pointer place-items-center rounded-md text-[14px] leading-none text-ink hover:bg-surface-2 active:bg-green-soft"
            >
              {it.l}
            </button>
          ))}
          <button
            type="button"
            onClick={() => moreMath.current?.()}
            className="ml-0.5 h-7 cursor-pointer rounded-md px-2 text-[11.5px] text-green-deep hover:bg-green-soft"
          >
            更多
          </button>
        </div>
      ) : null}
    </div>
  )
}