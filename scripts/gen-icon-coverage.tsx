/*
 * 图标覆盖核查：把「这个应用会遇到的图标需求」逐条列出来，到 lucide-react 里找。
 *
 * 为什么要这么干：图标库的"够不够"从来不是比总数（1,600 还是 6,200），
 * 而是比"我们要的那 80 个形状在不在"。这个脚本只回答这一个问题。
 *
 * 产出 assets/icon-coverage.html —— 每条需求一行，命中显示真图标，没命中标红。
 */
import { writeFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as L from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

const ALL = L as unknown as Record<string, LucideIcon>

type Need = {
  /** 这一条是干嘛用的（人话） */
  use: string
  /** 候选名，按顺序取第一个存在的 */
  names: string[]
}

type Area = { title: string; note?: string; needs: Need[] }

const AREAS: Area[] = [
  {
    title: '一、左栏：页签与入口',
    needs: [
      { use: '「文件」页签', names: ['Files', 'FileStack'] },
      { use: '「工具」页签', names: ['Wrench', 'Hammer'] },
      { use: '「标签」页签（以后）', names: ['Tags', 'Hash'] },
      { use: '「搜索」页签（以后）', names: ['Search', 'ScanSearch'] },
      { use: '「视图 / 保存的筛选」（以后）', names: ['Filter', 'ListFilter'] },
      { use: '设置', names: ['Settings', 'Settings2'] },
      { use: '帮助', names: ['CircleHelp', 'HelpCircle'] },
      { use: '置顶', names: ['Pin', 'PinIcon'] },
    ],
  },
  {
    title: '二、文件树：文件夹与文件类型',
    note: '这一段是最容易被"总数"骗的地方 —— 需要的是具体形状，不是数量',
    needs: [
      { use: '文件夹（收起）', names: ['Folder'] },
      { use: '文件夹（展开）', names: ['FolderOpen'] },
      { use: '新建文件夹', names: ['FolderPlus'] },
      { use: '展开箭头', names: ['ChevronRight'] },
      { use: '全部折叠', names: ['ChevronsDownUp', 'FoldVertical'] },
      { use: '文件（通用兜底）', names: ['File'] },
      { use: '文本 / txt', names: ['FileText'] },
      { use: '代码 / ts / json', names: ['FileCode', 'FileJson'] },
      { use: '图片', names: ['FileImage', 'Image'] },
      { use: '表格 / csv', names: ['FileSpreadsheet'] },
      { use: '压缩包', names: ['FileArchive'] },
      { use: '音频', names: ['FileAudio', 'FileMusic'] },
      { use: '视频', names: ['FileVideo'] },
      { use: 'PDF', names: ['FilePdf', 'FileText'] },
      { use: '字体 / 类型文件', names: ['FileType', 'FileType2'] },
      { use: '结构化 / 数据库', names: ['Database', 'FileJson2'] },
      { use: '软链接 / 快捷方式', names: ['FileSymlink', 'Link'] },
      { use: '认不出的扩展名', names: ['FileQuestion', 'FileUnknown'] },
    ],
  },
  {
    title: '三、树与标签页上的操作',
    needs: [
      { use: '新建笔记', names: ['FilePlus', 'Plus'] },
      { use: '重命名', names: ['Pencil', 'TextCursorInput'] },
      { use: '移动到…', names: ['FolderInput', 'MoveRight'] },
      { use: '删除', names: ['Trash2', 'Trash'] },
      { use: '复制路径', names: ['Copy', 'ClipboardCopy'] },
      { use: '在系统中显示', names: ['FolderSearch', 'FolderOpen'] },
      { use: '更多菜单', names: ['Ellipsis', 'MoreHorizontal'] },
      { use: '关闭标签页', names: ['X'] },
      { use: '分栏', names: ['Columns2', 'PanelRight'] },
      { use: '刷新', names: ['RefreshCw', 'RotateCw'] },
      { use: '拖拽手柄', names: ['GripVertical'] },
    ],
  },
  {
    title: '四、编辑器工具条',
    needs: [
      { use: '粗体', names: ['Bold'] },
      { use: '斜体', names: ['Italic'] },
      { use: '删除线', names: ['Strikethrough'] },
      { use: '行内码', names: ['Code', 'CodeXml'] },
      { use: '标题', names: ['Heading', 'Heading1'] },
      { use: '无序列表', names: ['List'] },
      { use: '有序列表', names: ['ListOrdered'] },
      { use: '任务列表', names: ['ListTodo', 'ListChecks'] },
      { use: '引用', names: ['Quote', 'TextQuote'] },
      { use: '链接', names: ['Link', 'Link2'] },
      { use: '插入图片', names: ['Image', 'ImagePlus'] },
      { use: '插入表格', names: ['Table', 'Table2'] },
      { use: '编辑表格', names: ['TableProperties', 'Grid2x2'] },
      { use: '行内公式', names: ['Sigma'] },
      { use: '块公式', names: ['SquareFunction', 'FunctionSquare'] },
      { use: '双链', names: ['Brackets', 'Link2'] },
      { use: '标签', names: ['Tag', 'Tags'] },
      { use: '分割线', names: ['Minus'] },
      { use: '撤销', names: ['Undo2', 'Undo'] },
      { use: '重做', names: ['Redo2', 'Redo'] },
      { use: '高亮', names: ['Highlighter'] },
    ],
  },
  {
    title: '五、状态与反馈',
    note: '这一组决定"界面会不会撒谎" —— 保存中 / 已保存 / 写失败 必须三个不同的形状',
    needs: [
      { use: '已保存', names: ['Check', 'CheckCheck'] },
      { use: '待写入', names: ['Clock', 'CircleDashed'] },
      { use: '写入中', names: ['LoaderCircle', 'Loader2'] },
      { use: '写盘失败', names: ['TriangleAlert', 'AlertTriangle'] },
      { use: '磁盘（真文件）', names: ['HardDrive'] },
      { use: '浏览器暂存（不在磁盘）', names: ['CloudOff', 'DatabaseZap'] },
      { use: '只读', names: ['Lock', 'Eye'] },
      { use: '成功', names: ['CircleCheck', 'CheckCircle2'] },
      { use: '信息', names: ['Info'] },
    ],
  },
  {
    title: '六、右栏四页',
    needs: [
      { use: '大纲', names: ['ListTree', 'List'] },
      { use: '关系 / 反链', names: ['GitBranch', 'Network'] },
      { use: '属性', names: ['SlidersHorizontal', 'Info'] },
      { use: '附件', names: ['Paperclip'] },
      { use: '展开 / 收起', names: ['ChevronDown'] },
    ],
  },
  {
    title: '七、工具页',
    needs: [
      { use: '索引 / 重建', names: ['Database', 'RefreshCw'] },
      { use: '坏链报告', names: ['Unlink', 'Link2Off'] },
      { use: '孤儿文档', names: ['Unplug', 'CircleSlash'] },
      { use: '标签整理', names: ['Tags', 'Tag'] },
      { use: '查重', names: ['Copy', 'Files'] },
      { use: '回收站', names: ['Trash2'] },
      { use: '扫描 / 运行', names: ['Play', 'ScanSearch'] },
    ],
  },
  {
    title: '八、杂项',
    needs: [
      { use: '浅色 / 深色主题', names: ['Sun', 'Moon', 'Monitor'] },
      { use: '快捷键', names: ['Keyboard'] },
      { use: '命令面板', names: ['Command'] },
      { use: '全屏', names: ['Maximize', 'Expand'] },
      { use: '文本搜索', names: ['TextSearch', 'Search'] },
    ],
  },
]

type Hit = {
  use: string
  /** 实际命中的名字 */
  name: string | null
  Icon: LucideIcon | null
  /** 首选名不存在，退到了备选 */
  fallbackFrom: string | null
}

const results = AREAS.map((area) => ({
  title: area.title,
  note: area.note,
  hits: area.needs.map<Hit>((n) => {
    for (let i = 0; i < n.names.length; i++) {
      const name = n.names[i] as string
      const Icon = ALL[name]
      if (Icon) {
        return { use: n.use, name, Icon, fallbackFrom: i === 0 ? null : (n.names[0] as string) }
      }
    }
    return { use: n.use, name: null, Icon: null, fallbackFrom: null }
  }),
}))

const total = results.reduce((a, r) => a + r.hits.length, 0)
const missing = results.flatMap((r) => r.hits.filter((h) => !h.Icon))
const fallbacks = results.flatMap((r) => r.hits.filter((h) => h.fallbackFrom))
const exact = total - missing.length - fallbacks.length

const draw = (Icon: LucideIcon | null, size: number, color: string) =>
  Icon
    ? renderToStaticMarkup(
        createElement(Icon, { size, strokeWidth: 1.5, color, 'aria-hidden': true }),
      )
    : '<span class="miss">缺</span>'

const rowsHtml = results
  .map(
    (area) => `
  <h2>${area.title} <span>${area.hits.filter((h) => h.Icon).length}/${area.hits.length}</span>${
    area.note ? `<em>${area.note}</em>` : ''
  }</h2>
  <table>
    <thead><tr><th>用来干什么</th><th>16</th><th>32</th><th>库里的名字</th></tr></thead>
    <tbody>
      ${area.hits
        .map(
          (h) => `<tr class="${h.Icon ? (h.fallbackFrom ? 'near' : '') : 'bad'}">
        <td class="use">${h.use}</td>
        <td class="ic">${draw(h.Icon, 16, '#8b9a93')}</td>
        <td class="ic">${draw(h.Icon, 32, '#8b9a93')}</td>
        <td class="mono">${h.name ?? '—'}${
          h.fallbackFrom ? `<br><small>没有 ${h.fallbackFrom}，退成这个</small>` : ''
        }</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>`,
  )
  .join('')

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>图标够不够 · 需求逐条核查</title>
<style>
  :root{
    --paper:#f5f7f6; --surface:#fff; --surface-2:#eef1ef; --line:#e3e7e5;
    --ink:#10231c; --ink-2:#4a5a53; --ink-3:#8b9a93;
    --green:#0e9b66; --green-soft:#e9f7f0; --bad:#b4342b; --bad-soft:#fdf0ee;
    --mono:ui-monospace,'Cascadia Code',Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);
    font:14px/1.6 ui-sans-serif,system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:820px;margin:0 auto;padding:40px 28px 80px}
  h1{font-size:22px;margin:0 0 6px;font-weight:600;letter-spacing:-.01em}
  .sub{color:var(--ink-3);font-size:13px;margin:0 0 24px}
  .score{display:flex;gap:0;background:var(--surface);border:1px solid var(--line);
    border-radius:12px;overflow:hidden;margin:0 0 8px}
  .score div{flex:1;padding:14px 18px;border-right:1px solid var(--line)}
  .score div:last-child{border-right:0}
  .score b{display:block;font-size:24px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .score span{font-size:11.5px;color:var(--ink-3)}
  .ok b{color:var(--green)} .no b{color:var(--bad)}
  .near-box b{color:#96701a}
  h2{font-size:14px;font-weight:600;margin:30px 0 8px;padding-bottom:8px;
    border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
  h2 span{font-weight:500;color:var(--green);font-size:12px;font-variant-numeric:tabular-nums}
  h2 em{font-style:normal;font-weight:400;color:var(--ink-3);font-size:12px}
  table{width:100%;border-collapse:collapse;background:var(--surface);
    border:1px solid var(--line);border-radius:12px;overflow:hidden}
  td,th{padding:7px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
  tr:last-child td{border-bottom:0}
  th{background:var(--surface-2);font-size:11px;font-weight:500;color:var(--ink-3);letter-spacing:.04em}
  td.use{font-size:13px;width:52%}
  td.ic{width:56px;text-align:center}
  td.mono{font-family:var(--mono);font-size:11.5px;color:var(--ink-3)}
  tr.bad{background:var(--bad-soft)}
  tr.bad td.use{color:var(--bad)}
  tr.near{background:#fdfaf0}
  tr.near td.use{color:#8a6a12}
  td.mono small{font-size:10.5px;color:#a08a3c}
  .miss{font-size:11px;color:var(--bad);font-weight:600}
  .note{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--green);
    border-radius:10px;padding:14px 16px;margin:18px 0;font-size:13px;color:var(--ink-2)}
  .note b{color:var(--ink)}
  .warn{border-left-color:var(--bad)}
</style>
</head>
<body>
<div class="wrap">
  <h1>图标够不够 · 需求逐条核查</h1>
  <p class="sub">不比较总数，只比较「这个应用要的形状在不在」。每条都用真组件渲染，缺的标红。</p>

  <div class="score">
    <div class="ok"><b>${exact}</b><span>首选中（有专用图标）</span></div>
    <div class="near-box"><b>${fallbacks.length}</b><span>退到备选（没有专用的）</span></div>
    <div class="no"><b>${missing.length}</b><span>完全找不到</span></div>
    <div><b>${total}</b><span>清单总数</span></div>
  </div>
  <p class="sub" style="margin-top:10px">数据来源：跑脚本逐条查 <code>lucide-react</code> 的导出，不是凭印象列的。</p>

  ${rowsHtml}

  <h2>这条核查说明什么</h2>
  <div class="note">
    <b>1,600 和 6,200 的差别，对我们是没差别的。</b>
    这个应用满打满算需要 ${total} 个形状：${exact} 个有专用图标，${fallbacks.length} 个只能退到备选，${missing.length} 个完全找不到。
    真正的风险不是"库太小"，而是<b>"我们要的那个具体形状没有"</b> —— 黄色那几行就是。
  </div>
  <div class="note warn">
    <b>库里确实覆盖不到的两类（这类换库也解决不了）：</b><br>
    ① <b>后缀级文件图标</b> —— .docx / .xlsx / .psd / .fig / .7z 各要一张脸。
    Lucide 只给"文本 / 代码 / 表格 / 图片"这类<b>按大类</b>的图标，不分后缀。
    要做成 VS Code 那样一后缀一图标，得另配一套（material-icon-theme，彩色 32 格）——
    但那跟"绿只做强调"的配色语言冲突，所以我建议<b>按大类</b>，不做到后缀级。<br>
    ② <b>品牌图标</b> —— GitHub / 微信 / 各类云盘。Lucide 明确不收品牌 logo（法律与维护成本）。
    真要接 Git 面板，另加 <code>simple-icons</code>（CC0），只在那一处用。
  </div>
  <div class="note">
    <b>能自定义图标吗？</b> 能 —— 现在任何一个没用上的 lucide 图标、
    或者你自己画一个 16 格的 SVG，都能塞进 <code>FOLDER_OVERRIDES</code>。
    图标库是"默认值"，不是"上限"。
  </div>
</div>
</body>
</html>`

writeFileSync('assets/icon-coverage.html', html, 'utf8')
console.log(`需求 ${total} 条：首选 ${exact}，退备选 ${fallbacks.length}，缺 ${missing.length}`)
for (const m of fallbacks) console.log('  退：', m.use, '→', m.name, '（无', m.fallbackFrom, '）')
for (const m of missing) console.log('  缺：', m.use)
