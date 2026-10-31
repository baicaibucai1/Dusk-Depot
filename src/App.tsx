import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Snapshot } from './core/model/flush'
import { diffRepo, flushRepo, settleBaseline } from './core/model/flush'
import type { FileMap } from './core/model/library'
import { buildTreeFromEntries, isNote } from './core/model/library'
import { isEpubPath, kindOf, previewOf } from './core/model/fileKind'
import { isNoteDocPath } from './core/note/format'
import { emptyFlowDoc, flowDocFiles } from './core/note/flowDoc'
import { folderPath, notePath, sanitizeName, uniquePath } from './core/model/note'
import { parentOf, stemOf } from './core/model/path'
import { deleteEntry, moveEntry, renameEntry, type EditOk } from './core/model/rename'
import { resolvePath, resolveWiki, titleOf, wikiSection } from './core/markdown/links'
import { outlineOf } from './core/markdown/parse'
import { decodeBytes, encodeText } from './core/model/text'
import {
  iconsOf,
  isListable,
  parseVault,
  pruneMeta,
  serializeVault,
  setIcon,
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
import { AssetInfo } from './ui/AssetInfo'
import { SettingsDialog } from './ui/SettingsDialog'
import { applySettings, loadSettings, resetSettings, saveSettings, type Settings } from './ui/settings'
import { DocPane } from './ui/DocPane'
import { SymbolPanel } from './ui/SymbolPanel'
import { RepoGate } from './ui/RepoGate'
import { PaneDivider } from './ui/PaneDivider'
import { Resizer } from './ui/Resizer'
import { Rail, type Space } from './ui/Rail'
import { TreePanel } from './ui/TreePanel'
import { SEED } from './ui/demo'
import { ShelfPanel } from './ui/shelf/ShelfPanel'
import { ShelfMain } from './ui/shelf/ShelfMain'
import { ShelfAside } from './ui/shelf/ShelfAside'
import { ShelfMoveDialog } from './ui/shelf/ShelfMoveDialog'
import { useShelf } from './ui/shelf/useShelf'
import type { ReaderApi, ReaderLocation, ReaderSettings } from './ui/shelf/EpubReader'
import type { TocItem } from './core/shelf/epub'
import { type ShelfTarget, pickShelfTarget } from './core/shelf/store'
import { type MoveProgress, type TargetInspection, inspectTarget, moveShelfTo } from './core/shelf/migrate'
import { importPath, statPath } from './hosts/tauri'

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
): Promise<Snapshot & { hasMark: boolean; notes: string[]; assets: string[] }> {
  const entries = await host.list()

  /*
   * `.note` 是"目录即文档"：整个目录算**一篇**，里面的块文件不单独露出来。
   * 所以先把这些根挑出来，再把它底下的条目全部过滤掉。
   */
  const noteRoots = entries
    .filter((e) => e.kind === 'dir' && isNoteDocPath(e.path) && isListable(e.path))
    .map((e) => e.path)
  const underNote = (p: string) => noteRoots.some((root) => p === root || p.startsWith(`${root}/`))

  /*
   * 树里收四类：目录、md、**能预览的**图片 / PDF，以及 `.epub`。
   *
   * `.epub` 收进来不是为了读 —— 是为了让人点开时看到"这里不读电子书，
   * 请去书架"，并且能一键加进书架。否则它只会在树里凭空消失，像丢了一样。
   *
   * 为什么不是"列全部文件"：树里出现的每一项都得能点开做点什么。
   * txt / zip 这一版既不能编辑也不能预览，列出来只是让人点一下没反应。
   *
   * 图片和 PDF **只记路径**，不在这里读字节 —— 一个库里有几百张图时，
   * 打开仓库那一刻全读进内存是没道理的。真打开时再由查看器按需读。
   */
  const keep = entries.filter((e) => {
    if (underNote(e.path)) return false
    if (!isListable(e.path)) return false
    if (e.kind === 'dir') return true
    return isNote(e.path) || previewOf(e.path) !== null || isEpubPath(e.path)
  })
  const assets = keep
    .filter((e) => e.kind === 'file' && !isNote(e.path))
    .map((e) => e.path)

  const files: FileMap = {}
  for (const e of keep) {
    if (e.kind !== 'file') continue
    // 图片 / PDF 不进 FileMap：那张表只装**文本**，二进制进去就是乱码
    if (!isNote(e.path)) continue
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
    assets,
  }
}

/**
 * 把一个 `.note` 目录整体改名。
 * 宿主没有原子换名（浏览器那条路就没有）时，退化成"逐文件复制 + 删旧的"。
 * `.note` 目录只有一层块文件，没有更深的子树，所以这样搬是安全的。
 */
async function moveNoteDir(host: Host, from: string, to: string, title?: string): Promise<boolean> {
  try {
    if (host.move) {
      await host.move(from, to)
    } else {
      const entries = await host.list()
      await host.mkdir(to)
      await host.mkdir(`${to}/blocks`)
      for (const e of entries) {
        if (e.kind !== 'file' || !e.path.startsWith(`${from}/`)) continue
        await host.write(`${to}${e.path.slice(from.length)}`, await host.read(e.path))
        await host.remove(e.path)
      }
      await host.rmdir(`${from}/blocks`).catch(() => {})
      await host.rmdir(from).catch(() => {})
    }

    /*
     * 目录名和文档标题是两回事：树里改名之后，标题也得跟着改，
     * 否则打开来还是"未命名"，用户会以为没改成。
     * 只动 meta.json，块文件一个都不碰。
     */
    if (title) {
      const metaPath = `${to}/meta.json`
      try {
        const raw = decodeBytes(await host.read(metaPath))
        const meta = JSON.parse(raw) as Record<string, unknown>
        meta.title = title
        await host.write(metaPath, encodeText(`${JSON.stringify(meta, null, 2)}\n`))
      } catch {
        /* 元数据改不了不影响正文 */
      }
    }
    return true
  } catch (e) {
    console.warn('[dusk] 块笔记改名失败', from, '→', to, e)
    return false
  }
}

/** 打开暂存仓库。空的就先塞一份出厂笔记，免得第一次打开是一片空白 */
async function openMemoryRepo() {
  const m = memoryRepo()
  saveRef(m.ref)
  if (memoryIsEmpty()) memorySeed(SEED)
  return m
}

/* 阅读器的显示偏好（设备级，跟书架目录无关） */
const READER_KEY = 'dusk.reader.v1'
const READER_DEFAULTS: ReaderSettings = { fontSize: 17, lineHeight: 1.85, width: 720, theme: 'light' }

function loadReaderSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(READER_KEY)
    if (!raw) return { ...READER_DEFAULTS }
    const v = JSON.parse(raw) as Partial<ReaderSettings>
    return {
      fontSize: Math.min(24, Math.max(13, Number(v.fontSize) || READER_DEFAULTS.fontSize)),
      lineHeight: Math.min(2.4, Math.max(1.3, Number(v.lineHeight) || READER_DEFAULTS.lineHeight)),
      width: Math.min(980, Math.max(480, Number(v.width) || READER_DEFAULTS.width)),
      theme: v.theme === 'sepia' || v.theme === 'dark' ? v.theme : 'light',
    }
  } catch {
    return { ...READER_DEFAULTS }
  }
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
  /** 图片 / PDF 的路径。只存路径 —— 字节在真正打开时才按需读 */
  const [assets, setAssets] = useState<string[]>([])
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
  /** 目录栏是否展开（收起后导航条还在，点一下回来） */
  const [treeOpen, setTreeOpen] = useState(true)
  /** 当前工作区：文件 / 书架。两套东西互不干扰，书架不写仓库 */
  const [space, setSpace] = useState<Space>('files')
  const shelf = useShelf()
  const [readerToc, setReaderToc] = useState<TocItem[]>([])
  const [readerLoc, setReaderLoc] = useState<ReaderLocation | null>(null)
  const [readerApi, setReaderApi] = useState<ReaderApi | null>(null)
  const [readerSettings, setReaderSettings] = useState<ReaderSettings>(loadReaderSettings)
  const [shelfMove, setShelfMove] = useState<{ target: ShelfTarget; info: TargetInspection } | null>(null)
  const [shelfMoveError, setShelfMoveError] = useState<string | null>(null)
  const [shelfBusy, setShelfBusy] = useState(false)
  const [moveProgress, setMoveProgress] = useState<MoveProgress | null>(null)

  /** 渲染个性化：字号/行距/段距/宽度/字体。存本地，应用时写成根节点的 CSS 变量 */
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 打开 `[[某篇#小节]]` 之后要滚到的小节 */
  const [anchor, setAnchor] = useState<string | null>(null)

  useEffect(() => {
    applySettings(settings)
    saveSettings(settings)
  }, [settings])
  useEffect(() => {
    try {
      localStorage.setItem(READER_KEY, JSON.stringify(readerSettings))
    } catch {
      /* 存不了就这一次生效 */
    }
  }, [readerSettings])

  /* 书架的提示条几秒后自己收掉（不然会一直挂在那儿） */
  useEffect(() => {
    if (!shelf.notice) return
    const t = window.setTimeout(() => shelf.setNotice(null), 4200)
    return () => window.clearTimeout(t)
  }, [shelf.notice, shelf.setNotice, shelf])

  /* 换书：目录/位置清空，等阅读器重新报 */
  useEffect(() => {
    setReaderToc([])
    setReaderLoc(null)
    setReaderApi(null)
  }, [shelf.openId])

  /* 阅读进度：翻页后防抖写回清单（每本按 bookId 记账，不会串书） */
  const readerSaveTimer = useRef(0)
  /**
   * ⚠️ 这里**必须**用事件自带的 bookId，不能用 `shelf.openId`：
   *    旧阅读器卸载时会再发一次 relocated，那时 openId 已经指向新书了，
   *    按"当前书"记账就会把上一本的位置写进下一本。
   */
  const openIdRef = useRef<string | null>(shelf.openId)
  openIdRef.current = shelf.openId
  const onReaderLocation = (id: string, loc: ReaderLocation) => {
    if (openIdRef.current !== id) return
    setReaderLoc(loc)
    window.clearTimeout(readerSaveTimer.current)
    readerSaveTimer.current = window.setTimeout(() => {
      shelf.patchReading(id, {
        cfi: loc.cfi,
        percent: loc.percent,
        locator: { chapter: loc.chapter, ratio: loc.percent },
      })
    }, 700)
  }

  /* 关窗 / 切走前把进度刷下去 */
  useEffect(() => {
    const flush = () => {
      const id = shelf.openId
      const loc = readerLoc
      if (id && loc) shelf.patchReading(id, { cfi: loc.cfi, percent: loc.percent })
      void shelf.saveNow()
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [shelf, readerLoc])
  const [save, setSave] = useState<SaveState>('clean')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pins, setPins] = useState<string[]>([])
  /** 自定义文件夹图标：路径 → emoji（存在 .zzq 的 files[path].icon） */
  const [icons, setIcons] = useState<Record<string, string>>({})
  /** 正在给哪个文件夹挑图标（null = 没开） */
  const [iconTarget, setIconTarget] = useState<string | null>(null)
  /** 上次读到的 `.zzq` 原文。写回时以它为底合并，别把不认识的字段冲掉 */
  const vaultRaw = useRef('')
  const [gateBusy, setGateBusy] = useState(false)
  /** 打开仓库卡在哪一步 —— 界面上要能看见，不能只是"没反应" */
  const [openStage, setOpenStage] = useState<string | null>(null)
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
          ...assets.map((a) => ({ path: a, kind: 'file' as const })),
        ],
        // 置顶的按加入顺序排在最前，其余给个大数
        (p) => {
          const i = pins.indexOf(p)
          return i < 0 ? 1e9 : i
        },
      ),
    [dirs, files, pins, noteDocs, assets],
  )

  const adopt = useCallback(async (host: Host, ref: RepoRef) => {
    setWorking(`正在读取 ${host.label}…`)
    try {
      // 出问题时这两行能在控制台告诉我们在哪一步停下
      console.info('[dusk] 开始读取仓库', host.label)
      const loaded = await readRepo(host)
      console.info('[dusk] 读完', Object.keys(loaded.files).length, '篇', loaded.dirs.length, '个目录')
      const snap: Snapshot = { files: loaded.files, dirs: loaded.dirs }
      baseline.current = snap
      setFiles(loaded.files)
      setDirs(loaded.dirs)
      setNoteDocs(loaded.notes)
      setAssets(loaded.assets)
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
      setIcons(iconsOf(meta))

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

      /*
       * 记不住这次打开的仓库（localStorage 满 / 被禁）不该把人打回选择页 ——
       * 文件已经读进来了，先让人用上。下次重选一次就是了。
       */
      try {
        setVaults(rememberVault({ label: describeRef(ref), ref }))
      } catch (e) {
        console.warn('[dusk] 记不住这次打开的仓库', e)
      }

      setPhase({ t: 'ready', host, ref })
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
    setOpenStage('正在等你选文件夹…')
    try {
      const opened = await pickRepo()
      if (!opened) {
        setOpenStage(null)
        return
      }
      setOpenStage(`已选择「${opened.host.label}」，正在读取…`)
      // 记不住仓库引用（localStorage 被禁）不该挡住打开
      try {
        saveRef(opened.ref)
      } catch (e) {
        console.warn('[dusk] 记不住仓库引用（localStorage 不可用）', e)
      }
      await adopt(opened.host, opened.ref)
    } catch (e) {
      console.error('[dusk] 打开仓库失败', e)
      setPhase({ t: 'gate', error: errText(e), pending: null })
    } finally {
      setOpenStage(null)
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
   * 窄窗口：先收右栏，再收目录栏；宽回来再放开。
   *
   * 只在**跨过档位**时动手 —— 不然用户自己收起右栏之后，
   * 随便拖一下窗口就又被"自动恢复"回来，控制权会打架。
   */
  useEffect(() => {
    const bucketOf = (w: number) => (w < 940 ? 0 : w < 1220 ? 1 : 2)
    let last = bucketOf(window.innerWidth)

    const apply = (b: number) => {
      if (b === 2) {
        setAsideOpen(true)
        setTreeOpen(true)
      } else if (b === 1) {
        setAsideOpen(false)
        setTreeOpen(true)
      } else {
        setAsideOpen(false)
        setTreeOpen(false)
      }
    }

    const onResize = () => {
      const b = bucketOf(window.innerWidth)
      if (b === last) return
      last = b
      apply(b)
    }

    // 首屏也按当前宽度收一次，免得一进来就横向溢出
    apply(last)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

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

      // 相对路径按"从当前这一篇出发"算：子目录里的 ../ 也要认
      const byPath = resolvePath(files, target, current ?? undefined)
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

  const taken = (p: string) => p in files || dirs.includes(p) || assets.includes(p) || noteDocs.includes(p)

  function createNote(dir: string): string | null {
    const path = uniquePath(notePath(dir, '未命名'), taken)
    setFiles((prev) => ({ ...prev, [path]: `# ${stemOf(path)}\n\n` }))
    if (dir) setExpanded((prev) => new Set(prev).add(dir))
    // 注意走 openNote：新建的笔记也要有一个标签页，否则编辑器开着它、标签条上却没有
    openNote(path)
    return path
  }

  /**
   * 新建一篇**文档流** `.note`（v2）。
   *
   * 直接写盘，不走 files 内存表：`.note` 是一个目录，里面的块文件不该出现在文件树里
   * （树里它只作为一篇文档出现）。写失败就什么都不加，别留半个文档。
   */
  function createNoteDoc(dir: string): string | null {
    if (phase.t !== 'ready') return null
    const host = phase.host
    const base = dir ? `${dir}/` : ''
    const path = uniquePath(`${base}未命名.note`, taken)
    const doc = emptyFlowDoc('未命名')
    const files = flowDocFiles(path, doc)

    /*
     * ⚠️ 先把文件真的写下去，**再**打开。
     * 反过来的话，编辑器会在目录还空着的时候去解析，直接报"缺标记文件"。
     * 写失败就把这篇从树里撤掉，别留一个打不开的文档。
     */
    void (async () => {
      try {
        await host.mkdir(path)
        await host.mkdir(`${path}/blocks`)
        for (const [p, text] of Object.entries(files)) await host.write(p, encodeText(text))
        setNoteDocs((prev) => (prev.includes(path) ? prev : [...prev, path]))
        if (dir) setExpanded((prev) => new Set(prev).add(dir))
        openNote(path)
      } catch (e) {
        console.warn('[dusk] 新建块笔记失败', e)
        setNoteDocs((prev) => prev.filter((p) => p !== path))
      }
    })()

    return path
  }

  /** 设 / 清某个文件夹的图标。存的是字符，不是图片路径 */
  /** `[[` 提示要的清单：每篇带自己的小节，插出去是 `[[路径#小节]]` */
  const linkTargets = useMemo(
    () =>
      Object.keys(files)
        .sort((a, b) => a.localeCompare(b, 'zh'))
        .map((p) => ({
          path: p,
          title: titleOf(files, p),
          headings: outlineOf(files[p] ?? '').map((h) => h.text),
        })),
    [files],
  )

  function setDirIcon(path: string, icon: string) {
    const nextMeta = setIcon(parseVault(vaultRaw.current), path, icon)
    setIcons(iconsOf(nextMeta))
    void writeVaultMeta({ files: nextMeta.files })
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
      setIcons(iconsOf({ ...meta, files }))
      void writeVaultMeta({ pins: nextPins, files })
    }
  }

  function doRename(path: string, name: string): string | null {
    // `.note` 是一整个目录，改的是目录名 —— 不走文件表那条路。
    // 判断用后缀而不是 noteDocs：新建的文档在 setNoteDocs 生效前就可能被改名。
    if (noteDocs.includes(path) || path.toLowerCase().endsWith('.note')) {
      return renameNoteDoc(path, name)
    }
    const r = renameEntry(files, dirs, path, name)
    if (!r.ok) return r.error
    apply(r)
    return null
  }

  /**
   * 改一篇块笔记的名字。
   *
   * 顺序很重要：先在内存里换掉路径（树/标签/置顶立刻对），再让宿主搬目录。
   * 搬失败只留一条警告 —— 用户看到的界面不会因此回到旧名字，磁盘上的旧目录也还在，
   * 数据不会丢；下次打开仓库会如实反映磁盘状态。
   */
  function renameNoteDoc(path: string, rawName: string): string | null {
    const clean = sanitizeName(rawName).replace(/\.note$/i, '')
    if (!clean) return '名字不能为空'

    const parent = parentOf(path)
    const to = `${parent ? `${parent}/` : ''}${clean}.note`
    if (to === path) return null
    if (noteDocs.includes(to) || dirs.includes(to) || to in files) {
      return `「${clean}」已经存在了`
    }

    /*
     * 顺序：**先把目录搬完，再换界面上的路径**。
     * 反过来的话，编辑器会立刻去读新路径、而文件还没搬过去 —— 打开就是"缺标记文件"。
     * 搬失败就什么都不改（树里还是旧名字，磁盘上也还是旧目录）。
     */
    const commit = () => {
      const map = (p: string) => (p === path ? to : p)
      // 新建后立刻改名时，noteDocs 里可能还没有它 —— 直接补上，别把这篇丢了
      setNoteDocs((prev) => (prev.includes(path) ? prev.map(map) : [...prev, to]))
      setPanes((prev) =>
        prev.map((pane) => ({
          ...pane,
          tabs: pane.tabs.map(map),
          active: pane.active ? map(pane.active) : null,
        })),
      )

      if (pins.includes(path)) {
        const nextPins = pins.map(map)
        setPins(nextPins)
        const meta = parseVault(vaultRaw.current)
        const filesMeta: Record<string, FileMeta> = {}
        for (const [p, v] of Object.entries(meta.files)) filesMeta[map(p)] = v
        void writeVaultMeta({ pins: nextPins, files: filesMeta })
      }
    }

    if (phase.t === 'ready') {
      void moveNoteDir(phase.host, path, to, clean).then((ok) => {
        if (ok) commit()
      })
    } else {
      commit()
    }
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
    // 图片 / PDF 不在 files 里：直接让宿主删掉，再把它从树、标签、账本里清掉
    if (assets.includes(path)) {
      if (phase.t === 'ready') {
        void phase.host.remove(path).catch((e) => console.warn('[dusk] 删不掉', path, e))
      }
      setAssets((prev) => prev.filter((a) => a !== path))
      setPanes((prev) =>
        prev.map((pane) => {
          const tabs = pane.tabs.filter((t) => t !== path)
          return { ...pane, tabs, active: pane.active === path ? (tabs[0] ?? null) : pane.active }
        }),
      )
      const nextMeta = pruneMeta(parseVault(vaultRaw.current), [path])
      setIcons(iconsOf(nextMeta))
      if (nextMeta.pins.length !== pins.length) {
        setPins(nextMeta.pins)
        void writeVaultMeta({ pins: nextMeta.pins, files: nextMeta.files })
      }
      return
    }
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
    setIcons(iconsOf(nextMeta))
    if (nextMeta.pins.length !== pins.length || Object.keys(nextMeta.files).length > 0) {
      setPins(nextMeta.pins)
      void writeVaultMeta({ pins: nextMeta.pins, files: nextMeta.files })
    }
  }

  /* ───────────────────────── 书架：目录、迁移、书签 ───────────────────────── */

  const [toast, setToast] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null)
  const say = useCallback((kind: 'ok' | 'warn' | 'error', text: string) => {
    setToast({ kind, text })
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(t)
  }, [toast])

  async function chooseShelfDir() {
    if (shelf.importing) {
      say('warn', '正在导入，等这一批结束再换书架')
      return
    }
    try {
      // 只拿到"候选目录"，此时 IndexedDB 和配置都还是旧的 —— 取消/关闭对话框不影响当前书架
      const target = await pickShelfTarget()
      if (!target) return
      if (!shelf.shelf || shelf.status === 'setup') {
        try {
          await shelf.useConfig(target)
          setSpace('shelf')
        } catch (e) {
          say('error', `书架没换过去：${String(e)}`)
        }
        return
      }
      const info = await inspectTarget(shelf.shelf, target)
      setShelfMove({ target, info })
      setShelfMoveError(null)
    } catch (e) {
      say('error', `选目录失败：${String(e)}`)
    }
  }

  /** 换书架前，把阅读器里"还没写回清单"的那一页先记上 */
  function flushReaderProgress() {
    if (!shelf.openId || !readerLoc) return
    shelf.patchReading(shelf.openId, {
      cfi: readerLoc.cfi,
      percent: readerLoc.percent,
      locator: { chapter: readerLoc.chapter, ratio: readerLoc.percent },
    })
  }

  /**
   * 换书架目录。
   *   move = 暂存复制 → 校验 → 落位 → 校验通过才切配置；失败旧书架照常用
   *   use  = 直接用目标位置已有的书架（不复制、不覆盖）
   */
  async function applyShelfMove(mode: 'move' | 'use') {
    const job = shelfMove
    if (!job || !shelf.shelf) return
    setShelfBusy(true)
    setShelfMoveError(null)
    try {
      flushReaderProgress()
      if (mode === 'move') {
        await moveShelfTo(shelf.shelf, job.target, setMoveProgress)
      }
      await shelf.useConfig(job.target)
      setShelfMove(null)
      setSpace('shelf')
      say(
        'ok',
        mode === 'move'
          ? '书架已搬到新位置；旧目录原样保留，确认无误后可以自己清理'
          : '已切换到新位置的书架',
      )
    } catch (e) {
      // 对话框不关：错误就地显示，用户可以重试或取消；旧书架一直可用
      setShelfMoveError(String(e instanceof Error ? e.message : e))
    } finally {
      setShelfBusy(false)
      setMoveProgress(null)
    }
  }

  /** 打开一本书之前，先把当前这本的进度写回它自己的清单 */
  function openShelfBook(id: string) {
    if (shelf.openId && shelf.openId !== id) flushReaderProgress()
    shelf.openBook(id)
  }

  function addShelfBookmark() {
    const book = shelf.books.find((b) => b.id === shelf.openId)
    if (!book) return
    const loc = readerLoc
    const r = shelf.addMark(book.id, {
      id: `m-${Date.now().toString(36)}`,
      cfi: loc?.cfi ?? '',
      label: loc?.label || '当前位置',
      percent: loc?.percent ?? book.percent,
      at: Date.now(),
    })
    if (r === 'dup') say('warn', '这个位置已经有书签了')
    else if (r === 'missing') say('error', '这本书不在当前书架里（可能刚换过目录）')
    else say('ok', '已加书签')
  }

  /** 仓库里的 EPUB：复制一份进书架，然后切过去打开。仓库文件不动 */
  async function addRepoEpubToShelf(path: string) {
    if (phase.t !== 'ready') return
    const name = path.split('/').pop() ?? 'book.epub'
    try {
      const bytes = await phase.host.read(path)
      const results = await shelf.importFiles([{ kind: 'bytes', name, bytes }])
      const hit = results.find((r) => r.ok && r.bookId)
      if (hit?.bookId) {
        setSpace('shelf')
        openShelfBook(hit.bookId)
        say('ok', `已把《${name}》加进书架（复制了一份，仓库原文件没动）`)
      }
    } catch (e) {
      say('error', `加进书架失败：${String(e)}`)
    }
  }

  /* ───────────────────────── 仓库：reveal / 复制路径 ───────────────────────── */

  async function revealRepo(path: string) {
    if (phase.t !== 'ready') return
    if (!phase.host.reveal) {
      say('warn', '当前运行环境拿不到真实路径，没法在文件管理器里定位')
      return
    }
    try {
      await phase.host.reveal(path)
    } catch (e) {
      say('error', `打不开文件管理器：${String(e)}`)
    }
  }

  async function copyRepoPath(path: string) {
    try {
      await navigator.clipboard.writeText(path)
      say('ok', `已复制：${path}`)
    } catch {
      say('warn', '剪贴板不可用')
    }
  }

  /* ───────────────────────── 拖入：仓库文件 ───────────────────────── */

  /** 仓库里不重名（同名就 `名字 (2).md`） */
  function uniqueRepoPath(dir: string, name: string): string {
    const join = (n: string) => (dir ? `${dir}/${n}` : n)
    const taken = (p: string) =>
      p in files || dirs.includes(p) || assets.includes(p) || noteDocs.includes(p)
    if (!taken(join(name))) return join(name)
    const m = /(\.[^.]+)$/.exec(name)
    const ext = m ? m[1] : ''
    const stem = ext ? name.slice(0, -ext.length) : name
    for (let i = 2; i < 500; i++) {
      const next = `${stem} (${i})${ext}`
      if (!taken(join(next))) return join(next)
    }
    return join(`${stem}-${Date.now()}${ext}`)
  }

  /** 把一批 File 放进仓库的某个目录（浏览器路径） */
  async function dropRepoFiles(list: File[], dir: string, insertImage?: (path: string) => void) {
    if (phase.t !== 'ready') return
    if (list.length === 0) return
    let ok = 0
    const skipped: string[] = []
    for (const f of list) {
      if (/\.epub$/i.test(f.name)) {
        skipped.push(`${f.name}（电子书请拖到「书架」）`)
        continue
      }
      const kind = previewOf(f.name)
      const isMd = /\.md$/i.test(f.name)
      if (!isMd && !kind) {
        skipped.push(`${f.name}（这个类型文件区还显示不了）`)
        continue
      }
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        const dest = uniqueRepoPath(dir, f.name)
        await phase.host.write(dest, bytes)
        if (isMd) {
          const text = decodeBytes(bytes)
          setFiles((prev) => ({ ...prev, [dest]: text }))
          baseline.current = { ...baseline.current, files: { ...baseline.current.files, [dest]: text } }
        } else {
          setAssets((prev) => [...prev, dest])
        }
        ok += 1
        if (kind === 'image' && insertImage) {
          const { attachPath, attachName } = await import('./core/model/attach')
          // 图片进附件后由编辑器插入引用
          const attach = attachPath(attachName(f.name, f.type))
          await phase.host.write(attach, bytes)
          insertImage(attach)
        }
      } catch (e) {
        skipped.push(`${f.name}（${String(e)}）`)
      }
    }
    if (ok) say('ok', `已导入 ${ok} 个文件到${dir ? `「${dir}」` : '仓库根目录'}`)
    if (skipped.length) say('warn', `跳过：${skipped.join('；')}`)
  }

  /** 把一批绝对路径放进仓库（桌面端原生拖入） */
  async function dropRepoPaths(paths: string[], dir: string, insertImage?: (path: string) => void) {
    if (phase.t !== 'ready') return
    const skipped: string[] = []
    let ok = 0
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() ?? p
      try {
        const st = await statPath(p)
        if (/\.epub$/i.test(name)) {
          skipped.push(`${name}（电子书请拖到「书架」）`)
          continue
        }
        const kind = previewOf(name)
        const isMd = /\.md$/i.test(name)
        if (!isMd && !kind) {
          skipped.push(`${name}（这个类型文件区还显示不了）`)
          continue
        }
        const dest = uniqueRepoPath(dir, name)
        await importPath(p, phase.host.where, dest)
        if (isMd) {
          const text = decodeBytes(await phase.host.read(dest))
          setFiles((prev) => ({ ...prev, [dest]: text }))
          baseline.current = { ...baseline.current, files: { ...baseline.current.files, [dest]: text } }
        } else {
          setAssets((prev) => [...prev, dest])
        }
        ok += 1
        if (kind === 'image' && insertImage) insertImage(dest)
        void st
      } catch (e) {
        skipped.push(`${name}（${String(e)}）`)
      }
    }
    if (ok) say('ok', `已导入 ${ok} 个文件到${dir ? `「${dir}」` : '仓库根目录'}`)
    if (skipped.length) say('warn', `跳过：${skipped.join('；')}`)
  }

  /**
   * 桌面端原生拖入（Tauri v2 `onDragDropEvent`）。
   * 位置是**物理像素**，先除以 devicePixelRatio 再做命中测试。
   */
  const dropHandler = useRef<(paths: string[], zone: string, dir: string | null) => void>(() => {})
  dropHandler.current = (paths: string[], zone: string, dir: string | null) => {
    void (async () => {
      if (zone === 'shelf-list' || zone === 'shelf-welcome' || zone === 'reader') {
        const looksEpub = paths.filter((p) => /\.epub$/i.test(p))
        const rest = paths.length - looksEpub.length
        if (rest > 0) say('warn', `书架只收 .epub，另有 ${rest} 个文件被跳过`)
        if (looksEpub.length === 0) return
        const { statPath: stat } = await import('./hosts/tauri')
        const items = [] as { kind: 'path'; path: string; name: string; size: number }[]
        const bad: string[] = []
        for (const p of looksEpub) {
          try {
            const st = await stat(p)
            items.push({ kind: 'path', path: p, name: st.name, size: st.size })
          } catch (e) {
            // 不能静默跳过：用户会以为书导进去了
            bad.push(`${p.split(/[\\/]/).pop() ?? p}（${String(e)}）`)
          }
        }
        if (bad.length) say('error', `这些文件读不了，没有导入：${bad.join('；')}`)
        if (items.length === 0) return
        const results = await shelf.importFiles(items)
        if (zone === 'reader') {
          const first = results.find((r) => r.ok && r.bookId && !r.duplicate)
          if (first?.bookId) openShelfBook(first.bookId)
        }
        return
      }

      if (zone === 'editor') {
        const images = paths.filter((p) => previewOf(p.split(/[\\/]/).pop() ?? '') === 'image')
        const others = paths.length - images.length
        if (others > 0) say('warn', `编辑器只接收图片，另有 ${others} 个文件被跳过（电子书请拖到书架）`)
        for (const p of images) {
          const name = p.split(/[\\/]/).pop() ?? 'image'
          const { attachName, attachPath } = await import('./core/model/attach')
          const dest = attachPath(attachName(name, ''))
          try {
            await importPath(p, phase.t === 'ready' ? phase.host.where : '', dest)
            window.dispatchEvent(new CustomEvent('dd:insert-image', { detail: { path: dest } }))
          } catch (e) {
            say('error', `图片导入失败：${String(e)}`)
          }
        }
        return
      }

      if (zone === 'tree' || zone === 'tree-blank') {
        await dropRepoPaths(paths, dir ?? '')
      }
    })()
  }

  /* 浏览器里把文件拖到"没人接"的地方：拦下来，别让 webview 直接打开文件 */
  useEffect(() => {
    const onOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      if (e.defaultPrevented) return
      e.preventDefault()
      say('warn', '这里不收文件：电子书拖到「书架」，图片可以拖进编辑器')
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [say])

  useEffect(() => {
    if (!isTauri()) return
    let un: (() => void) | null = null
    let disposed = false
    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview')
        const { targetAt, setHighlight } = await import('./ui/dnd')
        un = await getCurrentWebview().onDragDropEvent((ev) => {
          const p = ev.payload as {
            type: string
            paths?: string[]
            position?: { x: number; y: number }
          }
          const dpr = window.devicePixelRatio || 1
          if (p.type === 'leave') {
            setHighlight(null)
            return
          }
          const pos = p.position ?? { x: 0, y: 0 }
          const t = targetAt(pos.x / dpr, pos.y / dpr)
          if (p.type === 'enter' || p.type === 'over') {
            setHighlight(t)
            return
          }
          if (p.type === 'drop') {
            setHighlight(null)
            dropHandler.current(p.paths ?? [], t?.zone ?? 'none', t?.dir ?? null)
          }
        })
        if (disposed) un?.()
      } catch (e) {
        console.warn('[dusk] 原生拖放没接上', e)
      }
    })()
    return () => {
      disposed = true
      un?.()
    }
  }, [])

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
          stage={openStage}
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
        <Rail
          space={space}
          onSpace={(next) => {
            if (space === 'shelf' && next !== 'shelf') flushReaderProgress()
            setSpace(next)
            setTreeOpen(true)
          }}
          treeOpen={treeOpen}
          onToggleTree={() => setTreeOpen((v) => !v)}
          onSettings={() => setSettingsOpen(true)}
        />

        {treeOpen ? (
          space === 'shelf' ? (
            <ShelfPanel
              api={shelf}
              activeId={shelf.openId}
              onPick={openShelfBook}
              onAdd={() => void shelf.addBooks()}
              onChooseDir={() => void chooseShelfDir()}
              onRetry={() => {
                if (shelf.config) void shelf.reload(shelf.config).catch((e) => say('error', String(e)))
              }}
              onRegrant={() => void shelf.regrant()}
              onRescan={() => void shelf.rescan()}
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
          ) : (
        <TreePanel
            tree={tree}
            current={current}
            expanded={expanded}
            onToggle={toggleDir}
            onOpen={openNote}
            onOpenTab={openInNewTab}
            onOpenSplit={openInSplit}
            onNewNote={createNote}
            onNewNoteDoc={createNoteDoc}
            onNewFolder={createFolder}
            onRename={doRename}
            canReveal={phase.host.capabilities.reveal}
            onReveal={(p) => void revealRepo(p)}
            onCopyPath={(p) => void copyRepoPath(p)}
            onDropFiles={(list, dir) => void dropRepoFiles(list, dir)}
            onMove={doMove}
            onDelete={doDelete}
            icons={icons}
            onSetIcon={setDirIcon}
            onPickIcon={setIconTarget}
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
            files={files}
            noteDocs={noteDocs.length}
            onCollapse={() => setTreeOpen(false)}
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
          )
        ) : null}

        {space === 'shelf' ? (
          <ShelfMain
            api={shelf}
            book={shelf.books.find((b) => b.id === shelf.openId) ?? null}
            settings={readerSettings}
            onSettings={setReaderSettings}
            loc={readerLoc}
            readerApi={readerApi}
            onToc={setReaderToc}
            onLoc={onReaderLocation}
            onReaderApi={setReaderApi}
            onBookmark={addShelfBookmark}
            onAdd={() => void shelf.addBooks()}
            onChooseDir={() => void chooseShelfDir()}
            onOpenBook={openShelfBook}
            onExternal={(href) => {
              if (/^https?:/i.test(href) && window.confirm(`要在系统浏览器里打开这个链接吗？\n\n${href}`)) {
                window.open(href, '_blank', 'noopener,noreferrer')
              }
            }}
          />
        ) : (
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
                  linkTargets={linkTargets}
                  assist={settings.assist}
                  /*
                   * ⚠️ 必须按**这一栏自己的** active 算，不能用全局 current（那是焦点栏的文档）。
                   * 用全局值时：非焦点栏里的 .note 拿不到 noteDir，块编辑器不渲染；
                   * 焦点栏是 .note 时，所有栏又都去渲染同一个块编辑器 —— 分栏直接废掉。
                   */
                  noteDir={
                    pane.active && noteDocs.includes(pane.active) ? pane.active : null
                  }
                  onNotice={(text) => say('warn', text)}
                  onAddToShelf={(p) => void addRepoEpubToShelf(p)}
                  onOpenShelf={() => setSpace('shelf')}
                  shelfCanAdd={shelf.status === 'ready' && !shelf.importing}
                  shelfBusy={shelf.importing}
                  shelfReason={
                    shelf.status === 'setup'
                      ? '先到左侧「书架」选一个书架目录，再回来添加'
                      : shelf.status === 'error'
                        ? '书架现在打不开，先去「书架」处理一下'
                        : undefined
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
        )}

        {/*
        右栏大纲跟着**最右边那一栏**走，不跟焦点 ——
        跟焦点会出现"点一下另一栏，宽度就变"的现象（大纲被隐藏/显示，两侧跟着重排）。

        `.note` 也有右栏：大纲来自块编辑器上报的块标题，
        反链/悬空链接用"md 文件 + 各 .note 正文"的合并表算。
      */}
      {space === 'shelf' ? (
        <ShelfAside
          open={asideOpen}
          width={rightW}
          book={shelf.books.find((b) => b.id === shelf.openId) ?? null}
          toc={readerToc}
          loc={readerLoc}
          onGoTo={(href) => readerApi?.goTo(href)}
          onGoToMark={(m) => (m.cfi ? readerApi?.goTo(m.cfi) : readerApi?.goToPercent(m.percent))}
          onDropMark={(id) => {
            if (!shelf.openId) return
            if (shelf.dropMark(shelf.openId, id)) say('ok', '已删除书签')
            else say('warn', '这条书签已经不在了')
          }}
          onClose={() => setAsideOpen(false)}
          resizer={
            <Resizer
              side="right"
              flush
              width={rightW}
              min={SIDEBAR_MIN}
              max={SIDEBAR_MAX}
              onChange={setRightW}
              onReset={() => setRightW(SIDEBAR_DEFAULT.R)}
            />
          }
        />
      ) : lastDoc ? (
        kindOf(lastDoc) !== 'md' && !noteDocs.includes(lastDoc) ? (
          // 图片 / PDF：右栏没有大纲和反链可算，换成这一类文件真有的信息
          <AssetInfo
            path={lastDoc}
            open={asideOpen}
            width={rightW}
            onClose={() => setAsideOpen(false)}
            resizer={
              <Resizer
                side="right"
                flush
                width={rightW}
                min={SIDEBAR_MIN}
                max={SIDEBAR_MAX}
                onChange={setRightW}
                onReset={() => setRightW(SIDEBAR_DEFAULT.R)}
              />
            }
          />
        ) : (
          <Aside
            open={asideOpen}
            files={asideFiles}
            path={lastDoc}
            noteOutline={noteDocs.includes(lastDoc) ? noteInfo[lastDoc]?.outline : undefined}
            onOpen={openNote}
            onClose={() => setAsideOpen(false)}
            width={rightW}
            resizer={
              <Resizer
                side="right"
                flush
                width={rightW}
                min={SIDEBAR_MIN}
                max={SIDEBAR_MAX}
                onChange={setRightW}
                onReset={() => setRightW(SIDEBAR_DEFAULT.R)}
              />
            }
          />
        )
      ) : null}
      </div>

      {toast || shelf.notice ? (
        <div
          role="status"
          className={[
            'fixed bottom-5 left-1/2 z-[70] flex max-w-[min(560px,90vw)] -translate-x-1/2 items-start gap-1 rounded-lg border px-3.5 py-2 text-[12px] shadow-[0_10px_28px_rgba(16,35,28,0.16)]',
            (toast?.kind ?? shelf.notice?.kind) === 'error'
              ? 'border-[#f0c9c5] bg-[#fdf0ef] text-[#8f1d17]'
              : (toast?.kind ?? shelf.notice?.kind) === 'warn'
                ? 'border-[#f0e2c4] bg-[#fdf8ec] text-[#7a5b18]'
                : 'border-line bg-surface text-ink-2',
          ].join(' ')}
        >
          <span className="break-words">{toast?.text ?? shelf.notice?.text}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => {
              setToast(null)
              shelf.setNotice(null)
            }}
            className="ml-2 shrink-0 rounded px-1 text-[13px] leading-none opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </div>
      ) : null}

      {shelfMove ? (
        <ShelfMoveDialog
          target={shelfMove.target}
          info={shelfMove.info}
          busy={shelfBusy}
          error={shelfMoveError}
          progress={moveProgress}
          onMove={() => void applyShelfMove('move')}
          onUse={() => void applyShelfMove('use')}
          onCancel={() => {
            if (shelfBusy) return
            setShelfMove(null)
            setShelfMoveError(null)
          }}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
          onReset={() => setSettings(resetSettings())}
          shelf={{
            where: shelf.shelf?.where ?? '',
            kind: shelf.shelf?.kind ?? '',
            durable: shelf.shelf?.durable ?? false,
            canReveal: shelf.shelf?.canReveal ?? false,
            nameOnly: shelf.shelf?.nameOnly ?? false,
            busy: shelfBusy || shelf.status === 'loading',
            importing: shelf.importing,
            error: shelf.error,
            canRegrant: shelf.errorRegrant,
            onChange: () => void chooseShelfDir(),
            onReveal: () => void shelf.reveal(),
            onRetry: () => {
              if (shelf.config) void shelf.reload(shelf.config).catch((e) => say('error', String(e)))
            },
            onRegrant: () => void shelf.regrant(),
          }}
        />
      ) : null}

      {/* 给文件夹挑图标：点外面 / Esc 关掉；选完立刻写进 .zzq */}
      {iconTarget ? (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-ink/25 p-6"
          onClick={() => setIconTarget(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setIconTarget(null)
          }}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <SymbolPanel
              title={`${iconTarget.split('/').pop() ?? iconTarget} 的图标`}
              current={icons[iconTarget] ?? null}
              onClose={() => setIconTarget(null)}
              onPick={(ch) => {
                setDirIcon(iconTarget, ch)
                setIconTarget(null)
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
