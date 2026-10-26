import type { Path } from './path'
import { extOf } from './path'

/** 内存里的一张文件表：路径 → 文本。附件将来是字节，这一版还没有 */
export type FileMap = Record<Path, string>

export type TreeNode = {
  path: Path
  name: string
  kind: 'file' | 'dir'
  children?: TreeNode[]
}

export function isNote(path: Path): boolean {
  return extOf(path).toLowerCase() === '.md'
}

/**
 * 一堆路径 → 一棵树。目录自动从路径里长出来（不需要真的存在一个目录条目），
 * 同级先目录后文件，各自按名字排。
 */
export function buildTree(paths: Path[]): TreeNode[] {
  type Dir = { name: string; path: Path; dirs: Map<string, Dir>; files: TreeNode[] }

  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] }

  for (const p of paths) {
    const segs = p.split('/')
    const file = segs.pop()
    if (!file) continue

    let cur = root
    let prefix = ''
    for (const seg of segs) {
      prefix = prefix ? `${prefix}/${seg}` : seg
      let next = cur.dirs.get(seg)
      if (!next) {
        next = { name: seg, path: prefix, dirs: new Map(), files: [] }
        cur.dirs.set(seg, next)
      }
      cur = next
    }
    cur.files.push({ path: p, name: file, kind: 'file' })
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'zh')

  function flatten(dir: Dir): TreeNode[] {
    const dirs: TreeNode[] = [...dir.dirs.values()]
      .sort(byName)
      .map((d) => ({ path: d.path, name: d.name, kind: 'dir' as const, children: flatten(d) }))
    return [...dirs, ...[...dir.files].sort(byName)]
  }

  return flatten(root)
}

/** 树里所有文件路径，按显示顺序 —— 界面上「有没有下一篇」靠它 */
export function treePaths(nodes: TreeNode[]): Path[] {
  return nodes.flatMap((n) => (n.kind === 'dir' ? treePaths(n.children ?? []) : [n.path]))
}

/**
 * 真仓库给的条目（**含目录**）→ 一棵树。
 *
 * 跟 buildTree 的区别：这条路径认"空目录"。真文件系统里目录本身是一条 entry，
 * 不靠文件路径反推 —— 否则新建的空文件夹会看不见。
 */
export function buildTreeFromEntries(
  entries: { path: Path; kind: 'file' | 'dir' }[],
  /** 越小越靠前。「置顶」靠它：给 pin 的路径一个 0,1,2…，其余给个大数 */
  rank?: (path: Path) => number,
): TreeNode[] {
  type Dir = { name: string; path: Path; dirs: Map<string, Dir>; files: TreeNode[] }
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] }

  const ensure = (path: Path): Dir => {
    let cur = root
    let prefix = ''
    for (const seg of path.split('/')) {
      if (!seg) continue
      prefix = prefix ? `${prefix}/${seg}` : seg
      let next = cur.dirs.get(seg)
      if (!next) {
        next = { name: seg, path: prefix, dirs: new Map(), files: [] }
        cur.dirs.set(seg, next)
      }
      cur = next
    }
    return cur
  }

  for (const e of entries) {
    if (e.kind === 'dir') {
      ensure(e.path)
      continue
    }
    const segs = e.path.split('/')
    const name = segs.pop() ?? e.path
    ensure(segs.join('/')).files.push({ path: e.path, name, kind: 'file' })
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'zh')
  const rankOf = rank ?? (() => 1e9)

  // 先看置顶，再看"目录在前"，最后按名字
  const order = (a: TreeNode, b: TreeNode) => {
    const ra = rankOf(a.path)
    const rb = rankOf(b.path)
    if (ra !== rb) return ra - rb
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return byName(a, b)
  }

  function flatten(dir: Dir): TreeNode[] {
    const nodes: TreeNode[] = [
      ...[...dir.dirs.values()].map((d) => ({
        path: d.path,
        name: d.name,
        kind: 'dir' as const,
        children: flatten(d),
      })),
      ...dir.files,
    ]
    return nodes.sort(order)
  }

  return flatten(root)
}
