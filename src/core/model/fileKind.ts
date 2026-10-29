/*
 * 文件种类：只回答"这东西是什么"，不管画什么图标 —— 图标在 ui/fileIcon.tsx。
 *
 * 放在 core 的理由：它是纯语义（按扩展名判定），node 里能直接测；
 * 将来"树里列出哪些文件、哪些能编辑、哪些只能交给系统"都要靠它。
 */
import { extOf } from './path'

export type FileKind =
  /** 应用的主格式：可编辑 */
  | 'md'
  /** 纯文本：将来的只读查看 */
  | 'text'
  /** 代码 / 结构化文本 */
  | 'code'
  /** 表格类数据 */
  | 'sheet'
  /** 图片 */
  | 'image'
  /** 压缩包 */
  | 'archive'
  /** 认不出的 */
  | 'unknown'

const EXT_KIND: Record<string, FileKind> = {
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'text',
  '.log': 'text',
  '.pdf': 'text',
  '.epub': 'text',
  '.ts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.jsx': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.css': 'code',
  '.scss': 'code',
  '.html': 'code',
  '.vue': 'code',
  '.py': 'code',
  '.rs': 'code',
  '.go': 'code',
  '.java': 'code',
  '.sh': 'code',
  '.ps1': 'code',
  '.sql': 'code',
  '.json': 'code',
  '.yaml': 'code',
  '.yml': 'code',
  '.toml': 'code',
  '.csv': 'sheet',
  '.xlsx': 'sheet',
  '.xls': 'sheet',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.svg': 'image',
  '.bmp': 'image',
  '.ico': 'image',
  '.zip': 'archive',
  '.7z': 'archive',
  '.rar': 'archive',
  '.gz': 'archive',
  '.tar': 'archive',
}

export function kindOf(path: string): FileKind {
  return EXT_KIND[extOf(path).toLowerCase()] ?? 'unknown'
}

/** 只有 md 能在这版里编辑；其余一律只读或交给系统（见方案书 D1） */
export function canEdit(path: string): boolean {
  return kindOf(path) === 'md'
}
