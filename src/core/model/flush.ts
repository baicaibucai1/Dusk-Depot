/*
 * 落盘：拿"上次成功写进去的那份"和"现在内存里的这份"比差异，只动变了的东西。
 *
 * 四条不能破的规矩：
 *   ① 只写变了的文件（全量重写会刷掉所有 mtime，也会把大库写卡）
 *   ② 写失败的**不许进基线** —— 否则下次以为它已经存好了，改动永久丢失
 *   ③ 删失败的**要放回基线** —— 否则下次以为它不在了，永远不再尝试删
 *   ④ 顺序：先建目录（文件要往里面写）→ 写 → 删文件 → 删目录（深的先删）
 *
 * ②③ 都不报错，只是安静地不对。所以失败清单原样交回去，由调用方决定基线怎么记。
 */
import type { Host } from '../ports/host'
import { encodeText } from './text'
import type { FileMap } from './library'

/** 仓库在某一刻的样子。文件 + 目录（空目录也要记，否则建了看不见） */
export type Snapshot = { files: FileMap; dirs: string[] }

export type FileChange = { kind: 'write' | 'remove'; path: string }
export type DirChange = { kind: 'mkdir' | 'rmdir'; path: string }
export type Plan = { files: FileChange[]; dirs: DirChange[] }

/** 深/浅：`a/b/c` 是 3 */
const depth = (p: string) => p.split('/').length
const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path, 'zh')

export function diffRepo(before: Snapshot, after: Snapshot): Plan {
  const files: FileChange[] = []
  for (const [path, text] of Object.entries(after.files)) {
    if (before.files[path] !== text) files.push({ kind: 'write', path })
  }
  for (const path of Object.keys(before.files)) {
    if (!(path in after.files)) files.push({ kind: 'remove', path })
  }

  const dirs: DirChange[] = []
  for (const d of after.dirs) {
    if (!before.dirs.includes(d)) dirs.push({ kind: 'mkdir', path: d })
  }
  for (const d of before.dirs) {
    if (!after.dirs.includes(d)) dirs.push({ kind: 'rmdir', path: d })
  }

  // 建目录：浅的在前；删目录：深的在前
  dirs.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'mkdir' ? -1 : 1
    return a.kind === 'mkdir' ? depth(a.path) - depth(b.path) : depth(b.path) - depth(a.path)
  })

  return { files: files.sort(byPath), dirs }
}

export type FlushReport = {
  written: string[]
  removed: string[]
  madeDirs: string[]
  droppedDirs: string[]
  failed: { path: string; message: string }[]
}

export async function flushRepo(host: Host, snap: Snapshot, plan: Plan): Promise<FlushReport> {
  const report: FlushReport = {
    written: [],
    removed: [],
    madeDirs: [],
    droppedDirs: [],
    failed: [],
  }

  const fail = (path: string, e: unknown) =>
    report.failed.push({ path, message: e instanceof Error ? e.message : String(e) })

  // ① 目录：先建（深的文件要往里面写）
  for (const d of plan.dirs) {
    if (d.kind !== 'mkdir') continue
    try {
      await host.mkdir(d.path)
      report.madeDirs.push(d.path)
    } catch (e) {
      fail(d.path, e)
    }
  }

  // ② 写文件
  for (const c of plan.files) {
    if (c.kind !== 'write') continue
    try {
      await host.write(c.path, encodeText(snap.files[c.path] ?? ''))
      report.written.push(c.path)
    } catch (e) {
      fail(c.path, e)
    }
  }

  // ③ 删文件
  for (const c of plan.files) {
    if (c.kind !== 'remove') continue
    try {
      await host.remove(c.path)
      report.removed.push(c.path)
    } catch (e) {
      fail(c.path, e)
    }
  }

  // ④ 删目录（深的先删，否则父目录先没了）
  for (const d of plan.dirs) {
    if (d.kind !== 'rmdir') continue
    try {
      await host.rmdir(d.path)
      report.droppedDirs.push(d.path)
    } catch (e) {
      fail(d.path, e)
    }
  }

  return report
}

/**
 * 基线怎么记：**失败的那条退回到 before 的样子**。
 * 写失败的留在旧值、删失败的恢复条目 —— 下一轮还会再试一次，
 * 而不是安静地认为"已经好了"。
 */
export function settleBaseline(before: Snapshot, after: Snapshot, report: FlushReport): Snapshot {
  const files: FileMap = { ...after.files }
  const dirs = [...after.dirs]

  for (const { path } of report.failed) {
    if (path in before.files) files[path] = before.files[path] ?? ''
    else delete files[path]

    const had = before.dirs.includes(path)
    const has = dirs.includes(path)
    if (had && !has) dirs.push(path)
    if (!had && has) dirs.splice(dirs.indexOf(path), 1)
  }

  return { files, dirs }
}
