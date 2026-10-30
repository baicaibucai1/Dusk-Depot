/*
 * 块类型目录 —— 斜杠菜单和块菜单共用同一份。
 *
 * 加一个块类型只改这里：菜单、搜索、标签全跟着变，
 * 免得"菜单里有、命令里没有"这种半拉子状态。
 */
import type { FlowInsertable, FlowTarget } from '../../core/note/flow'

export type BlockSpec = {
  kind: FlowInsertable
  label: string
  /** 左边的记号。用字符不用 emoji —— 菜单里一排彩色图标会盖过文字 */
  glyph: string
  /** 搜索关键词：中文、英文、快捷键写法都塞进来 */
  keys: string
  group: '基础' | '列表' | '媒体'
}

export const BLOCK_SPECS: BlockSpec[] = [
  { kind: 'paragraph', label: '正文', glyph: '¶', keys: '正文 段落 text paragraph p', group: '基础' },
  { kind: 'heading1', label: '一级标题', glyph: 'H1', keys: '一级标题 大标题 heading h1 title', group: '基础' },
  { kind: 'heading2', label: '二级标题', glyph: 'H2', keys: '二级标题 小标题 heading h2 subtitle', group: '基础' },
  { kind: 'quote', label: '引用', glyph: '❝', keys: '引用 引述 quote blockquote', group: '基础' },
  { kind: 'code', label: '代码块', glyph: '{}', keys: '代码 代码块 code pre fence', group: '基础' },
  { kind: 'divider', label: '分隔线', glyph: '—', keys: '分隔线 分割线 横线 divider hr rule', group: '基础' },
  { kind: 'bulletList', label: '项目符号列表', glyph: '•', keys: '列表 项目符号 无序 bullet list ul', group: '列表' },
  { kind: 'orderedList', label: '编号列表', glyph: '1.', keys: '列表 编号 有序 ordered number ol', group: '列表' },
  { kind: 'todoList', label: '待办列表', glyph: '☑', keys: '待办 任务 清单 todo task checklist', group: '列表' },
  { kind: 'image', label: '图片', glyph: '▧', keys: '图片 插图 image img picture', group: '媒体' },
  { kind: 'columns', label: '分栏', glyph: '▥', keys: '分栏 多列 columns layout', group: '媒体' },
]

export const CONVERT_TARGETS: FlowTarget[] = [
  'paragraph',
  'heading1',
  'heading2',
  'quote',
  'code',
  'bulletList',
  'orderedList',
  'todoList',
]

export function specOf(kind: string): BlockSpec | undefined {
  return BLOCK_SPECS.find((s) => s.kind === kind)
}

export function labelOfKind(kind: string): string {
  return specOf(kind)?.label ?? '块'
}

/** 空查询 = 全部（保持分组顺序）；否则按 label / 关键词做包含匹配 */
export function searchBlocks(query: string): BlockSpec[] {
  const q = query.trim().toLowerCase()
  if (!q) return BLOCK_SPECS
  return BLOCK_SPECS.filter((s) => `${s.label} ${s.keys}`.toLowerCase().includes(q))
}
