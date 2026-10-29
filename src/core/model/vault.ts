/*
 * 仓库标记文件 `.zzq`：**这个仓库的元数据账本**。
 *
 * 有些东西笔记文件本身装不下 —— 置顶、收藏、别名、颜色，以及以后那些
 * "程序需要但不是正文"的属性。它们不能塞进 .md（那会污染正文，也违反
 * "笔记是普通 markdown，别的工具照样能读"），也不该只存在浏览器里
 * （换台机器就没了，而且仓库就不自洽了）。所以统一收进这一个文件，跟着仓库走。
 *
 * ## 形状为什么长这样
 *
 *   pins   有**顺序**，所以是数组（谁置顶在前面对用户可见）
 *   files  按路径挂**每份文件的属性**，是个对象 —— 以后加字段不用改结构，
 *          也不会因为"某个文件有某属性"就多出一个顶层键
 *
 * 新增一类元数据时：能按路径挂的就进 `files[path]`，需要全局顺序的才加顶层数组。
 *
 * ## 四条规矩
 *
 *   ① 它**不是笔记**：不进列表、不进文件表、不参与 diff、绝不被删
 *   ② 它是**可丢的**：坏了就当空的，不拦着应用启动
 *   ③ 写回时**保留不认识的字段** —— 别把别的版本（或别的工具）写进去的东西冲掉
 *   ④ 只放**跟着仓库走才有意义**的东西。展开/折叠、光标位置这类纯本机 UI 状态
 *      留在 localStorage —— 它们写进来会让这个文件每次操作都变大
 */
import { isHidden } from './path'

export const VAULT_MARK = '.zzq'
export const VAULT_APP = 'dusk-depot'
export const VAULT_VERSION = 2

/** 挂在单个文件上的属性。加字段直接加，不用动结构 */
export type FileMeta = {
  /** 收藏。跟置顶是两件事：置顶改顺序，收藏是个集合 */
  starred?: boolean
  /** 显示用的别名（文件名不动） */
  alias?: string
  /**
   * 自定义图标：一个 emoji 字符（`.zzq` 里存 `"icon": "🚀"`）。
   * 存字符而不是图片路径 —— 换机器、换程序都还能认，而且一行就删得掉。
   */
  icon?: string
  [key: string]: unknown
}

export type VaultMeta = {
  app: string
  version: number
  /** 置顶的路径，靠前的排在上面 */
  pins: string[]
  files: Record<string, FileMeta>
  /** 别的版本 / 别的工具写进来的字段，原样留着 */
  [key: string]: unknown
}

export function emptyMeta(): VaultMeta {
  return { app: VAULT_APP, version: VAULT_VERSION, pins: [], files: {} }
}

const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : []

/** 解不开就当空的 —— 一个坏文件不该让整个库打不开 */
export function parseVault(text: string): VaultMeta {
  if (!text.trim()) return emptyMeta()

  try {
    const raw = JSON.parse(text) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyMeta()
    const o = raw as Record<string, unknown>

    const filesRaw =
      o.files && typeof o.files === 'object' && !Array.isArray(o.files)
        ? (o.files as Record<string, unknown>)
        : {}
    const files: Record<string, FileMeta> = {}
    for (const [p, v] of Object.entries(filesRaw)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) files[p] = v as FileMeta
    }

    // v1 把收藏写成顶层数组 `starred: []`，折进 files 里
    for (const p of strings(o.starred)) files[p] = { ...files[p], starred: true }

    const { starred: _legacy, ...rest } = o
    return {
      ...rest,
      app: typeof o.app === 'string' ? o.app : VAULT_APP,
      version: typeof o.version === 'number' ? o.version : VAULT_VERSION,
      pins: strings(o.pins),
      files,
    } as VaultMeta
  } catch {
    return emptyMeta()
  }
}

export function serializeVault(meta: VaultMeta): string {
  const out: Record<string, unknown> = {
    ...meta,
    app: VAULT_APP,
    version: VAULT_VERSION,
    pins: meta.pins,
    files: meta.files,
  }
  // 老字段不再写出去
  delete out.starred
  return `${JSON.stringify(out, null, 2)}\n`
}

/* ───────────────── 小工具：免得每个功能各手搓一次 ───────────────── */

export function getFileMeta(meta: VaultMeta, path: string): FileMeta {
  return meta.files[path] ?? {}
}

export function setFileMeta(meta: VaultMeta, path: string, patch: FileMeta): VaultMeta {
  return { ...meta, files: { ...meta.files, [path]: { ...getFileMeta(meta, path), ...patch } } }
}

/** 删掉某个前缀下的全部元数据（删文件夹时要连整棵子树一起清） */
export function pruneMeta(meta: VaultMeta, removed: string[]): VaultMeta {
  const under = (p: string) => removed.some((d) => p === d || p.startsWith(`${d}/`))
  const files: Record<string, FileMeta> = {}
  for (const [p, v] of Object.entries(meta.files)) if (!under(p)) files[p] = v
  return { ...meta, pins: meta.pins.filter((p) => !under(p)), files }
}

/* ── 自定义图标 ──
 * 放在 files[path].icon 里，跟着 `.zzq` 走 —— 换台机器、换个人打开都还是那个图标。
 * 空字符串 = 没有图标（写回时把键删掉，别在文件里留一堆 `"icon": ""`）。
 */

/** 所有设过图标的路径 → 字符。树渲染用它，一次取完别每行查一遍 */
export function iconsOf(meta: VaultMeta): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [p, v] of Object.entries(meta.files)) {
    if (typeof v.icon === 'string' && v.icon.trim()) out[p] = v.icon.trim()
  }
  return out
}

/** 设置 / 清除某个路径的图标。传空字符串就是清除 */
export function setIcon(meta: VaultMeta, path: string, icon: string): VaultMeta {
  const cur = { ...getFileMeta(meta, path) }
  const ch = icon.trim()
  if (ch) cur.icon = ch
  else delete cur.icon

  const files = { ...meta.files }
  // 清完没别的属性了就把整条删掉，保持 .zzq 干净
  if (Object.keys(cur).length === 0) delete files[path]
  else files[path] = cur
  return { ...meta, files }
}

/** 保留路径：标记文件本身，或它所在的任意层级 */
export function isReserved(path: string): boolean {
  return path.split('/').some((seg) => seg === VAULT_MARK)
}

/** 文件树该不该列这一条 */
export function isListable(path: string): boolean {
  return !isReserved(path) && !isHidden(path)
}
