/*
 * 阅读/渲染的个性化设置。
 *
 * 存 localStorage，应用时写成根节点上的 CSS 变量 —— 阅读模式和编写模式读的是同一批变量，
 * 所以调一次两边一起变，不会"阅读调好了编写还是老样子"。
 */

export type Settings = {
  /** 正文字号 px */
  fontSize: number
  /** 行高倍数 */
  lineHeight: number
  /** 段落间距 rem */
  paraGap: number
  /** 正文最大宽度 rem */
  width: number
  /** 正文字体：两个预设 + 自己写 */
  font: 'sans' | 'serif' | 'custom'
  /** font = 'custom' 时用它，形如 `'LXGW WenKai', serif` */
  fontCustom: string
}

export const DEFAULTS: Settings = {
  fontSize: 15,
  lineHeight: 1.85,
  paraGap: 1,
  width: 46,
  font: 'sans',
  fontCustom: '',
}

const KEY = 'dusk.settings.v1'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const v = JSON.parse(raw) as Partial<Settings>
    return {
      fontSize: clamp(v.fontSize, 13, 21, DEFAULTS.fontSize),
      lineHeight: clamp(v.lineHeight, 1.4, 2.2, DEFAULTS.lineHeight),
      paraGap: clamp(v.paraGap, 0, 1.75, DEFAULTS.paraGap),
      width: clamp(v.width, 34, 62, DEFAULTS.width),
      font: v.font === 'serif' || v.font === 'custom' ? v.font : 'sans',
      fontCustom: typeof v.fontCustom === 'string' ? safeFont(v.fontCustom) : '',
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* 存不了就只在这次会话里生效 */
  }
}

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(max, Math.max(min, n))
}

const SANS = 'var(--font-sans)'
const SERIF = 'Georgia, "Songti SC", "SimSun", "Noto Serif SC", serif'

/**
 * 自定义字体是一段 CSS font-family。它是用户自己写进样式表的，
 * 所以要把能提前结束声明 / 插入别的规则的字符去掉（`;` `{` `}` `<` `>`）。
 */
export function safeFont(input: string): string {
  return input.replace(/[;{}<>]/g, '').trim().slice(0, 240)
}

/** 真正写进 CSS 变量的字体栈 */
export function fontStack(s: Settings): string {
  if (s.font === 'serif') return SERIF
  if (s.font === 'custom' && s.fontCustom) return safeFont(s.fontCustom)
  return SANS
}

/** 把设置写进根节点的 CSS 变量 */
export function applySettings(s: Settings): void {
  const root = document.documentElement.style
  root.setProperty('--dd-fs', `${s.fontSize}px`)
  root.setProperty('--dd-lh', String(s.lineHeight))
  root.setProperty('--dd-pg', `${s.paraGap}rem`)
  root.setProperty('--dd-cw', `${s.width}rem`)
  root.setProperty('--dd-font', fontStack(s))
}

export function resetSettings(): Settings {
  const s = { ...DEFAULTS }
  saveSettings(s)
  applySettings(s)
  return s
}
