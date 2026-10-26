import type { SVGProps } from 'react'

/*
 * 手写图标，16 格、1.5 描边、currentColor、圆头端点。
 *
 * 上一版是拿坐标瞎凑的，几个形状各说各话。这一版统一了三条规矩：
 *   ① 内容落在 2–14 之间，四边留 2 的呼吸；描边 1.5 正好落在像素边上
 *   ② 所有转角用半径 1 的圆角，不用尖角
 *   ③ 同一档图标只用一种"骨架" —— 轮廓 + 一条细节线，不堆笔画
 */
type P = SVGProps<SVGSVGElement>

function Base({ children, ...rest }: P) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** 笔记：一页纸，右上折角，两道正文线 */
export const IconNotes = (p: P) => (
  <Base {...p}>
    <path d="M13 5.6V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h5.4L13 5.6Z" />
    <path d="M9.4 2v3.1a.5.5 0 0 0 .5.5H13" />
    <path d="M5.4 8.6h5.2M5.4 11.2h3.4" />
  </Base>
)

/** 搜索：一个圈加一根柄 */
export const IconSearch = (p: P) => (
  <Base {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.35 10.35 13.5 13.5" />
  </Base>
)

/** 标签：直接用 # —— 正文里写标签就是 #tag，图标跟语法一致，比画个吊牌清楚 */
export const IconTag = (p: P) => (
  <Base {...p}>
    <path d="M6.4 2.6 5.6 13.4M10.4 2.6 9.6 13.4" />
    <path d="M2.6 5.9h10.8M2.6 10.1h10.8" />
  </Base>
)

/** 设置：两条滑杆，旋钮把线断开 —— 比齿轮在 16px 干净得多 */
export const IconSliders = (p: P) => (
  <Base {...p}>
    <path d="M2.6 5.5h3M8.7 5.5h4.7M2.6 10.5h5M10.7 10.5h2.7" />
    <circle cx="7.1" cy="5.5" r="1.6" />
    <circle cx="9.1" cy="10.5" r="1.6" />
  </Base>
)

export const IconChevron = (p: P) => (
  <Base {...p}>
    <path d="M6.25 3.75 10.25 8l-4 4.25" />
  </Base>
)

/** 文件夹：一个带标签页的梯形 */
export const IconFolder = (p: P) => (
  <Base {...p}>
    <path d="M2.2 4.6a1.2 1.2 0 0 1 1.2-1.2h2.4l1.6 1.7h5.2a1.2 1.2 0 0 1 1.2 1.2v5.3a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2Z" />
  </Base>
)

/** 文件：跟「笔记」同一个骨架，去掉正文线 —— 一眼看出是同一族 */
export const IconFile = (p: P) => (
  <Base {...p}>
    <path d="M13 5.6V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h5.4L13 5.6Z" />
    <path d="M9.4 2v3.1a.5.5 0 0 0 .5.5H13" />
  </Base>
)

export const IconPlus = (p: P) => (
  <Base {...p}>
    <path d="M8 3.25v9.5M3.25 8h9.5" />
  </Base>
)

export const IconPanelRight = (p: P) => (
  <Base {...p}>
    <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.4" />
    <path d="M10 3.2v9.6" />
  </Base>
)

export const IconPanelClose = (p: P) => (
  <Base {...p}>
    <path d="M6.25 3.75 10.25 8l-4 4.25" />
  </Base>
)

export const IconMore = (p: P) => (
  <Base {...p}>
    <circle cx="3.6" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="12.4" cy="8" r="1" fill="currentColor" stroke="none" />
  </Base>
)

export const IconLink = (p: P) => (
  <Base {...p}>
    <path d="M6.7 9.3 9.3 6.7" />
    <path d="M7.5 4.5 8.8 3.2a2.3 2.3 0 0 1 3.2 3.2L10.7 7.7" />
    <path d="M8.5 11.5 7.2 12.8a2.3 2.3 0 0 1-3.2-3.2L5.3 8.3" />
  </Base>
)

/** 阅读 / 编写 两个模式 */
export const IconEye = (p: P) => (
  <Base {...p}>
    <path d="M1.6 8S4 3.9 8 3.9 14.4 8 14.4 8 12 12.1 8 12.1 1.6 8 1.6 8Z" />
    <circle cx="8" cy="8" r="1.9" />
  </Base>
)

export const IconPen = (p: P) => (
  <Base {...p}>
    <path d="M11.4 2.6a1.5 1.5 0 0 1 2.1 2.1L6 12.2l-2.8.7.7-2.8Z" />
  </Base>
)

/** 阅读：摊开的书 */
export const IconBook = (p: P) => (
  <Base {...p}>
    <path d="M8 4.4C6.6 3.3 4.8 2.9 3 3.1v8.5c1.8-.2 3.6.2 5 1.3 1.4-1.1 3.2-1.5 5-1.3V3.1c-1.8-.2-3.6.2-5 1.3Z" />
    <path d="M8 4.4v8.5" />
  </Base>
)

/** 原代码：尖括号 */
export const IconCode = (p: P) => (
  <Base {...p}>
    <path d="M5.9 4.6 2.5 8l3.4 3.4M10.1 4.6 13.5 8l-3.4 3.4" />
  </Base>
)

/** 新建文件夹 */
export const IconFolderPlus = (p: P) => (
  <Base {...p}>
    <path d="M2.2 4.6a1.2 1.2 0 0 1 1.2-1.2h2.4l1.6 1.7h5.2a1.2 1.2 0 0 1 1.2 1.2v5.3a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2Z" />
    <path d="M8 7.5v3.2M6.4 9.1h3.2" />
  </Base>
)

/** 置顶：一枚图钉 */
export const IconPin = (p: P) => (
  <Base {...p}>
    <path d="M9.6 2.3a1 1 0 0 1 1.4 0l2.7 2.7a1 1 0 0 1 0 1.4l-1.5 1.5.6 3-6.8-6.8 3 .6Z" />
    <path d="M5.3 10.7 2.5 13.5" />
  </Base>
)

/** 左右分栏 */
export const IconSplit = (p: P) => (
  <Base {...p}>
    <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.4" />
    <path d="M8 3.2v9.6" />
  </Base>
)

/** 收/开左栏 */
export const IconPanelLeft = (p: P) => (
  <Base {...p}>
    <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.4" />
    <path d="M6 3.2v9.6" />
  </Base>
)

/* ── 格式化工具条用的一组。跟别的图标同一套规矩：16 格、1.5 描边 ── */

export const IconBold = (p: P) => (
  <Base {...p}>
    <path d="M5.6 3.5v9" />
    <path d="M5.6 3.5h3.1a2.2 2.2 0 0 1 0 4.4H5.6" />
    <path d="M5.6 7.9h3.7a2.3 2.3 0 0 1 0 4.6H5.6" />
  </Base>
)

export const IconItalic = (p: P) => (
  <Base {...p}>
    <path d="M6.3 3.5h4.1M5.6 12.5h4.1M9.6 3.5 6.4 12.5" />
  </Base>
)

export const IconHeading = (p: P) => (
  <Base {...p}>
    <path d="M4.2 3.5v9M11.8 3.5v9M4.2 8h7.6" />
  </Base>
)

export const IconList = (p: P) => (
  <Base {...p}>
    <path d="M6.2 4h7M6.2 8h7M6.2 12h7" />
    <circle cx="3.4" cy="4" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="3.4" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="3.4" cy="12" r="0.9" fill="currentColor" stroke="none" />
  </Base>
)

export const IconQuote = (p: P) => (
  <Base {...p}>
    <path d="M3.6 3.5v9" />
    <path d="M6.4 5.2h7M6.4 8h7M6.4 10.8h4.4" />
  </Base>
)

/** 双链：一对方括号 */
export const IconBrackets = (p: P) => (
  <Base {...p}>
    <path d="M6 3.8H4.2v8.4H6M10 3.8h1.8v8.4H10" />
  </Base>
)

/** 表格 */
export const IconTable = (p: P) => (
  <Base {...p}>
    <rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.2" />
    <path d="M2.4 6.6h11.2M2.4 9.6h11.2M6.4 3.4v9.2M9.9 3.4v9.2" />
  </Base>
)

/** 划掉 */
export const IconStrike = (p: P) => (
  <Base {...p}>
    <path d="M3.4 8h9.2" />
    <path d="M10.6 5.3c-.6-1-1.6-1.5-2.8-1.5-1.6 0-2.7.8-2.7 1.9 0 .9.7 1.4 2.2 1.8" />
    <path d="M5.8 11.1c.6.9 1.6 1.4 2.9 1.4 1.6 0 2.7-.8 2.7-1.9" />
  </Base>
)

/** 字色：一个 A */
export const IconColor = (p: P) => (
  <Base {...p}>
    <path d="M4.6 11.4 8 3.4l3.4 8" />
    <path d="M5.9 8.8h4.2" />
  </Base>
)
/** 底色（荧光笔） */
export const IconHighlight = (p: P) => (
  <Base {...p}>
    <path d="M6.4 10.8 3.4 11.4l.6-3 6-6 2.2 2.2-5.8 6.2z" />
    <path d="M3 13.4h10" />
  </Base>
)

/** 字号 */
export const IconFontSize = (p: P) => (
  <Base {...p}>
    <path d="M3.2 12 6.2 4.6 9.2 12M4.2 9.6h4" />
    <path d="M12.2 6v6M10.6 7.6l1.6-1.6 1.6 1.6" />
  </Base>
)

/** 对齐 */
export const IconAlign = (p: P) => (
  <Base {...p}>
    <path d="M3 4.6h10M5 8h6M3 11.4h10" />
  </Base>
)

/** 提示框 */
export const IconCallout = (p: P) => (
  <Base {...p}>
    <rect x="2.4" y="3.6" width="11.2" height="8.8" rx="2" />
    <path d="M5.4 3.6v8.8" />
  </Base>
)
/** 块笔记：两行小方块 */
export const IconBlocks = (p: P) => (
  <Base {...p}>
    <rect x="2.6" y="3" width="4.4" height="3.4" rx="1" />
    <rect x="9" y="3" width="4.4" height="3.4" rx="1" />
    <rect x="2.6" y="9.6" width="4.4" height="3.4" rx="1" />
    <rect x="9" y="9.6" width="4.4" height="3.4" rx="1" />
  </Base>
)
/** 编辑表格：表格 + 一笔 */
export const IconTableEdit = (p: P) => (
  <Base {...p}>
    <rect x="2.2" y="3.2" width="9" height="9.2" rx="1.2" />
    <path d="M2.2 6.6h9M6.4 3.2v9.2" />
    <path d="m10.2 12.5 3.2-3.2" />
  </Base>
)

/** 数学：一个 Σ */
export const IconSigma = (p: P) => (
  <Base {...p}>
    <path d="M11.4 3.6H5.2l3.4 4.4-3.4 4.4h6.2" />
  </Base>
)

/** 块级公式：Σ 套一个框，跟行内公式区分开 */
export const IconMathBlock = (p: P) => (
  <Base {...p}>
    <rect x="2" y="3.2" width="12" height="9.6" rx="2" />
    <path d="M9.4 5.8H7l1.4 2.2L7 10.2h2.4" />
  </Base>
)

/** 有序列表：三条正文线 + 手写的 1 和 2 */
export const IconListOrdered = (p: P) => (
  <Base {...p}>
    <path d="M7 4.2h7M7 8.2h7M7 12.2h7" />
    <path d="M3.4 2.8v2.8M3.4 2.8l-1.1.9" />
    <path d="M2.3 7.2c0-1.1 2-1.2 2-.1 0 .9-2 1.7-2 2.9h2.1" />
  </Base>
)

/** 任务列表：一个打了勾的方框 */
export const IconTask = (p: P) => (
  <Base {...p}>
    <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.6" />
    <path d="m5.2 8.2 2.2 2.2 4-4.6" />
  </Base>
)

/** 分割线：一道横线 */
export const IconHr = (p: P) => (
  <Base {...p}>
    <path d="M2 8h12" />
  </Base>
)

/** 工具：一把扳手（左栏「工具」页签用） */
export const IconTool = (p: P) => (
  <Base {...p}>
    <path d="M10.5 2.8a3 3 0 0 0-3.9 3.9L3 10.3V13h2.7l3.6-3.6a3 3 0 0 0 3.9-3.9l-2 2-2.1-2.1 2-2Z" />
  </Base>
)

/** 查重：两张叠起来的纸 */
export const IconDuplicate = (p: P) => (
  <Base {...p}>
    <rect x="2.6" y="2.6" width="7" height="8.6" rx="1.4" />
    <rect x="6.4" y="4.8" width="7" height="8.6" rx="1.4" />
  </Base>
)

/** 回收站：一个带盖的桶 */
export const IconTrash = (p: P) => (
  <Base {...p}>
    <path d="M3.2 4.6h9.6" />
    <path d="M6.4 2.6h3.2" />
    <path d="M4.6 4.6 5.3 12.9a1 1 0 0 0 1 .9h3.4a1 1 0 0 0 1-.9l.7-8.3" />
  </Base>
)
