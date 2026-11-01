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
  /** 图片：只读预览 */
  | 'image'
  /** PDF：只读预览（多页、可选文本） */
  | 'pdf'
  /** EPUB 电子书：**不在文件区读**，交给书架 */
  | 'epub'
  /** 白板：独立文件，用白板编辑器打开（不是普通文本） */
  | 'board'
  /** 压缩包 */
  | 'archive'
  /** 认不出的 */
  | 'unknown'

const EXT_KIND: Record<string, FileKind> = {
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'text',
  '.log': 'text',
  '.pdf': 'pdf',
  '.epub': 'epub',
  '.board': 'board',
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
  '.avif': 'image',
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

/** 电子书：文件区只显示一条"去书架"的说明，绝不当文本打开 */
export function isEpubPath(path: string): boolean {
  return kindOf(path) === 'epub'
}

/**
 * 白板：文件区认得、能建、能改名，但**绝不当文本打开** ——
 * 中间区域用白板编辑器，文件树里也只显示成一条，不把它内部的块摊开成文档。
 */
export function isBoardPath(path: string): boolean {
  return kindOf(path) === 'board'
}

/** 能在中间工作区**只读预览**的类型；其余交给系统程序 */
export type PreviewKind = 'image' | 'pdf'

export function previewOf(path: string): PreviewKind | null {
  const k = kindOf(path)
  return k === 'image' || k === 'pdf' ? k : null
}

/** 图片预览认的扩展名 —— 和 EXT_KIND 保持同一份，别再各写一套 */
const IMAGE_EXTS = new Set(
  Object.entries(EXT_KIND)
    .filter(([, k]) => k === 'image')
    .map(([ext]) => ext),
)

export function isImagePath(path: string): boolean {
  return IMAGE_EXTS.has(extOf(path).toLowerCase())
}
