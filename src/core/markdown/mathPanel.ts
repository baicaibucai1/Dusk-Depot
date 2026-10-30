/*
 * 公式快速面板的**数据**和**判定**，两样都是纯函数，跑在 node 里能单测。
 *
 * 为什么面板只在"光标真的在公式里"时出现：
 * 这个面板一出现就盖住正文，如果一直挂着就是噪音。判定的边界要准 ——
 * 宁可少弹（用户点一下 `$` 就补上），也不要动不动糊在屏幕中间。
 */

export type MathItem = {
  /** 插进文档的 LaTeX。`$0` 表示插完光标停在哪 */
  tex: string
  /** 面板上显示的字（通常就是符号本身） */
  label: string
  /** 悬停提示，说明它是什么 */
  hint?: string
}

export type MathGroup = { id: string; title: string; items: MathItem[] }

/** 希腊字母 */
const GREEK: MathItem[] = [
  { tex: '\\alpha', label: 'α' },
  { tex: '\\beta', label: 'β' },
  { tex: '\\gamma', label: 'γ' },
  { tex: '\\delta', label: 'δ' },
  { tex: '\\epsilon', label: 'ε' },
  { tex: '\\zeta', label: 'ζ' },
  { tex: '\\eta', label: 'η' },
  { tex: '\\theta', label: 'θ' },
  { tex: '\\lambda', label: 'λ' },
  { tex: '\\mu', label: 'μ' },
  { tex: '\\nu', label: 'ν' },
  { tex: '\\xi', label: 'ξ' },
  { tex: '\\pi', label: 'π' },
  { tex: '\\rho', label: 'ρ' },
  { tex: '\\sigma', label: 'σ' },
  { tex: '\\tau', label: 'τ' },
  { tex: '\\phi', label: 'φ' },
  { tex: '\\chi', label: 'χ' },
  { tex: '\\psi', label: 'ψ' },
  { tex: '\\omega', label: 'ω' },
  { tex: '\\Gamma', label: 'Γ' },
  { tex: '\\Delta', label: 'Δ' },
  { tex: '\\Theta', label: 'Θ' },
  { tex: '\\Lambda', label: 'Λ' },
  { tex: '\\Pi', label: 'Π' },
  { tex: '\\Sigma', label: 'Σ' },
  { tex: '\\Phi', label: 'Φ' },
  { tex: '\\Omega', label: 'Ω' },
]

/** 运算 */
const OPS: MathItem[] = [
  { tex: '\\pm', label: '±', hint: '正负' },
  { tex: '\\times', label: '×', hint: '乘' },
  { tex: '\\div', label: '÷', hint: '除' },
  { tex: '\\cdot', label: '·', hint: '点乘' },
  { tex: '\\ast', label: '∗' },
  { tex: '\\sqrt{$0}', label: '√', hint: '根号' },
  { tex: '\\sqrt[$0]{}', label: 'ⁿ√', hint: 'n 次根' },
  { tex: '\\sum_{$0}^{}', label: '∑', hint: '求和' },
  { tex: '\\prod_{$0}^{}', label: '∏', hint: '连乘' },
  { tex: '\\int_{$0}^{}', label: '∫', hint: '积分' },
  { tex: '\\iint', label: '∬', hint: '二重积分' },
  { tex: '\\oint', label: '∮', hint: '环路积分' },
  { tex: '\\partial', label: '∂', hint: '偏导' },
  { tex: '\\nabla', label: '∇', hint: '梯度' },
  { tex: '\\infty', label: '∞', hint: '无穷' },
  { tex: '\\hbar', label: 'ℏ' },
]

/** 关系 */
const REL: MathItem[] = [
  { tex: '\\neq', label: '≠', hint: '不等' },
  { tex: '\\approx', label: '≈', hint: '约等' },
  { tex: '\\equiv', label: '≡', hint: '恒等' },
  { tex: '\\leq', label: '≤' },
  { tex: '\\geq', label: '≥' },
  { tex: '\\ll', label: '≪' },
  { tex: '\\gg', label: '≫' },
  { tex: '\\propto', label: '∝', hint: '正比' },
  { tex: '\\sim', label: '∼' },
  { tex: '\\cong', label: '≅' },
  { tex: '\\in', label: '∈' },
  { tex: '\\notin', label: '∉' },
  { tex: '\\subset', label: '⊂' },
  { tex: '\\supset', label: '⊃' },
  { tex: '\\subseteq', label: '⊆' },
  { tex: '\\perp', label: '⊥' },
  { tex: '\\parallel', label: '∥' },
  { tex: '\\emptyset', label: '∅' },
]

/** 箭头 */
const ARROWS: MathItem[] = [
  { tex: '\\to', label: '→', hint: '趋于' },
  { tex: '\\leftarrow', label: '←' },
  { tex: '\\leftrightarrow', label: '↔' },
  { tex: '\\Rightarrow', label: '⇒', hint: '推出' },
  { tex: '\\Leftarrow', label: '⇐' },
  { tex: '\\Leftrightarrow', label: '⇔', hint: '等价' },
  { tex: '\\uparrow', label: '↑' },
  { tex: '\\downarrow', label: '↓' },
  { tex: '\\mapsto', label: '↦', hint: '映射到' },
  { tex: '\\longrightarrow', label: '⟶' },
  { tex: '\\implies', label: '⟹' },
  { tex: '\\iff', label: '⟺' },
]

/** 结构：这些插完要接着写，所以带 $0 光标位 */
const STRUCT: MathItem[] = [
  { tex: '\\frac{$0}{}', label: 'a/b', hint: '分数' },
  { tex: '\\dfrac{$0}{}', label: '大分数', hint: '行内也撑开' },
  { tex: 'x^{$0}', label: 'xⁿ', hint: '上标' },
  { tex: 'x_{$0}', label: 'xₙ', hint: '下标' },
  { tex: '\\vec{$0}', label: '⃗x', hint: '向量' },
  { tex: '\\overline{$0}', label: 'x̄', hint: '上横线' },
  { tex: '\\hat{$0}', label: 'x̂', hint: '估计值' },
  { tex: '\\left($0\\right)', label: '( )', hint: '自动高度括号' },
  { tex: '\\left[$0\\right]', label: '[ ]', hint: '方括号' },
  { tex: '\\left\\{$0\\right\\}', label: '{ }', hint: '花括号' },
  { tex: '\\binom{$0}{}', label: 'C(n,k)', hint: '组合数' },
  { tex: '\\begin{aligned}$0\\end{aligned}', label: '多行', hint: '对齐的多行式子' },
  {
    tex: '\\begin{pmatrix}$0 & \\\\ & \\end{pmatrix}',
    label: '矩阵',
    hint: '2×2 矩阵',
  },
  { tex: '\\begin{cases}$0\\end{cases}', label: '分段', hint: '分段函数' },
  { tex: '\\lim_{$0 \\to 0}', label: 'lim', hint: '极限' },
  { tex: '\\log_{$0}', label: 'log', hint: '对数' },
]

/** 整条式子：一次插一整段，省得手打 */
const FORMULAS: MathItem[] = [
  {
    tex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
    label: '求根公式',
    hint: '二次方程',
  },
  { tex: 'e^{i\\pi} + 1 = 0', label: '欧拉恒等式', hint: '最美的式子（有争议）' },
  { tex: 'E = mc^2', label: '质能方程' },
  {
    tex: '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
    label: '等差数列求和',
  },
  { tex: '\\int_{a}^{b} f(x)\\,dx = F(b) - F(a)', label: '牛顿-莱布尼茨' },
  {
    tex: 'f\'(x) = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}',
    label: '导数定义',
  },
  {
    tex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    label: '2×2 矩阵',
  },
  { tex: 'P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}', label: '贝叶斯' },
]

export const MATH_GROUPS: MathGroup[] = [
  { id: 'greek', title: '希腊', items: GREEK },
  { id: 'ops', title: '运算', items: OPS },
  { id: 'rel', title: '关系', items: REL },
  { id: 'arrow', title: '箭头', items: ARROWS },
  { id: 'struct', title: '结构', items: STRUCT },
  { id: 'formula', title: '整式', items: FORMULAS },
]

/**
 * 把 `$0` 去掉，并把光标位置算出来。
 *
 * 用 `$0` 而不是"第一个 {}"：有些片段根本没有花括号（`\alpha`），
 * 有些顺序不对（`\sqrt[$0]{}`），靠猜会把光标放到错的地方。
 */
export function placeCaret(tex: string): { text: string; caret: number } {
  const at = tex.indexOf('$0')
  if (at < 0) return { text: tex, caret: tex.length }
  return { text: tex.slice(0, at) + tex.slice(at + 2), caret: at }
}

/**
 * 光标是不是在公式里。
 *
 * 判定分两层：
 *   ① 块公式 `$$ … $$`：数前面出现过几个 `$$`，奇数就是在里面
 *   ② 行内公式 `$ … $`：只看**当前行**光标前的 `$` 个数，奇数就是在里面
 *      （转义的 `\$` 不算）
 *
 * 只看当前行是故意的：行内公式本来就不能跨行，跨行那个是块公式的事。
 */
export type MathContext = { kind: 'inline' | 'block' }

export function mathContextAt(text: string, pos: number): MathContext | null {
  const at = Math.max(0, Math.min(pos, text.length))
  const before = text.slice(0, at)

  // ① 块公式
  const blocks = (before.match(/\$\$/g) ?? []).length
  if (blocks % 2 === 1) return { kind: 'block' }

  // ② 行内公式
  const lineStart = before.lastIndexOf('\n') + 1
  const line = before.slice(lineStart)
  const dollars = (line.match(/(?<!\\)\$/g) ?? []).length
  return dollars % 2 === 1 ? { kind: 'inline' } : null
}

/** 面板搜索：按符号、按名称、按 hint 都能找到 */
export function searchMath(q: string): { group: MathGroup; items: MathItem[] }[] {
  const t = q.trim().toLowerCase()
  if (!t) return MATH_GROUPS.map((g) => ({ group: g, items: g.items }))
  return MATH_GROUPS.map((g) => ({
    group: g,
    items: g.items.filter(
      (i) =>
        i.label.includes(t) || i.tex.toLowerCase().includes(t) || (i.hint ?? '').includes(t),
    ),
  })).filter((x) => x.items.length > 0)
}
