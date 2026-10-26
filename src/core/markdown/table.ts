/*
 * 表格的读写。都是纯函数，跑在 Node 里能单测。
 *
 * 编辑器里"直接编辑表格"靠的是：从光标位置反查出整张表的**原始单元格文本**，
 * 交给一个网格编辑器改，改完按 markdown 重新生成再替换回文档。
 * 不把表格变成 CM6 的 widget —— 那条路试过，会毁掉拖选。
 *
 * 对齐（`:--` / `:-:` / `--:`）跟着表格走：反查时读出来，生成时写回去 ——
 * 否则网格编辑器一保存，用户设的居中/右对齐就悄悄没了。
 */

import type { Align } from './parse'

/** 一行表格：| a | b |（首尾竖线可有可无） */
const TABLE_ROW = /^\s*\|.*\|\s*$/
/** 分隔行：|---|---| 或 |:--|--:|。短横一个就够（GFM 是 `-+`，`:-:` 也认） */
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

export type TableRange = {
  /** 1 起算的行号，首尾都含 */
  fromLine: number
  toLine: number
  /** cells[0] 是表头；所有行都补齐到同样列数 */
  cells: string[][]
  /** 按列的对齐；null = 分隔行没写 */
  align: Align[]
}

/** `| a | b |` → ['a','b']；两端的空段丢掉，竖线里的 `\|` 当转义的竖线 */
export function splitRow(line: string): string[] {
  const parts: string[] = []
  let cur = ''
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '')

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      parts.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  parts.push(cur.trim())
  return parts
}

/** 单元格内容转义：竖线要转义，换行压成空格（markdown 表格是单行的） */
export function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

/** 单元格数组 → markdown 表格文本（第一行是表头） */
export function buildTable(cells: string[][], align: Align[] = []): string {
  const cols = Math.max(1, ...cells.map((r) => r.length))
  const norm = cells.map((r) => {
    const row = [...r]
    while (row.length < cols) row.push('')
    return row.map(escapeCell)
  })
  if (norm.length === 0) norm.push(new Array(cols).fill(''))

  const head = norm[0] ?? []
  const body = norm.slice(1)
  const line = (r: string[]) => `| ${r.join(' | ')} |`
  const sep = Array.from({ length: cols }, (_, c) => {
    const a = align[c] ?? null
    return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'
  })
  return [line(head), `| ${sep.join(' | ')} |`, ...body.map(line)].join('\n')
}

/** 空表：`rows` 行数据 + 1 行表头，`cols` 列 */
export function emptyTable(rows: number, cols: number): string[][] {
  const out: string[][] = [Array.from({ length: cols }, (_, c) => `列 ${c + 1}`)]
  for (let r = 0; r < rows; r++) out.push(new Array(cols).fill(''))
  return out
}

/** 从整篇文本 + 某个 1 起算的行号，反查出它所在的表格 */
export function tableAt(lines: string[], lineNumber: number): TableRange | null {
  const at = lineNumber - 1
  if (at < 0 || at >= lines.length) return null
  if (!TABLE_ROW.test(lines[at] ?? '')) return null

  // 往上找到表头行
  let start = at
  while (start > 0 && TABLE_ROW.test(lines[start - 1] ?? '')) start--

  // 表头下面必须是分隔行，否则这不是表格
  if (!TABLE_SEP.test(lines[start + 1] ?? '')) return null

  // 往下收到表格结束
  let end = start + 1
  while (end + 1 < lines.length && TABLE_ROW.test(lines[end + 1] ?? '')) end++

  const cells: string[][] = []
  for (let i = start; i <= end; i++) {
    if (i === start + 1) continue // 跳过对齐行
    cells.push(splitRow(lines[i] ?? ''))
  }

  const cols = Math.max(1, ...cells.map((r) => r.length))
  for (const row of cells) while (row.length < cols) row.push('')

  // 对齐行按列解出来；列数不够的补 null
  const sep = splitRow(lines[start + 1] ?? '')
  const align: Align[] = Array.from({ length: cols }, (_, c) => {
    const cell = sep[c] ?? ''
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null
  })

  return { fromLine: start + 1, toLine: end + 1, cells, align }
}

/** 一段表格 markdown → 单元格（跳过对齐行）。给"点渲染出来的表格"用 */
export function cellsFromTableText(md: string): string[][] {
  const rows = md
    .split('\n')
    .filter((l) => TABLE_ROW.test(l) && !TABLE_SEP.test(l))
    .map(splitRow)

  if (rows.length === 0) return []
  const cols = Math.max(1, ...rows.map((r) => r.length))
  for (const row of rows) while (row.length < cols) row.push('')
  return rows
}