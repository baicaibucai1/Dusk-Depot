/*
 * 书架搬家。
 *
 * ## 为什么要这么麻烦
 *
 * 以前是"从旧目录挨个读、往新目录挨个写"。中途失败（磁盘满、权限被撤、U 盘拔了）
 * 就留下半个书架：新目录有书没清单，用户既不敢用也不敢删；旧目录还是好的，
 * 但界面上已经切过去了。这不是体验问题，是数据安全问题。
 *
 * ## 现在的顺序
 *
 *   ① 探：目标必须存在、可写、**完全空**、不是源目录本身、不跟源目录互相嵌套；
 *   ② 拷：全部先写进目标下的 `.dusk-migrate-<时间戳>/`，不碰目标根目录；
 *   ③ 验：逐个比对大小，清单能解析且书本数量对得上，缺一本都不算成功；
 *   ④ 落：校验通过后才把文件从暂存目录挪到目标根目录；
 *   ⑤ 清：删掉暂存目录；任何一步失败都删掉**本次创建的东西**，目标回到空目录。
 *
 * 旧书架全程只读 —— 失败时它一定还是完整可用的。
 */
import type { Host } from '../ports/host'
import { LIBRARY_FILE, parseLibrary } from './library'
import { type Shelf, type ShelfTarget, openShelfTarget } from './store'

export type PathRelation = 'same' | 'a-in-b' | 'b-in-a' | 'none'

/** 把目录路径归一成可比的形式。Windows 不区分大小写，这里按不区分处理 */
export function normalizeDir(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase()
}

/** 两个绝对目录的关系。用于桌面端"同一个 / 互相嵌套"检查 */
export function dirRelation(a: string, b: string): PathRelation {
  const x = normalizeDir(a)
  const y = normalizeDir(b)
  if (!x || !y) return 'none'
  if (x === y) return 'same'
  if (x.startsWith(`${y}/`)) return 'a-in-b'
  if (y.startsWith(`${x}/`)) return 'b-in-a'
  return 'none'
}

export type TargetInspection = {
  ok: boolean
  /** 打不开 / 不可写 / 非空 / 与源目录冲突 */
  error?: string
  relation: PathRelation
  empty: boolean
  files: number
  dirs: number
  hasLibrary: boolean
  writable: boolean
}

/** 目标目录能不能用来搬家。**只读探测**，唯一会写的是一个立刻删掉的探针文件 */
export async function inspectTarget(src: Shelf, target: ShelfTarget): Promise<TargetInspection> {
  const base: TargetInspection = {
    ok: false,
    relation: 'none',
    empty: false,
    files: 0,
    dirs: 0,
    hasLibrary: false,
    writable: false,
  }

  if (src.kind === 'tauri' && target.cfg.kind === 'tauri') {
    base.relation = dirRelation(src.where, target.cfg.dir)
    if (base.relation !== 'none') {
      return {
        ...base,
        error:
          base.relation === 'same'
            ? '新位置就是当前书架，换了个寂寞'
            : '新位置和当前书架互相嵌套，搬过去会把自己套进去',
      }
    }
  } else if (src.kind === 'fsa' && target.cfg.kind === 'fsa' && src.handle && target.handle) {
    base.relation = await fsaRelation(src.handle, target.handle)
    if (base.relation !== 'none') {
      return {
        ...base,
        error: base.relation === 'same' ? '新位置就是当前书架' : '新位置和当前书架互相嵌套',
      }
    }
  }

  const opened = await openShelfTarget(target)
  if (!opened.ok) return { ...base, error: opened.error }

  let entries: Awaited<ReturnType<Host['list']>>
  try {
    entries = await opened.shelf.host.list()
  } catch (e) {
    return { ...base, error: `读不了目标目录：${String(e)}` }
  }
  const files = entries.filter((e) => e.kind === 'file')
  const dirs = entries.filter((e) => e.kind === 'dir')

  const probe = `.dusk-write-probe-${Date.now().toString(36)}`
  let writable = true
  try {
    await opened.shelf.host.write(probe, new Uint8Array([0x6f, 0x6b]))
    await opened.shelf.host.remove(probe)
  } catch {
    writable = false
    await opened.shelf.host.remove(probe).catch(() => {})
  }

  return {
    ok: writable,
    error: writable ? undefined : '目标目录写不进去（权限被拒或磁盘只读）',
    relation: base.relation,
    empty: entries.length === 0,
    files: files.length,
    dirs: dirs.length,
    hasLibrary: files.some((f) => f.path === LIBRARY_FILE),
    writable,
  }
}

async function fsaRelation(a: NonNullable<Shelf['handle']>, b: NonNullable<Shelf['handle']>): Promise<PathRelation> {
  try {
    if (a.isSameEntry && (await a.isSameEntry(b))) return 'same'
    if (a.resolve) {
      const inside = await a.resolve(b)
      if (inside) return 'a-in-b'
    }
    if (b.resolve) {
      const inside = await b.resolve(a)
      if (inside) return 'b-in-a'
    }
  } catch {
    /* 浏览器没实现就退化成"不知道" */
  }
  return 'none'
}

export type MoveProgress = {
  phase: 'copy' | 'verify' | 'commit' | 'clean'
  done: number
  total: number
  current: string
}

export type MoveResult = { files: number; bytes: number; mode: 'move' | 'use' }

/** 目标不空时的可读拒绝。调用方在弹窗里给"使用已有 / 取消"，不给"搬迁" */
export function moveBlockedReason(info: TargetInspection): string | null {
  if (info.error) return info.error
  if (!info.empty) {
    return info.hasLibrary
      ? '目标目录已经有一份书架，只能用目标书架或取消；搬迁会覆盖它'
      : '目标目录不是空的（目录里还有子目录/文件也算），搬迁需要空目录'
  }
  return null
}

/**
 * 搬迁：类型上就不允许"覆盖"。`target` 必须是空的且与源目录无关。
 *
 * 成功返回 { mode: 'move' }；失败抛出人话，并保证目标目录回到空状态、旧书架原样。
 */
export async function moveShelfTo(
  src: Shelf,
  target: ShelfTarget,
  onProgress?: (p: MoveProgress) => void,
): Promise<MoveResult> {
  const info = await inspectTarget(src, target)
  const blocked = moveBlockedReason(info)
  if (blocked) throw new Error(blocked)
  if (info.relation !== 'none') throw new Error('新位置和当前书架是同一个或互相嵌套')

  const opened = await openShelfTarget(target)
  if (!opened.ok) throw new Error(opened.error)

  const out = await copyShelfStaged(src.host, opened.shelf.host, onProgress)
  return { ...out, mode: 'move' }
}

/**
 * 复制 → 校验 → 落位（目标宿主可以单独测）。
 *
 * 目标必须是空的；本函数**不检查**这件事（`inspectTarget` 已经查过），
 * 但每一步写入前仍会检查同名文件，绝不覆盖。
 */
export async function copyShelfStaged(
  src: Host,
  dst: Host,
  onProgress?: (p: MoveProgress) => void,
): Promise<{ files: number; bytes: number }> {
  const entries = await src.list()
  const files = entries.filter((e) => e.kind === 'file')
  const tmp = `.dusk-migrate-${Date.now().toString(36)}`

  /** 目标根目录里由本次创建的文件（失败时只删这些） */
  const placed: string[] = []
  let bytes = 0

  try {
    await dst.mkdir(tmp)
    onProgress?.({ phase: 'copy', done: 0, total: files.length, current: '' })

    for (let i = 0; i < files.length; i++) {
      const f = files[i] as (typeof files)[number]
      onProgress?.({ phase: 'copy', done: i, total: files.length, current: f.path })
      if (!safeRelative(f.path)) throw new Error(`源目录里有不安全的路径：${f.path}`)
      const data = await src.read(f.path)
      bytes += data.length
      await dst.write(`${tmp}/${f.path}`, data)
      onProgress?.({ phase: 'copy', done: i + 1, total: files.length, current: f.path })
    }

    onProgress?.({ phase: 'verify', done: 0, total: files.length, current: '' })
    for (let i = 0; i < files.length; i++) {
      const f = files[i] as (typeof files)[number]
      onProgress?.({ phase: 'verify', done: i, total: files.length, current: f.path })
      await verifyOne(src, dst, f.path, `${tmp}/${f.path}`)
    }

    await verifyLibrary(src, dst, tmp)

    onProgress?.({ phase: 'commit', done: 0, total: files.length, current: '' })
    for (let i = 0; i < files.length; i++) {
      const f = files[i] as (typeof files)[number]
      onProgress?.({ phase: 'commit', done: i, total: files.length, current: f.path })
      if (await dst.exists?.(f.path)) {
        throw new Error(`目标里突然出现了同名文件：${f.path}（不会覆盖）`)
      }
      await moveWithin(dst, `${tmp}/${f.path}`, f.path)
      placed.push(f.path)
    }

    onProgress?.({ phase: 'clean', done: 0, total: 0, current: '' })
    await dst.rmdir(tmp)
    return { files: files.length, bytes }
  } catch (e) {
    // 只清本次产物：先删已经落位的，再删暂存目录
    for (const p of placed) await dst.remove(p).catch(() => {})
    await dst.rmdir(tmp).catch(() => {})
    throw e
  }
}

/** 相对路径不允许 `..` / 绝对路径 / 反斜杠（和 Rust 的 join 同一套规矩） */
export function safeRelative(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes(':')) return false
  return !p.split('/').some((seg) => seg === '..' || seg === '')
}

async function verifyOne(src: Host, dst: Host, path: string, copied: string): Promise<void> {
  const a = await src.stat?.(path).catch(() => null)
  const b = await dst.stat?.(copied).catch(() => null)
  if (a && b) {
    if (a.size !== b.size) throw new Error(`复制不完整：${path}（源 ${a.size} 字节，新 ${b.size} 字节）`)
    return
  }
  // 宿主不给 stat 就只能读回来比长度
  const [x, y] = await Promise.all([src.read(path), dst.read(copied)])
  if (x.length !== y.length) throw new Error(`复制不完整：${path}（${x.length} ≠ ${y.length} 字节）`)
}

async function verifyLibrary(src: Host, dst: Host, tmp: string): Promise<void> {
  let raw: string
  try {
    raw = new TextDecoder('utf-8').decode(await src.read(LIBRARY_FILE))
  } catch {
    return // 源目录没有清单：不算搬家的错
  }
  const parsed = parseLibrary(raw)
  if (!parsed.ok) return // 源清单本来就坏：搬运不负责修它，boot 会重建

  const copyRaw = new TextDecoder('utf-8').decode(await dst.read(`${tmp}/${LIBRARY_FILE}`))
  const copy = parseLibrary(copyRaw)
  if (!copy.ok) throw new Error('复制后的书架清单解析不了')
  if (copy.library.books.length !== parsed.library.books.length) {
    throw new Error(
      `复制后的书目数量对不上（原 ${parsed.library.books.length}，新 ${copy.library.books.length}）`,
    )
  }
  const ids = new Set(copy.library.books.map((b) => b.id))
  for (const b of parsed.library.books) {
    if (!ids.has(b.id)) throw new Error(`复制后缺了这本书的索引：${b.title}`)
  }
  for (const b of copy.library.books) {
    if (b.trashedAt) continue
    if (dst.exists && !(await dst.exists(`${tmp}/${b.file}`))) {
      throw new Error(`复制后缺了这本书的文件：${b.file}`)
    }
  }
}

/**
 * 宿主内搬一个文件。
 * 桌面端有原子 rename；浏览器只能读出来、写新的、删旧的（顺序保证不丢：先写后删）。
 */
export async function moveWithin(host: Host, from: string, to: string): Promise<void> {
  if (host.move) {
    await host.move(from, to)
    return
  }
  if (await host.exists?.(to)) throw new Error(`目标已存在：${to}`)
  const bytes = await host.read(from)
  await host.write(to, bytes)
  await host.remove(from)
}
