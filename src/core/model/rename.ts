/*
 * 改名 / 搬家 / 删除。
 *
 * 这三件事底下其实是同一件事：**把一个路径前缀换成另一个**。
 * 所以目录改名（整棵子树跟着换）、把文件拖进别的目录，走的是同一段 `remap`。
 *
 * 改名是这个应用里**唯一会动到别的文件**的操作 —— 全库指向它的 `[[链接]]` 必须跟着改，
 * 而且**保形**：`[[旧名#小节|显示]]` 改完还得是 `[[新名#小节|显示]]`。
 * 不改的话链接会成片断掉，而且不报错，只是右栏的反链悄悄少了。
 */
import type { FileMap } from './library'
import { extOf, parentOf } from './path'
import { sanitizeName, withSameExt } from './note'

export type Move = { from: string; to: string }

export type EditOk = {
  ok: true
  to: string
  moved: Move[]
  files: FileMap
  dirs: string[]
  /** 有几处链接跟着改了 */
  links: number
  /** 它自己的正文标题动没动 */
  retitled: boolean
}

export type EditResult = EditOk | { ok: false; error: string }

/** 路径是不是在某个目录底下（含它自己） */
export function underPrefix(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`)
}

/** 这个路径底下有没有东西 —— 有就是目录 */
export function hasChildren(files: FileMap, dirs: string[], path: string): boolean {
  const prefix = `${path}/`
  return (
    Object.keys(files).some((f) => f.startsWith(prefix)) || dirs.some((d) => d.startsWith(prefix))
  )
}

function isDirPath(files: FileMap, dirs: string[], path: string): boolean {
  return dirs.includes(path) || hasChildren(files, dirs, path)
}

/** 整个前缀搬家；文件表与目录表同步换 */
function remap(files: FileMap, dirs: string[], from: string, to: string) {
  const moved: Move[] = []
  const nextFiles: FileMap = {}

  for (const [p, text] of Object.entries(files)) {
    if (underPrefix(p, from)) {
      const q = to + p.slice(from.length)
      nextFiles[q] = text
      moved.push({ from: p, to: q })
    } else {
      nextFiles[p] = text
    }
  }

  const nextDirs = dirs.map((d) => {
    if (underPrefix(d, from)) {
      const q = to + d.slice(from.length)
      moved.push({ from: d, to: q })
      return q
    }
    return d
  })

  return { files: nextFiles, dirs: nextDirs, moved }
}

const fullStem = (p: string) => (extOf(p) ? p.slice(0, p.length - extOf(p).length) : p)
const bareName = (p: string) => {
  const full = fullStem(p)
  const i = full.lastIndexOf('/')
  return i < 0 ? full : full.slice(i + 1)
}

/**
 * 改写表：每条搬家记录贡献**全路径**与**裸名**两种写法。
 * 名字没变的那种（纯搬家）新旧相同，会被跳掉 —— 否则界面会虚报"改了几处引用"。
 */
function buildMap(moved: Move[]): Map<string, string> {
  const map = new Map<string, string>()

  for (const m of moved) {
    if (extOf(m.from).toLowerCase() !== '.md' || extOf(m.to).toLowerCase() !== '.md') continue
    map.set(fullStem(m.from), fullStem(m.to))
    map.set(bareName(m.from), bareName(m.to))
  }

  for (const [k, v] of map) if (k === v) map.delete(k)
  return map
}

const WIKI = /\[\[([^\]|#]+)((?:[#|][^\]]*)?)\]\]/g

/** 保形改写：`[[旧#小节|显示]]` → `[[新#小节|显示]]` */
export function retargetLinks(text: string, map: Map<string, string>): { text: string; count: number } {
  let count = 0

  // 1) 旧的双链：`[[旧#小节|显示]]` → `[[新#小节|显示]]`
  const out = text.replace(WIKI, (whole, target: string, suffix: string) => {
    const to = map.get(target.trim())
    if (!to) return whole
    count += 1
    return `[[${to}${suffix}]]`
  })

  // 2) 标准链接：`](旧路径.md)` → `](新路径.md)`
  const rewritten = out.replace(/\]\(([^)\s]+)\)/g, (whole, href: string) => {
    const clean = href.replace(/^\.\//, '')
    const hasMd = /\.md$/i.test(clean)
    const stem = hasMd ? clean.slice(0, -3) : clean
    const bare = stem.slice(stem.lastIndexOf('/') + 1)
    const to = map.get(stem) ?? map.get(bare)
    if (!to) return whole
    count += 1
    return `](${to}${hasMd ? '.md' : ''})`
  })

  return { text: rewritten, count }
}

/**
 * 正文第一行的标题跟着改 —— **只在逐字等于旧名时才动**。
 * 你自己起的小标题不碰。
 */
export function retitleBody(text: string, from: string, to: string): { text: string; changed: boolean } {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.trim().length > 0)
  if (i < 0) return { text, changed: false }

  const m = /^#\s+(.*)$/.exec(lines[i] ?? '')
  if (!m || (m[1] ?? '').trim() !== from) return { text, changed: false }

  lines[i] = `# ${to}`
  return { text: lines.join('\n'), changed: true }
}

function rewriteRefs(
  files: FileMap,
  moved: Move[],
  renamed: { from: string; to: string } | null,
): { files: FileMap; links: number; retitled: boolean } {
  const map = buildMap(moved)
  const next: FileMap = { ...files }
  let links = 0

  if (map.size > 0) {
    for (const [p, text] of Object.entries(next)) {
      const hit = retargetLinks(text, map)
      if (hit.count > 0) {
        next[p] = hit.text
        links += hit.count
      }
    }
  }

  let retitled = false
  if (renamed && extOf(renamed.to).toLowerCase() === '.md') {
    const body = next[renamed.to] ?? ''
    const from = fullStem(renamed.from).slice(fullStem(renamed.from).lastIndexOf('/') + 1)
    const to = fullStem(renamed.to).slice(fullStem(renamed.to).lastIndexOf('/') + 1)
    const t = retitleBody(body, from, to)
    if (t.changed) {
      next[renamed.to] = t.text
      retitled = true
    }
  }

  return { files: next, links, retitled }
}

/** 改名。文件就改文件名，目录就连整棵子树换前缀。 */
export function renameEntry(
  files: FileMap,
  dirs: string[],
  path: string,
  rawName: string,
): EditResult {
  const isDir = isDirPath(files, dirs, path)
  const name = isDir ? sanitizeName(rawName) : withSameExt(rawName, path)

  if (!name) return { ok: false, error: '名字不能为空' }

  const to = path.includes('/') ? `${parentOf(path)}/${name}` : name
  if (to === path) return { ok: true, to, moved: [], files, dirs, links: 0, retitled: false }

  if (files[to] !== undefined || dirs.includes(to)) {
    return { ok: false, error: `「${name}」已经存在了` }
  }

  // 改名不能把一个目录塞进它自己的后代里
  if (isDir && underPrefix(to, path)) {
    return { ok: false, error: '不能把一个文件夹改成它自己的子目录' }
  }

  const r = remap(files, dirs, path, to)
  const w = rewriteRefs(r.files, r.moved, { from: path, to })

  return {
    ok: true,
    to,
    moved: r.moved,
    files: w.files,
    dirs: r.dirs,
    links: w.links,
    retitled: w.retitled,
  }
}

/** 搬家：名字不变，只换父目录。`destDir` 空串表示根目录 */
export function moveEntry(
  files: FileMap,
  dirs: string[],
  path: string,
  destDir: string,
): EditResult {
  const from = parentOf(path)
  if (destDir === from) return { ok: true, to: path, moved: [], files, dirs, links: 0, retitled: false }

  const name = path.slice(path.lastIndexOf('/') + 1)
  const to = destDir ? `${destDir}/${name}` : name

  // 拖进自己里面 = 把前缀替换绕成一个环
  if (destDir === path || destDir.startsWith(`${path}/`)) {
    return { ok: false, error: '不能把文件夹拖进它自己里面' }
  }
  if (files[to] !== undefined || dirs.includes(to)) {
    return { ok: false, error: `目标位置已经有「${name}」了` }
  }

  const r = remap(files, dirs, path, to)
  // 纯搬家时裸名不变，改写表里那一档会被跳掉；全路径那档照改
  const w = rewriteRefs(r.files, r.moved, null)

  const nextDirs = destDir && !r.dirs.includes(destDir) ? [...r.dirs, destDir] : r.dirs

  return {
    ok: true,
    to,
    moved: r.moved,
    files: w.files,
    dirs: nextDirs,
    links: w.links,
    retitled: false,
  }
}

/** 删除：文件删一条，目录连整棵子树一起删 */
export function deleteEntry(
  files: FileMap,
  dirs: string[],
  path: string,
): { files: FileMap; dirs: string[]; removed: string[] } {
  const removed: string[] = []
  const nextFiles: FileMap = {}

  for (const [p, text] of Object.entries(files)) {
    if (underPrefix(p, path)) removed.push(p)
    else nextFiles[p] = text
  }

  const nextDirs = dirs.filter((d) => {
    if (underPrefix(d, path)) {
      removed.push(d)
      return false
    }
    return true
  })

  return { files: nextFiles, dirs: nextDirs, removed }
}
