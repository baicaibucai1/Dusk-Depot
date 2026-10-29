/*
 * 文件树里的图标：文件夹用 Lucide，文件按种类分（见 core/model/fileKind.ts）。
 *
 * 为什么引一个图标库而不是继续手画：文件类型会越来越多（pdf / 图片 / 代码 / 表格…），
 * 手画十几个风格一致的 16 格图标不划算。Lucide 是 ISC 协议、按需摇树，
 * 描边风格和我们原来手画的 16 格图标是一路的（1.5 描边、圆角端点）。
 *
 * `.md` 例外：用项目自己的 M↓ 标记（icons.tsx 的 IconMarkdown）——
 * 这是应用的主格式，需要一个一眼能认出来的记号。
 *
 * 想给某个文件夹换图标：把路径 → 组件塞进 FOLDER_OVERRIDES。
 * 将来接「每个文件夹自定义图标」时，这张表从 `.dusk/icons.json` 读。
 */
import {
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
import { kindOf, type FileKind } from '../core/model/fileKind'
import { IconMarkdown } from './icons'

const BY_KIND: Record<FileKind, LucideIcon | null> = {
  md: null, // 走 IconMarkdown
  text: FileText,
  code: FileCode,
  sheet: FileSpreadsheet,
  image: FileImage,
  archive: FileArchive,
  unknown: FileQuestion,
}

/** 某个文件夹换自定义图标：`'项目': FolderCog` 这样写 */
const FOLDER_OVERRIDES: Record<string, LucideIcon> = {}

type Props = {
  path: string
  isDir: boolean
  /** 文件夹是否展开（决定用 folder 还是 folder-open） */
  open?: boolean
  /** 当前选中的那一篇：染色 */
  active?: boolean
  className?: string
}

export function TreeIcon({ path, isDir, open, active, className }: Props) {
  const tone = active ? 'text-green' : 'text-ink-3'

  if (isDir) {
    const Custom = FOLDER_OVERRIDES[path]
    if (Custom) return <Custom size={16} strokeWidth={1.5} className={`${className ?? ''} ${tone}`} />
    const Icon = open ? FolderOpen : Folder
    return <Icon size={16} strokeWidth={1.5} className={`${className ?? ''} ${tone}`} />
  }

  const kind = kindOf(path)
  if (kind === 'md') return <IconMarkdown className={`size-4 shrink-0 ${tone}`} />

  const Icon = BY_KIND[kind] ?? File
  return <Icon size={16} strokeWidth={1.5} className={`${className ?? ''} ${tone}`} />
}
