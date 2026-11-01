/*
 * 文件树 / 标签页里的图标：文件夹用 Lucide，文件按种类分（见 core/model/fileKind.ts）。
 *
 * 为什么引一个图标库而不是继续手画：文件类型会越来越多（图片 / 代码 / 表格…），
 * 手画十几个风格一致的 16 格图标不划算。Lucide 是 ISC 协议、按需摇树，
 * 描边风格和我们原来手画的 16 格图标是一路的（1.5 描边、圆角端点）。
 *
 * 三种类型例外，用手画的：
 *   `.md`   → IconMarkdown（应用的主格式，需要一个一眼能认出来的记号）
 *   `.pdf`  → IconPdf（Lucide 那枚 `file-type` 在 16px 下读作"文本"，和 file-text 撞脸）
 *   `.board`→ IconBoard（白板是这一版的新文件类型，得有自己的骨架）
 *
 * ⚠️ 尺寸只有一处：`SIZE`。树里 16、标签页 13.5、右栏 20 —— 都从这儿传下去，
 *    别再各自写 size-4 / size-5，那样同一排图标会一大一小。
 *
 * 想给某个文件夹换图标：把路径 → 组件塞进 FOLDER_OVERRIDES。
 * 将来接「每个文件夹自定义图标」时，这张表从 `.dusk/icons.json` 读。
 */
import {
  BookOpen,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  type LucideIcon,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { kindOf, type FileKind } from '../core/model/fileKind'
import { IconBlocks, IconBoard, IconMarkdown, IconPdf } from './icons'

type GlyphProps = { size: number; className?: string }

/** Lucide 那几枚：统一 1.5 描边，跟手画图标一个重量 */
const LUCIDE: Partial<Record<FileKind, LucideIcon>> = {
  text: FileText,
  code: FileCode,
  sheet: FileSpreadsheet,
  image: FileImage,
  epub: BookOpen,
  archive: FileArchive,
  unknown: FileQuestion,
}

/** 手画的：viewBox 都是 16 格，直接给宽高 */
const NATIVE: Partial<Record<FileKind, ComponentType<{ width?: number; height?: number; className?: string }>>> = {
  md: IconMarkdown,
  pdf: IconPdf,
  board: IconBoard,
}

/** 某个文件夹换自定义图标：`'项目': FolderCog` 这样写 */
const FOLDER_OVERRIDES: Record<string, LucideIcon> = {}

/** 按扩展名挑一枚图标。树、标签页、右栏共用这一个入口 */
export function FileGlyph({ path, size = 16, className }: GlyphProps & { path: string }) {
  // `.note` 是"目录即文档"，不在扩展名表里 —— 但它是应用的主要格式之一，
  // 不能掉进"认不出"的那一档（那会显示成问号，看着像坏了）
  if (path.toLowerCase().endsWith('.note')) {
    return <IconBlocks width={size} height={size} className={className} />
  }
  const kind = kindOf(path)
  const Native = NATIVE[kind]
  if (Native) return <Native width={size} height={size} className={className} />
  const Icon = LUCIDE[kind] ?? File
  return <Icon size={size} strokeWidth={1.5} className={className} />
}

type Props = {
  path: string
  isDir: boolean
  /** 文件夹是否展开（决定用 folder 还是 folder-open） */
  open?: boolean
  /** 当前选中的那一篇：染色 */
  active?: boolean
  /** 图标边长，默认 16（文件树） */
  size?: number
  className?: string
}

export function TreeIcon({ path, isDir, open, active, size = 16, className }: Props) {
  const tone = active ? 'text-green' : 'text-ink-3'

  if (isDir) {
    const Custom = FOLDER_OVERRIDES[path]
    const Icon = Custom ?? (open ? FolderOpen : Folder)
    return <Icon size={size} strokeWidth={1.5} className={`${className ?? ''} ${tone}`} />
  }

  return (
    <FileGlyph path={path} size={size} className={`${className ?? ''} ${tone}`} />
  )
}
