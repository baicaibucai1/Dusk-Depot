import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Snapshot } from './core/model/flush'
import { diffRepo, flushRepo, settleBaseline } from './core/model/flush'
import type { FileMap } from './core/model/library'
import { buildTreeFromEntries, isNote } from './core/model/library'
import { docFiles, emptyDoc, isNoteDocPath } from './core/note/format'
import { folderPath, notePath, sanitizeName, uniquePath } from './core/model/note'
import { parentOf, stemOf } from './core/model/path'
import { deleteEntry, moveEntry, renameEntry, type EditOk } from './core/model/rename'
import { resolvePath, resolveWiki, titleOf, wikiSection } from './core/markdown/links'
import { decodeBytes, encodeText } from './core/model/text'
import {
  isListable,
  parseVault,
  pruneMeta,
  serializeVault,
  VAULT_MARK,
  type FileMeta,
  type VaultMeta,
} from './core/model/vault'
import type { Host } from './core/ports/host'
import type { RepoRef } from './hosts'
import {
  bootOpen,
  canPickFolder,
  describeRef,
  listVaults,
  memoryRepo,
  openDefaultRepo,
  pickRepo,
  rememberVault,
  resumeRepo,
  saveRef,
  savedRef,
  vaultKey,
  type VaultEntry,
} from './hosts'
import { memoryIsEmpty, memorySeed } from './hosts/memory'
import { isTauri } from './hosts/tauri'
import { Aside } from './ui/Aside'
import { SettingsDialog } from './ui/SettingsDialog'
import { applySettings, loadSettings, resetSettings, saveSettings, type Settings } from './ui/settings'
import { DocPane } from './ui/DocPane'
import { Rail, type Section } from './ui/Rail'
import { RepoGate } from './ui/RepoGate'
import { PaneDivider } from './ui/PaneDivider'
import { Resizer } from './ui/Resizer'
import { TreePanel } from './ui/TreePanel'
import { SEED } from './ui/demo'

/*
 * 四列：功能轨 → 目录栏 → 正文 → 旁注栏。
 *
 * 仓库是用户自己挑的一个文件夹（ports/host.ts）。三种宿主共用同一份 core。
 *
 * 落盘只写差异（core/model/flush.ts），并且记一条硬规矩：
 * **失败的那条不许进基线** —— 否则下次以为它已经存好了。
 */

type Phase =
  | { t: 'booting' }
  /** pending = 上次那个仓库还记得，只是浏览器要再点一下 */
  | { t: 'gate'; error: string | null; pending: { ref: RepoRef; label: string } | null }
  | { t: 'ready'; host: Host; ref: RepoRef }

export type SaveState = 'clean' | 'dirty' | 'saving' | 'error'

/** 一个分栏：自己的一套标签，自己的当前文档 */
type PaneState = { id: number; tabs: string[]; active: string | null }

const MAX_PANES = 3

/** 单个文件上限：仓库里躺着一个 200MB 的 zip 时不该把它读进内存 */
const MAX_FILE = 8 * 1024 * 1024

function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  return String(e)
}

/** 读取期间盖一层：文件多的时候不能让人以为"点了没反应" */
function Working({ text }: { text: string }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-paper/85">
      <p className="text-[13px] text-ink-2">{text}</p>
    </div>
  )
}

function allDirs(nodes: ReturnType<typeof buildTreeFromEntries>): string[] {
  return nodes.flatMap((n) => (n.kind === 'dir' ? [n.path, ...allDirs(n.children ?? [])] : []))
}

/** `.zzq` 里写的东西：一眼能看出这是谁的标记 */
async function readRepo(
  host: Host,
): Promise<Snapshot & { hasMark: boolean; notes: string[] }> {
  const entries = await host.list()

  /*
   * `.note` 是"目录即文档"：整个目录算**一篇**，里面的块文件不单独露出来。
   * 所以先把这些根挑出来，再把它底下的条目全部过滤掉。
   */
  const noteRoots = entries
    .filter((e) => e.kind === 'dir' && isNoteDocPath(e.path) && isListable(e.path))
    .map((e) => e.path)
  const underNote = (p: string) => noteRoots.some((root) => p === root || p.startsWith(`${root}/`))

  // 只收 md 和目录；点开头的和仓库标记 `.zzq` 都不进列表
  const keep = entries.filter((e) => {
    if (underNote(e.path)) return false
    return e.kind === 'dir' ? isListable(e.path) : isNote(e.path) && isListable(e.path)
  })

  const files: FileMap = {}
  for (const e of keep) {
    if (e.kind !== 'file') continue
    try {
      // 体积上限在这里按字节判断 —— 宿主的 list() 为了速度不 stat 文件
      const bytes = await host.read(e.path)
      if (bytes.length > MAX_FILE) continue
      files[e.path] = decodeBytes(bytes)
    } catch {
      // 单篇读不出来就跳过：一个坏文件不该让整个库打不开，而且**不删它**
    }
  }

  return {
    files,
    dirs: keep.filter((e) => e.kind === 'dir').map((e) => e.path),
    hasMark: entries.some((e) => e.path === VAULT_MARK),
    notes: noteRoots,
  }
}

/** 打开暂存仓库。空的就先塞一份出厂笔记，免得第一次打开是一片空白 */
async function openMemoryRepo() {
  const m = memoryRepo()
  saveRef(m.ref)
  if (memoryIsEmpty()) memorySeed(SEED)
  return m
}

/* 两侧边栏宽度的上下限与出厂值 */
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 520
const SIDEBAR_DEFAULT = { L: 268, R: 288 }
const WIDTH_KEY = 'dusk.widths.v1'

function readWidths(): { L: number; R: number } {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    const v = raw ? (JSON.parse(raw) as { L?: number; R?: number }) : {}
    const clamp = (n: unknown, fallback: number) =>
      typeof n === 'number' && Number.isFinite(n)
        ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(n)))
        : fallback
    return { L: clamp(v.L, SIDEBAR_DEFAULT.L), R: clamp(v.R, SIDEBAR_DEFAULT.R) }
  } catch {
    return { ...SIDEBAR_DEFAULT }
  }
}

export function App() {
  const [phase, setPhase] = useState<Phase>({ t: 'booting' })
  const [files, setFiles] = useState<FileMap>({})
  const [dirs, setDirs] = useState<string[]>([])
  /** `.note` 目录（目录即文档，树里当叶子显示） */
  const [noteDocs, setNoteDocs] = useState<string[]>([])
  /** 分栏：每栏有自己的标签与当前文档，最多 3 栏 */

  const [panes, setPanes] = useState<PaneState[]>(() => [{ id: 1, tabs: [], active: null }])
  /** 焦点栏 —— 左栏点文件时开在它里面 */
  const [focused, setFocused] = useState(0)
  /** 每栏的宽度比例（flex-grow）：窗口变宽时几栏一起按比例长 */
  const [sizes, setSizes] = useState<number[]>([1])
  const paneSeq = useRef(1)
  const sizeAtStart = useRef<number[]>([1])
  const paneBox = useRef<HTMLDivElement | null>(null)

  const focusedPane = panes[focused] ?? panes[0]
  const current = focusedPane?.active ?? null
  /** 最右边那一栏的文档：右栏大纲认它，不认焦点 */
  const lastDoc = panes[panes.length - 1]?.active ?? null

  /** `.note` 的大纲与正文（块编辑器上报，右栏要用） */
  const [noteInfo, setNoteInfo] = useState<
    Record<string, { outline: { level: number; text: string }[]; text: string }>
  >({})

  /** 右栏反链用的文件表：md 原文 + 各 .note 上报的正文 */
  const asideFiles = useMemo(() => {
    const merged: FileMap = { ...files }
    for (const [dir, info] of Object.entries(noteInfo)) merged[dir] = info.text
    return merged
  }, [files, noteInfo])


  const [leftW, setLeftW] = useState(() => readWidths().L)
  const [rightW, setRightW] = useState(() => readWidths().R)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [asideOpen, setAsideOpen] = useState(true)

  /** 渲染个性化：字号/行距/段距/宽度/字体。存本地，应用时写成根节点的 CSS 变量 */
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 打开 `[[某篇#小节]]` 之后要滚到的小节 */
  const [anchor, setAnchor] = useState<string | null>(null)

  useEffect(() => {
    applySettings(settings)
    saveSettings(settings)
  }, [settings])
  const [section, setSection] = useState<Section>('notes')
  const [save, setSave] = useState<SaveState>('clean')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pins, setPins] = useState<string[]>([])
  /** 上次读到的 `.zzq` 原文。写回时以它为底合并，别把不认识的字段冲掉 */
  const vaultRaw = useRef('')
  const [gateBusy, setGateBusy] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [vaults, setVaults] = useState<VaultEntry[]>(() => listVaults())

  const baseline = useRef<Snapshot>({ files: {}, dirs: [] })
  const timer = useRef<number | null>(null)
  const booted = useRef(false)

  const tree = useMemo(
    () =>
      buildTreeFromEntries(
        [
          ...dirs.map((d) => ({ path: d, kind: 'dir' as const })),
          ...Object.keys(files).map((f) => ({ path: f, kind: 'file' as const })),
          ...noteDocs.map((n) => ({ path: n, kind: 'file' as const })),
        ],
        // 置顶的按加入顺序排在最前，其余给个大数
        (p) => {
          const i = pins.indexOf(p)
          return i < 0 ? 1e9 : i
        },
      ),
    [dirs, files, pins, noteDocs],
  )

  const adopt = useCallback(async (host: Host, ref: RepoRef) => {
    setWorking(`正在读取 ${host.label}…`)
    try {
      const loaded = await readRepo(host)
      const snap: Snapshot = { files: loaded.files, dirs: loaded.dirs }
      baseline.current = snap
      setFiles(loaded.files)
      setDirs(loaded.dirs)
      setNoteDocs(loaded.notes)
      setExpanded(
        new Set(
          allDirs(
            buildTreeFromEntries([
              ...loaded.dirs.map((d) => ({ path: d, kind: 'dir' as const })),
              ...Object.keys(loaded.files).map((f) => ({ path: f, kind: 'file' as const })),
            ]),
          ),
        ),
      )
      const first = Object.keys(loaded.files).sort((a, b) => a.localeCompare(b, 'zh'))[0] ?? null
      // 重开仓库 = 回到单栏单页
      paneSeq.current = 1
      setPanes([{ id: 1, tabs: first ? [first] : [], active: first }])
      setSizes([1])
      setFocused(0)
      setSave('clean')
      setSaveError(null)

      /*
       * 元数据账本（`.zzq`）：置顶 / 收藏这些笔记文件本身装不下的东西。
       * 它跟着仓库走，不是跟着浏览器走 —— 换台机器、换个浏览器，置顶还在。
       */
      let raw = ''
      if (loaded.hasMark) {
        try {
          raw = decodeBytes(await host.read(VAULT_MARK))
        } catch {
          raw = ''
        }
      }
      const meta = parseVault(raw)
      vaultRaw.current = raw
      setPins(meta.pins)

      // 第一次把这个文件夹当仓库用：把账本建出来
      if (!loaded.hasMark) {
        const text = serializeVault(meta)
        try {
          await host.write(VAULT_MARK, encodeText(text))
          vaultRaw.current = text
        } catch (e) {
          console.warn('[dusk] 写不了仓库标记 .zzq', e)
        }
      }

      setPhase({ t: 'ready', host, ref })
      setVaults(rememberVault({ label: describeRef(ref), ref }))
    } finally {
      setWorking(null)
    }
  }, [])

  // 启动：存过引用就重开。**打不开就出引导页并说原因，绝不自动降级成空库**
  useEffect(() => {
    // ⚠️ StrictMode 会把挂载 effect 跑两遍。启动是有副作用的（读仓库 / 播种），
    //    跑两遍会两次并发写 localStorage 而互相覆盖 —— 所以这里必须只跑一次。
    if (booted.current) return
    booted.current = true

    void (async () => {
      // DEV-only：`?vault=memory` 直接进暂存仓库，不选文件夹也能看界面
      if (import.meta.env.DEV && new URLSearchParams(location.search).get('vault') === 'memory') {
        const m = await openMemoryRepo()
        await adopt(m.host, m.ref)
        return
      }

      const ref = savedRef()
      if (!ref) {
        setPhase({ t: 'gate', error: null, pending: null })
        return
      }

      const r = await bootOpen(ref)
      if (r.t === 'ready') {
        await adopt(r.host, ref)
      } else if (r.t === 'gesture') {
        setPhase({ t: 'gate', error: null, pending: { ref, label: r.label } })
      } else {
        setPhase({ t: 'gate', error: r.message, pending: null })
      }
    })()
  }, [adopt])

  // 落盘：只写差异，防抖 450ms
  useEffect(() => {
    if (phase.t !== 'ready') return
    const host = phase.host
    const snap: Snapshot = { files, dirs }
    const plan = diffRepo(baseline.current, snap)

    if (plan.files.length === 0 && plan.dirs.length === 0) {
      setSave('clean')
      return
    }
    setSave('dirty')

    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void (async () => {
        setSave('saving')
        const report = await flushRepo(host, snap, plan)
        baseline.current = settleBaseline(baseline.current, snap, report)
        if (report.failed.length > 0) {
          setSave('error')
          setSaveError(report.failed.map((f) => `${f.path}：${f.message}`).join('\n'))
        } else {
          setSave('clean')
          setSaveError(null)
        }
      })()
    }, 450)

    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [files, dirs, phase])

  /** 把元数据写回 `.zzq`。**合并而不是覆盖** —— 不认识的字段要留着 */
  async function writeVaultMeta(patch: Partial<VaultMeta>) {
    if (phase.t !== 'ready') return
    const meta = { ...parseVault(vaultRaw.current), ...patch }
    const text = serializeVault(meta)
    try {
      await phase.host.write(VAULT_MARK, encodeText(text))
      vaultRaw.current = text
    } catch (e) {
      console.warn('[dusk] 写不了 .zzq', e)
    }
  }

  async function chooseFolder() {
    setGateBusy(true)
    try {
      const opened = await pickRepo()
      if (!opened) return
      saveRef(opened.ref)
      await adopt(opened.host, opened.ref)
    } catch (e) {
      console.error('[dusk] 打开仓库失败', e)
      setPhase({ t: 'gate', error: errText(e), pending: null })
    } finally {
      setGateBusy(false)
    }
  }

  async function chooseDefault() {
    setGateBusy(true)
    try {
      const opened = await openDefaultRepo()
      if (!opened) return
      saveRef(opened.ref)
      await adopt(opened.host, opened.ref)
    } catch (e) {
      console.error('[dusk] 打开仓库失败', e)
      setPhase({ t: 'gate', error: errText(e), pending: null })
    } finally {
      setGateBusy(false)
    }
  }

  async function chooseMemory() {
    setGateBusy(true)
    try {
      const m = await openMemoryRepo()
      await adopt(m.host, m.ref)
    } catch (e) {
      console.error('[dusk] 打开仓库失败', e)
      setPhase({ t: 'gate', error: errText(e), pending: null })
    } finally {
      setGateBusy(false)
    }
  }

  async function doResume(ref: RepoRef, label: string) {
    setGateBusy(true)
    try {
      const host = await resumeRepo(ref)
      await adopt(host, ref)
    } catch (e) {
      console.error('[dusk] 续开失败', e)
      setPhase({ t: 'gate', error: errText(e), pending: { ref, label } })
    } finally {
      setGateBusy(false)
    }
  }

  // 宽度落盘：拖的时候只改显示，停下来才写（每动一像素写一次会把整个文件表序列化）
  useEffect(() => {
    const t = window.setTimeout(() => {
      localStorage.setItem(WIDTH_KEY, JSON.stringify({ L: leftW, R: rightW }))
    }, 250)
    return () => window.clearTimeout(t)
  }, [leftW, rightW])

  /**
   * 在某一栏里打开一篇。
   *   switch —— 已经开着就切过去，没开过就把**这一栏**当前那一页换成它
   *   tab    —— 显式新开一个标签
   */
  function openInPane(index: number, path: string, mode: 'switch' | 'tab') {
    setFocused(index)
    setPanes((prev) =>
      prev.map((pane, i) => {
        if (i !== index) return pane
        if (pane.tabs.includes(path)) return { ...pane, active: path }
        if (mode === 'tab') return { ...pane, tabs: [...pane.tabs, path], active: path }
        if (pane.active) {
          return {
            ...pane,
            tabs: pane.tabs.map((t) => (t === pane.active ? path : t)),
            active: path,
          }
        }
        return { ...pane, tabs: [...pane.tabs, path], active: path }
      }),
    )
  }

  /**
   * 双击双链 / 链接。
   * 双链：解析成仓库里的路径再打开（认标题、文件名、路径三种写法）；
   * 外链：交给系统浏览器。
   */
  function jumpTo(target: string, kind: 'wiki' | 'path' | 'url') {
    if (kind === 'url') {
      if (/^https?:/i.test(target)) window.open(target, '_blank', 'noopener,noreferrer')
      return
    }

    // 标准链接：[文字](路径) —— 按路径打开
    if (kind === 'path') {
      const clean = target.replace(/^\.\//, '')
      const bare = clean.split('#')[0] ?? clean

      /*
       * `.note` 是"目录即文档"，它不在 files（那是 .md 的表）里 ——
       * 所以链接到块笔记要单独认一下，否则点了没反应。
       */
      const asNote = noteDocs.find((d) => d === bare || d === `${bare}.note`)
      if (asNote) {
        openNote(asNote)
        return
      }

      const byPath = resolvePath(files, target)
      const found = byPath ?? resolveWiki(files, target)
      if (found) {
        openNote(found)
        const section = wikiSection(target)
        if (section) setAnchor(section)
      }
      return
    }

    // 双链也可能指向块笔记（[[示例-块笔记]]）
    const wikiName = (target.split('|')[0] ?? '').split('#')[0]?.trim() ?? ''
    const wikiNote = noteDocs.find(
      (d) => d.split('/').pop()?.replace(/\.note$/i, '') === wikiName,
    )
    if (wikiNote) {
      openNote(wikiNote)
      return
    }

    const path = resolveWiki(files, target)
    if (path) {
      openNote(path)
      const section = wikiSection(target)
      if (section) setAnchor(section)
      return
    }

    /*
     * 点了还没建的篇目：**就地建出来再打开**。
     * 名字用双链里写的那个（去掉 #小节 和 |别名），放在当前笔记同一个目录下 ——
     * 别默认丢到根目录，那会把库的层次搞乱。
     */
    const raw = (target.split('|')[0] ?? '').split('#')[0] ?? ''
    const title = sanitizeName(raw.trim())
    if (!title) return

    const dir = current ? parentOf(current) : ''
    const next = uniquePath(notePath(dir, title), taken)
    setFiles((prev) => ({ ...prev, [next]: `# ${stemOf(next)}\n\n` }))
    if (dir) setExpanded((prev) => new Set(prev).add(dir))
    openNote(next)
  }

  /** 左栏点文件：开在**焦点栏**里，并且是切换语义 */
  function openNote(path: string) {
    openInPane(focused, path, 'switch')
  }

  function openInNewTab(path: string) {
    openInPane(focused, path, 'tab')
  }

  /** 新开一栏（在当前焦点栏右边）并放进去 */
  function openInSplit(path: string) {
    splitPane(focused, path)
  }

  function splitPane(index: number, seedPath: string | null = null) {
    if (panes.length >= MAX_PANES) return
    const target = panes[index]
    const seed = seedPath ?? target?.active ?? target?.tabs[0] ?? null
    const next = [...panes]
    next.splice(index + 1, 0, {
      id: ++paneSeq.current,
      tabs: seed ? [seed] : [],
      active: seed,
    })
    setPanes(next)
    setSizes(next.map(() => 1))
    setFocused(index + 1)
  }

  function closePane(index: number) {
    if (panes.length <= 1) return
    const next = panes.filter((_, i) => i !== index)
    setPanes(next)
    setSizes(next.map(() => 1))
    setFocused((f) => Math.max(0, Math.min(next.length - 1, f > index ? f - 1 : f)))
  }

  function closeTabIn(index: number, path: string) {
    setPanes((prev) =>
      prev.map((pane, i) => {
        if (i !== index) return pane
        const at = pane.tabs.indexOf(path)
        const tabs = pane.tabs.filter((t) => t !== path)
        const active =
          pane.active === path ? (tabs[at] ?? tabs[at - 1] ?? null) : pane.active
        return { ...pane, tabs, active }
      }),
    )
  }

  /** 分隔条：把位移换成分栏比例，夹住不让某一栏被挤没 */
  function beginDivide() {
    sizeAtStart.current = [...sizes]
  }

  function moveDivide(index: number, dx: number) {
    const box = paneBox.current
    if (!box) return
    const total = box.getBoundingClientRect().width
    if (total <= 0) return

    const start = sizeAtStart.current
    const a = start[index] ?? 1
    const b = start[index + 1] ?? 1
    const pair = a + b
    const sum = start.reduce((s, x) => s + x, 0)
    const min = pair * 0.15

    let a2 = a + (dx / total) * sum
    a2 = Math.min(pair - min, Math.max(min, a2))

    const next = [...start]
    next[index] = a2
    next[index + 1] = pair - a2
    setSizes(next)
  }

  function resetDivide(index: number) {
    setSizes((prev) => {
      const next = [...prev]
      const a = prev[index] ?? 1
      const b = prev[index + 1] ?? 1
      const half = (a + b) / 2
      next[index] = half
      next[index + 1] = half
      return next
    })
  }

  /** 从底部那行仓库名切到另一个仓库。点击本身就是手势，所以 FSA 的权限能要到 */
  async function switchVault(ref: RepoRef) {
    setGateBusy(true)
    try {
      const host = await resumeRepo(ref)
      saveRef(ref)
      await adopt(host, ref)
    } catch (e) {
      console.error('[dusk] 切换仓库失败', e)
      setPhase({ t: 'gate', error: errText(e), pending: { ref, label: describeRef(ref) } })
    } finally {
      setGateBusy(false)
    }
  }

  function toggleDir(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function togglePin(path: string) {
    const next = pins.includes(path) ? pins.filter((p) => p !== path) : [...pins, path]
    setPins(next)
    void writeVaultMeta({ pins: next })
  }

  function edit(path: string, text: string) {
    setFiles((prev) => ({ ...prev, [path]: text }))
  }

  const taken = (p: string) => p in files || dirs.includes(p)

  function createNote(dir: string): string | null {
    const path = uniquePath(notePath(dir, '未命名'), taken)
    setFiles((prev) => ({ ...prev, [path]: `# ${stemOf(path)}\n\n` }))
    if (dir) setExpanded((prev) => new Set(prev).add(dir))
    // 注意走 openNote：新建的笔记也要有一个标签页，否则编辑器开着它、标签条上却没有
    openNote(path)
    return path
  }

  /**
   * 新建一篇 `.note`（块笔记）。
   * 目录要真的建出来 —— `.note` 是"目录即文档"，磁盘上没有这个目录它就不存在。
   */
  async function createBlockNote(dir: string): Promise<string | null> {
    if (phase.t !== 'ready') return null
    const base = dir ? `${dir}/` : ''
    const path = uniquePath(`${base}新建块笔记.note`, taken)

    const doc = emptyDoc(stemOf(path))
    try {
      await phase.host.mkdir(path)
      await phase.host.mkdir(`${path}/blocks`)
      for (const [p, text] of Object.entries(docFiles(path, doc))) {
        await phase.host.write(p, encodeText(text))
      }
    } catch (e) {
      console.warn('[dusk] 建不了 .note', e)
      return null
    }

    setNoteDocs((prev) => [...prev, path])
    if (dir) setExpanded((prev) => new Set(prev).add(dir))
    openNote(path)
    return path
  }

  function createFolder(dir: string): string | null {
    const path = uniquePath(folderPath(dir, '新建文件夹'), taken)
    setDirs((prev) => [...prev, path])
    setExpanded((prev) => new Set(prev).add(path))
    return path
  }

  function apply(r: EditOk) {
    setFiles(r.files)
    setDirs(r.dirs)
    // 标签页也要跟着换路径，否则改完名那页会指向一个不存在的路径
    // 每一栏的标签与当前页也要跟着换路径，否则改完名那一页会指向不存在的路径
    const to = (p: string) => r.moved.find((m) => m.from === p)?.to ?? p
    setPanes((prev) =>
      prev.map((pane) => ({
        ...pane,
        tabs: pane.tabs.map(to),
        active: pane.active ? to(pane.active) : null,
      })),
    )
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const m of r.moved) if (prev.has(m.from)) next.add(m.to)
      return next
    })

    // 账本里的路径也要跟着搬 —— 否则改完名那条置顶就悬空了
    if (r.moved.length > 0) {
      const nextPins = pins.map(to)
      const meta = parseVault(vaultRaw.current)
      const files: Record<string, FileMeta> = {}
      for (const [p, v] of Object.entries(meta.files)) files[to(p)] = v
      setPins(nextPins)
      void writeVaultMeta({ pins: nextPins, files })
    }
  }

  function doRename(path: string, name: string): string | null {
    const r = renameEntry(files, dirs, path, name)
    if (!r.ok) return r.error
    apply(r)
    return null
  }

  // 改名之后，编辑器里那篇要跟着换路径 —— 这里靠 apply 里的 moved 映射处理
  function doMove(path: string, destDir: string): string | null {
    const r = moveEntry(files, dirs, path, destDir)
    if (!r.ok) return r.error
    apply(r)
    return null
  }

  function doDelete(path: string) {
    const r = deleteEntry(files, dirs, path)
    setFiles(r.files)
    setDirs(r.dirs)
    setPanes((prev) =>
      prev.map((pane) => {
        const tabs = pane.tabs.filter((t) => !r.removed.includes(t))
        const active =
          pane.active && r.removed.includes(pane.active)
            ? (tabs[0] ?? null)
            : pane.active
        return { ...pane, tabs, active }
      }),
    )
    // 被删掉的（含整棵子树里的）置顶和文件属性要一起清掉，否则账本里会留悬空条目
    const nextMeta = pruneMeta(parseVault(vaultRaw.current), r.removed)
    if (nextMeta.pins.length !== pins.length || Object.keys(nextMeta.files).length > 0) {
      setPins(nextMeta.pins)
      void writeVaultMeta({ pins: nextMeta.pins, files: nextMeta.files })
    }
  }

  if (phase.t === 'booting') {
    return (
      <div className="grid h-dvh place-items-center bg-paper text-[12.5px] text-ink-3">
        正在打开仓库…
      </div>
    )
  }

  if (phase.t === 'gate') {
    const pending = phase.pending
    return (
      <>
        <RepoGate
          canPick={canPickFolder()}
          isDesktop={isTauri()}
          busy={gateBusy}
          error={phase.error}
          pending={pending ? { label: pending.label } : null}
          onPick={() => void chooseFolder()}
          onResume={() => {
            if (pending) void doResume(pending.ref, pending.label)
          }}
          onDefault={() => void chooseDefault()}
          onMemory={() => void chooseMemory()}
        />
        {working ? <Working text={working} /> : null}
      </>
    )
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-paper text-ink">
      <div className="flex min-h-0 flex-1">
        <Rail section={section} onChange={setSection} onSettings={() => setSettingsOpen(true)} />

        <TreePanel
            section={section}
            tree={tree}
            current={current}
            expanded={expanded}
            onToggle={toggleDir}
            onOpen={openNote}
            onOpenTab={openInNewTab}
            onOpenSplit={openInSplit}
            onNewNote={createNote}
            onNewBlockNote={(dir) => void createBlockNote(dir)}
            onNewFolder={createFolder}
            onRename={doRename}
            onMove={doMove}
            onDelete={doDelete}
            pinned={pins}
            onTogglePin={togglePin}
            repoLabel={describeRef(phase.ref)}
            durable={phase.host.capabilities.durable}
            save={save}
            saveError={saveError}
            vaultItems={vaults.map((v) => ({ key: vaultKey(v.ref), label: v.label }))}
            currentVaultKey={vaultKey(phase.ref)}
            onSwitchVault={(key) => {
              const hit = vaults.find((v) => vaultKey(v.ref) === key)
              if (hit) void switchVault(hit.ref)
            }}
            onPickVault={() => void chooseFolder()}
            width={leftW}
            resizer={
              <Resizer
                side="left"
                width={leftW}
                min={SIDEBAR_MIN}
                max={SIDEBAR_MAX}
                onChange={setLeftW}
                onReset={() => setLeftW(SIDEBAR_DEFAULT.L)}
              />
            }
          />

        <div ref={paneBox} className="flex min-h-0 min-w-0 flex-1">
          {panes.map((pane, i) => (
            <Fragment key={pane.id}>
              {i > 0 ? (
                <PaneDivider
                  onStart={beginDivide}
                  onDelta={(dx) => moveDivide(i - 1, dx)}
                  onEnd={() => {}}
                  onReset={() => resetDivide(i - 1)}
                />
              ) : null}

              <div style={{ flexGrow: sizes[i] ?? 1, flexBasis: 0 }} className="flex min-w-0">
                <DocPane
                  tabs={pane.tabs}
                  active={pane.active}
                  focused={focused === i}
                  onFocus={() => setFocused(i)}
                  text={pane.active ? (files[pane.active] ?? '') : ''}
                  onChange={edit}
                  onSelectTab={(path) =>
                    setPanes((prev) => prev.map((p, k) => (k === i ? { ...p, active: path } : p)))
                  }
                  onCloseTab={(path) => closeTabIn(i, path)}
                  onSplit={() => splitPane(i)}
                  onClosePane={panes.length > 1 ? () => closePane(i) : null}
                  host={phase.host}
                  onJump={jumpTo}
                  notes={Object.keys(files).map((p) => ({ path: p, title: titleOf(files, p) }))}
                  /*
                   * ⚠️ 必须按**这一栏自己的** active 算，不能用全局 current（那是焦点栏的文档）。
                   * 用全局值时：非焦点栏里的 .note 拿不到 noteDir，块编辑器不渲染；
                   * 焦点栏是 .note 时，所有栏又都去渲染同一个块编辑器 —— 分栏直接废掉。
                   */
                  noteDir={
                    pane.active && noteDocs.includes(pane.active) ? pane.active : null
                  }
                  onNoteInfo={(dir, info) =>
                    setNoteInfo((prev) => {
                      const old = prev[dir]
                      if (old && old.text === info.text && old.outline.length === info.outline.length) {
                        return prev
                      }
                      return { ...prev, [dir]: info }
                    })
                  }
                  anchor={anchor}
                  onAnchorDone={() => setAnchor(null)}
                  aside={
                    i === panes.length - 1 && !(current && noteDocs.includes(current))
                      ? { open: asideOpen, toggle: () => setAsideOpen((v) => !v) }
                      : null
                  }
                />
              </div>
            </Fragment>
          ))}
        </div>

        {/*
        右栏大纲跟着**最右边那一栏**走，不跟焦点 ——
        跟焦点会出现"点一下另一栏，宽度就变"的现象（大纲被隐藏/显示，两侧跟着重排）。

        `.note` 也有右栏：大纲来自块编辑器上报的块标题，
        反链/悬空链接用"md 文件 + 各 .note 正文"的合并表算。
      */}
      {asideOpen && lastDoc ? (
          <Aside
            files={asideFiles}
            path={lastDoc}
            noteOutline={noteDocs.includes(lastDoc) ? noteInfo[lastDoc]?.outline : undefined}
            onOpen={openNote}
            onClose={() => setAsideOpen(false)}
            width={rightW}
            resizer={
              <Resizer
                side="right"
                width={rightW}
                min={SIDEBAR_MIN}
                max={SIDEBAR_MAX}
                onChange={setRightW}
                onReset={() => setRightW(SIDEBAR_DEFAULT.R)}
              />
            }
          />
        ) : null}
      </div>

      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
          onReset={() => setSettings(resetSettings())}
        />
      ) : null}
    </div>
  )
}
