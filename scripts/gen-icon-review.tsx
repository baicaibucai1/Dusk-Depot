/*
 * 生成图标审阅页：assets/icon-review.html
 *
 * 只读已有的 lucide-react 和项目自己的 icons，不装任何东西。
 * 目的是让"审阅"能看见真东西 —— 16px 在真底色上的样子，而不是一堆链接。
 */
import { writeFileSync } from 'node:fs'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BookOpen,
  ChevronsDownUp,
  Copy,
  FileArchive,
  FileCode,
  FileImage,
  FileJson,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderCog,
  FolderGit2,
  FolderHeart,
  FolderOpen,
  Hash,
  Link2,
  ListOrdered,
  ListTodo,
  Search,
  Settings,
  Trash2,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { IconMarkdown, IconTool } from '../src/ui/icons'

/** 现在真的在用的 */
const IN_USE: { name: string; Icon: LucideIcon | null; where: string; glyph?: 'md' | 'tool' }[] = [
  { name: 'folder', Icon: Folder, where: '文件夹（收起）' },
  { name: 'folder-open', Icon: FolderOpen, where: '文件夹（展开）' },
  { name: 'IconMarkdown', Icon: null, glyph: 'md', where: 'md 文件（项目自有 M↓，非 lucide）' },
  { name: 'file-text', Icon: FileText, where: 'txt / pdf 等文本' },
  { name: 'file-code', Icon: FileCode, where: 'ts / json / yml' },
  { name: 'file-spreadsheet', Icon: FileSpreadsheet, where: 'csv / xlsx' },
  { name: 'file-image', Icon: FileImage, where: 'png / jpg' },
  { name: 'file-archive', Icon: FileArchive, where: 'zip / 7z' },
  { name: 'file-question', Icon: FileQuestion, where: '认不出的扩展名' },
]

/** 以后可能要用：先看这个库够不够 */
const LATER: { name: string; Icon: LucideIcon | null; glyph?: 'md' | 'tool'; note: string }[] = [
  { name: 'FolderCog', Icon: FolderCog, note: '自定义文件夹图标（首选）' },
  { name: 'FolderHeart', Icon: FolderHeart, note: '收藏夹图标备选' },
  { name: 'FolderGit2', Icon: FolderGit2, note: '仓库 / 项目图标' },
  { name: 'FileJson', Icon: FileJson, note: 'json 单独区分' },
  { name: 'BookOpen', Icon: BookOpen, note: '阅读模式' },
  { name: 'Hash', Icon: Hash, note: '标签页签' },
  { name: 'Search', Icon: Search, note: '搜索页签' },
  { name: 'IconTool', Icon: null, glyph: 'tool', note: '工具页签（自有）' },
  { name: 'Wrench', Icon: Wrench, note: '工具页签（lucide 版，可替换自有）' },
  { name: 'Link2', Icon: Link2, note: '反链 / 关系' },
  { name: 'Trash2', Icon: Trash2, note: '回收站' },
  { name: 'Copy', Icon: Copy, note: '查重' },
  { name: 'ListOrdered', Icon: ListOrdered, note: '有序列表按钮' },
  { name: 'ListTodo', Icon: ListTodo, note: '任务列表按钮' },
  { name: 'ChevronsDownUp', Icon: ChevronsDownUp, note: '全部折叠' },
  { name: 'Settings', Icon: Settings, note: '设置（现在也是自有）' },
]

function glyph(kind: 'md' | 'tool' | undefined, size = 16) {
  // Base 自带 width/height=16；要让大号那列真的是 32，得显式盖掉
  if (kind === 'md') return <IconMarkdown width={size} height={size} />
  if (kind === 'tool') return <IconTool width={size} height={size} />
  return null
}

/** 一个图标在某个尺寸下的 svg（带颜色由外部 class 决定） */
function Svg({ I, size, color }: { I: LucideIcon; size: number; color: string }) {
  return <I size={size} strokeWidth={1.5} color={color} />
}

function row(name: string, node: React.ReactNode, extra: string) {
  return `<tr><td class="mono">${name}</td><td class="icons">${node}</td><td class="where">${extra}</td></tr>`
}

const ink3 = '#8b9a93'
const green = '#0e9b66'

/* 16px 三种状态：普通 / 选中 / 悬停底色上 */
function cell(I: LucideIcon | null, kind: 'md' | 'tool' | undefined, size: number, color: string) {
  if (I) return renderToStaticMarkup(<Svg I={I} size={size} color={color} />)
  // 自有图标用 color 染不上（写的是 currentColor），包一层 span 定色
  return `<span style="color:${color};display:inline-flex">${renderToStaticMarkup(glyph(kind, size))}</span>`
}

const inUseRows = IN_USE.map((it) =>
  row(
    it.name,
    [
      `<span class="slot">${cell(it.Icon, it.glyph, 16, ink3)}</span>`,
      `<span class="slot sel">${cell(it.Icon, it.glyph, 16, green)}</span>`,
      `<span class="slot big">${cell(it.Icon, it.glyph, 32, ink3)}</span>`,
    ].join(''),
    it.where,
  ),
).join('')

const laterRows = LATER.map((it) =>
  row(
    it.name,
    [
      `<span class="slot">${cell(it.Icon, it.glyph, 16, ink3)}</span>`,
      `<span class="slot big">${cell(it.Icon, it.glyph, 32, ink3)}</span>`,
    ].join(''),
    it.note,
  ),
).join('')

/* 树的一段真实样子：缩进 + 展开箭头 + 图标 + 不带后缀的名字 */
const treeRow = (depth: number, icon: string, label: string, open?: boolean, active?: boolean) => `
  <div class="trow${active ? ' act' : ''}" style="padding-left:${8 + depth * 14}px">
    <span class="caret">${open === undefined ? '' : open ? '▾' : '▸'}</span>
    <span class="ticon">${icon}</span>
    <span class="tlabel">${label}</span>
  </div>`

const tree = [
  treeRow(0, cell(FolderOpen, undefined, 16, ink3), '项目', true),
  treeRow(1, cell(null, 'md', 16, green), '周计划', undefined, true),
  treeRow(1, cell(null, 'md', 16, ink3), '需求草稿'),
  treeRow(0, cell(Folder, undefined, 16, ink3), '素材', false),
  treeRow(0, cell(FileText, undefined, 16, ink3), '合同模板'),
  treeRow(0, cell(FileImage, undefined, 16, ink3), '截图-1029'),
  treeRow(0, cell(FileQuestion, undefined, 16, ink3), 'a.zzz'),
].join('')

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>图标库审阅 · Lucide</title>
<style>
  :root{
    --paper:#f5f7f6; --surface:#fff; --surface-2:#eef1ef; --line:#e3e7e5;
    --ink:#10231c; --ink-2:#4a5a53; --ink-3:#8b9a93;
    --green:#0e9b66; --green-soft:#e9f7f0;
    --mono:ui-monospace,'Cascadia Code',Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);
    font:14px/1.6 ui-sans-serif,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:940px;margin:0 auto;padding:40px 28px 80px}
  h1{font-size:22px;margin:0 0 6px;font-weight:600;letter-spacing:-.01em}
  .sub{color:var(--ink-3);font-size:13px;margin:0 0 28px}
  h2{font-size:14px;font-weight:600;margin:36px 0 10px;padding-bottom:8px;border-bottom:1px solid var(--line)}
  h2 span{font-weight:400;color:var(--ink-3);font-size:12px;margin-left:8px}
  table{width:100%;border-collapse:collapse;background:var(--surface);
    border:1px solid var(--line);border-radius:12px;overflow:hidden}
  td,th{padding:9px 14px;border-bottom:1px solid var(--line);vertical-align:middle;text-align:left}
  tr:last-child td{border-bottom:0}
  th{background:var(--surface-2);font-size:11.5px;font-weight:500;color:var(--ink-3);
    letter-spacing:.04em;text-transform:uppercase}
  td.mono{font-family:var(--mono);font-size:12px;color:var(--ink-2);width:190px}
  td.icons{width:190px;white-space:nowrap}
  td.where{font-size:12.5px;color:var(--ink-3)}
  .slot{display:inline-grid;place-items:center;width:34px;height:30px;border-radius:7px;vertical-align:middle}
  .slot.sel{background:var(--green-soft)}
  .slot.big{width:52px;height:38px}
  .note{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--green);
    border-radius:10px;padding:14px 16px;margin:16px 0;font-size:13px;color:var(--ink-2)}
  .note b{color:var(--ink)}
  .tree{width:280px;background:var(--surface);border:1px solid var(--line);border-radius:12px;
    padding:8px 6px;font-size:13px}
  .trow{display:flex;align-items:center;gap:6px;height:28px;border-radius:6px;padding-right:8px;color:var(--ink-2)}
  .trow.act{background:var(--green-soft);color:var(--ink)}
  .caret{width:12px;color:var(--ink-3);font-size:10px;flex:0 0 12px;text-align:center}
  .ticon{display:grid;place-items:center;width:16px;flex:0 0 16px}
  .tlabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .two{display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap}
  .legend{font-size:12px;color:var(--ink-3);margin:10px 0 0}
  .badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:20px;
    background:var(--green-soft);color:var(--green);margin-left:6px;vertical-align:2px}
</style>
</head>
<body>
<div class="wrap">
  <h1>图标库审阅 · Lucide</h1>
  <p class="sub">ISC 协议 · 1,600+ 图标 · 24 格 2 描边 · 实际用 size16 stroke1.5　—— 本页用项目里的真组件渲染，不是截图</p>

  <div class="note">
    <b>怎么判：</b>下面每个图标都给了三种状态（普通 <b>墨灰</b> / 选中 <b>绿</b> / 放大 32px）。
    看两件事就够了 —— ① 16px 时还认得出吗；② 描边粗细跟旁边手画的 M↓ 打架吗。
  </div>

  <h2>一、现在真的在用的 <span>9 个</span></h2>
  <table>
    <thead><tr><th>图标名</th><th>16 普通 / 16 选中 / 32 放大</th><th>用在哪</th></tr></thead>
    <tbody>${inUseRows}</tbody>
  </table>

  <h2>二、放进树里是什么样 <span>真行高 / 真缩进 / 真底色</span></h2>
  <div class="two">
    <div>
      <div class="tree">${tree}</div>
      <p class="legend">md 不带后缀，靠前面的 M↓ 认；文件夹开合用 folder / folder-open；认不出的用 file-question 而不是装成普通文件。</p>
    </div>
    <div style="flex:1;min-width:260px">
      <p class="legend" style="margin-top:0">
        注意最后那行 <span class="badge">a.zzz</span> —— 它不是 md，图标就不该跟 md 一样。
        现在树只列 md，所以这些行是<b>按接入后的样子</b>画的。
      </p>
    </div>
  </div>

  <h2>三、以后可能要用的 <span>16 个 · 看这个库够不够</span></h2>
  <table>
    <thead><tr><th>图标名</th><th>16 / 32</th><th>将来用在哪</th></tr></thead>
    <tbody>${laterRows}</tbody>
  </table>

  <div class="note">
    <b>关于「自定义文件夹图标」：</b>代码里已经留了开关（<code>FOLDER_OVERRIDES</code>，路径 → 组件）。
    上面第一行的 <b>FolderCog / FolderHeart / FolderGit2</b> 就是候选。要真的让用户自己换，
    得再加一层「每个文件夹记一个图标名」的配置（存 <code>.dusk/icons.json</code>，属可删的投影）——
    那是功能，不是图标库的事，等你说做再做。
  </div>

  <h2>四、没选的那些，凭什么是它</h2>
  <table>
    <thead><tr><th>库</th><th>协议</th><th>为什么没选</th></tr></thead>
    <tbody>
      <tr><td class="mono">Tabler</td><td>MIT</td><td class="where">6,200+ 个，数量最多；但同一批文件类图标的细节不齐（有的圆角、有的直角），跟手画那套混着用会显毛</td></tr>
      <tr><td class="mono">Phosphor</td><td>MIT</td><td class="where">6 种字重是给设计系统用的；这里只需要一档描边</td></tr>
      <tr><td class="mono">Remix Icon</td><td>Apache-2.0</td><td class="where">以字体为主，按需摇树差，容易把整个 3,200 个打进包</td></tr>
      <tr><td class="mono">Heroicons</td><td>MIT</td><td class="where">只有 316 个，文件类型这类会缺</td></tr>
      <tr><td class="mono">vscode-icons / material</td><td>MIT</td><td class="where">彩色 32 格，是为深色编辑器槽位设计的；这套界面绿色只做强调，塞一排橙黄蓝会直接破坏语言</td></tr>
    </tbody>
  </table>

  <p class="legend" style="margin-top:22px">
    数据来源：GitHub API 实查（2026-10-29），详见 <code>docs/icon-library.md</code>。
    包体代价：337.12 → 336.85 kB（gzip 107.13 未变）—— 只打进用到的图标。
  </p>
</div>
</body>
</html>`

writeFileSync('assets/icon-review.html', html, 'utf8')
console.log('wrote assets/icon-review.html', html.length, 'bytes')
