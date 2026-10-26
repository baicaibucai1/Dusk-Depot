/*
 * 选仓库、开仓库。三种宿主在这里汇合，上层只认 `Host`。
 *
 * 存下来的只是**引用**（能塞进 localStorage 的那点信息）；FSA 的活句柄在 IndexedDB 里。
 */
import type { Host } from '../core/ports/host'
import { fsaGrant, fsaHandleByName, fsaHost, fsaPermission, hasFsa, pickFsaDir } from './fsa'
import { isTauri, pickTauriDir, tauriDefaultDir, tauriHost } from './tauri'
import { memoryHost } from './memory'

export type RepoRef =
  | { kind: 'tauri'; dir: string }
  | { kind: 'fsa'; name: string }
  | { kind: 'memory' }

const KEY = 'dusk.repo.v1'

export function savedRef(): RepoRef | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as RepoRef
    return v && typeof v === 'object' && 'kind' in v ? v : null
  } catch {
    return null
  }
}

export function saveRef(ref: RepoRef | null): void {
  if (!ref) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, JSON.stringify(ref))
}

/** 这个环境能不能真的挑一个文件夹 */
export function canPickFolder(): boolean {
  return isTauri() || hasFsa()
}

export type Opened = { host: Host; ref: RepoRef }

/** 让用户挑一个文件夹。取消返回 null。**必须在用户手势里调** */
export async function pickRepo(): Promise<Opened | null> {
  if (isTauri()) {
    const dir = await pickTauriDir()
    if (!dir) return null
    return { host: tauriHost(dir), ref: { kind: 'tauri', dir } }
  }
  if (hasFsa()) {
    const handle = await pickFsaDir()
    if (!handle) return null
    return { host: fsaHost(handle), ref: { kind: 'fsa', name: handle.name } }
  }
  return null
}

/** 程序自带的目录。只有桌面端有 */
export async function openDefaultRepo(): Promise<Opened | null> {
  if (!isTauri()) return null
  const dir = await tauriDefaultDir()
  return { host: tauriHost(dir), ref: { kind: 'tauri', dir } }
}

/**
 * 启动时按引用重开。**不抛**，把三种结果分开交给界面：
 *   ready   —— 直接进
 *   gesture —— 句柄还在，但浏览器要求再点一次才给权限（FSA 的硬限制）
 *   fail    —— 真没了，得重新选
 */
export type BootResult =
  | { t: 'ready'; host: Host }
  | { t: 'gesture'; label: string }
  | { t: 'fail'; message: string }

export async function bootOpen(ref: RepoRef): Promise<BootResult> {
  if (ref.kind === 'memory') return { t: 'ready', host: memoryHost() }

  if (ref.kind === 'tauri') {
    return { t: 'ready', host: tauriHost(ref.dir) }
  }

  const handle = await fsaHandleByName(ref.name)
  if (!handle) return { t: 'fail', message: '上次那个文件夹的授权记录没了 —— 重新选一次' }

  const perm = await fsaPermission(handle)
  if (perm === 'granted') return { t: 'ready', host: fsaHost(handle) }
  if (perm === 'denied') return { t: 'fail', message: '这个文件夹的权限被拒绝了 —— 重新选一次' }

  /*
   * 还没授权：先**悄悄试一次**。
   * 如果在站点设置里给过"每次访问都允许"，这里会直接成功 —— 那就一点痕迹都不留地打开。
   * 没给过的浏览器会抛 SecurityError（要有用户手势），落到 gesture 分支，由界面上的
   * 那一下点击补上。
   */
  try {
    if (await fsaGrant(handle)) return { t: 'ready', host: fsaHost(handle) }
  } catch {
    /* 没有用户手势时的正常结果，不当错误 */
  }

  return { t: 'gesture', label: ref.name }
}

/** 续开上一次的仓库。**必须在用户手势里调**（要权限这一步浏览器不让偷偷做） */
export async function resumeRepo(ref: RepoRef): Promise<Host> {
  if (ref.kind === 'memory') return memoryHost()
  if (ref.kind === 'tauri') return tauriHost(ref.dir)

  const handle = await fsaHandleByName(ref.name)
  if (!handle) throw new Error('上次那个文件夹的授权记录没了 —— 重新选一次')
  if (!(await fsaGrant(handle))) throw new Error('没拿到这个文件夹的写权限 —— 重新选一次')
  return fsaHost(handle)
}

/** 兜底：浏览器暂存。**不在磁盘上**，界面必须照实说 */
export function memoryRepo(): Opened {
  return { host: memoryHost(), ref: { kind: 'memory' } }
}

export function describeRef(ref: RepoRef | null): string {
  if (!ref) return '还没选仓库'
  if (ref.kind === 'tauri') return ref.dir
  if (ref.kind === 'fsa') return ref.name
  return '浏览器暂存（不在磁盘上）'
}

/* ─────────────────────────── 已知仓库 ─────────────────────────── */

/*
 * 浏览器没法枚举磁盘上"哪些文件夹里有 .zzq"，所以这里记一份**用过的仓库**。
 *
 * `.zzq` 是仓库的身份标记：第一次把它当仓库打开时补上，之后那个文件夹就认得出自己。
 * 这份清单只是"我打开过它们"的快捷方式，不是真相 —— 条目失效时重新授权或重选即可。
 */
const VAULTS_KEY = 'dusk.vaults.v1'

export type VaultEntry = { label: string; ref: RepoRef }

export function vaultKey(ref: RepoRef): string {
  return JSON.stringify(ref)
}

export function listVaults(): VaultEntry[] {
  try {
    const raw = localStorage.getItem(VAULTS_KEY)
    const v = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(v)) return []
    return v.filter(
      (e): e is VaultEntry =>
        !!e && typeof e === 'object' && typeof (e as VaultEntry).label === 'string' && !!(e as VaultEntry).ref,
    )
  } catch {
    return []
  }
}

/** 记一个仓库（放最前面，同一个仓库不重复，最多留 12 条） */
export function rememberVault(entry: VaultEntry): VaultEntry[] {
  const key = vaultKey(entry.ref)
  const next = [entry, ...listVaults().filter((e) => vaultKey(e.ref) !== key)].slice(0, 12)
  try {
    localStorage.setItem(VAULTS_KEY, JSON.stringify(next))
  } catch {
    /* 配额满了就算了，这只是快捷键 */
  }
  return next
}
