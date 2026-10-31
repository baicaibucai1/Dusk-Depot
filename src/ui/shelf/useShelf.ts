/*
 * 书架的运行时状态：目录、清单、导入、阅读进度。
 *
 * 一条硬边界：**这里从来不动仓库**。所有读写都走 `shelf.host`（root = 书架目录），
 * 仓库的 FileMap / .zzq / .note 里不会出现任何书籍条目。
 *
 * ## 三条并发纪律（都是踩过坑之后加的）
 *
 *   ① **串行**：导入、清单写入、换目录全走同一把锁。以前导入中途换目录，
 *      旧目录的清单会被写进新目录。
 *   ② **代次**：每个目录一个 `generation`。延迟任务（防抖保存、阅读进度）
 *      执行时先核对代次，旧目录的账绝不写进新目录。
 *   ③ **待存不丢**：只有写成功才清 `pending`。失败保留、界面红条、可重试；
 *      以前先清后写，失败之后连重试的机会都没有。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { decodeBytes, encodeText } from '../../core/model/text'
import {
  type Book,
  type Bookmark,
  type Library,
  LIBRARY_FILE,
  MAX_BOOK_BYTES,
  activeBooks,
  emptyLibrary,
  hashBytes,
  markRestored,
  markTrashed,
  parseLibrary,
  patchBook,
  rebuildFromFiles,
  removeBookEntry,
  safeFileName,
  serializeLibrary,
  trashedBooks,
  uniqueFileName,
  upsertBook,
} from '../../core/shelf/library'
import { classifyEpubError, encryptionOfBytes, epubErrorMessage, looksLikeEpub, openEpub } from '../../core/shelf/epub'
import {
  type Shelf,
  type ShelfConfig,
  type ShelfTarget,
  commitShelfTarget,
  defaultShelfConfig,
  hasShelfHandle,
  loadShelfConfig,
  openShelf,
  openShelfTarget,
  regrantShelf,
} from '../../core/shelf/store'
import { moveWithin } from '../../core/shelf/migrate'
import type { Host } from '../../core/ports/host'

export type ImportItem =
  | { kind: 'file'; file: File }
  | { kind: 'path'; path: string; name: string; size: number }
  /** 仓库里已有的 EPUB：已经读成字节了 */
  | { kind: 'bytes'; name: string; bytes: Uint8Array }

export type ImportResult = {
  name: string
  ok: boolean
  message: string
  bookId?: string
  duplicate?: boolean
  /** 重复的那本在回收站里：给"还原"提示，不给"打开" */
  trashed?: boolean
}

export type ImportProgress = {
  done: number
  total: number
  current: string
  results: ImportResult[]
  /** 复制 / 读元数据 —— 界面上的文案跟着变 */
  phase: 'copy' | 'meta'
  cancelled: boolean
}

export type Notice = { kind: 'ok' | 'warn' | 'error'; text: string; at: number }

export type SaveState =
  | { kind: 'saved' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string; at: number }

type Status = 'loading' | 'ready' | 'setup' | 'error'

/** 一次待写的清单。带上目录身份，旧目录的账绝不写进新目录 */
type Pending = { gen: number; host: Host; lib: Library }

const EPUB_EXT = /\.epub$/i

async function listEpubs(host: Host): Promise<{ path: string; size: number; mtime: number }[]> {
  const entries = await host.list()
  return entries
    .filter((e) => e.kind === 'file' && EPUB_EXT.test(e.path) && !e.path.includes('/'))
    .map((e) => ({ path: e.path, size: e.size, mtime: e.mtime }))
}

async function readText(host: Host, path: string): Promise<string | null> {
  try {
    return decodeBytes(await host.read(path))
  } catch {
    return null
  }
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

export function useShelf() {
  const [config, setConfig] = useState<ShelfConfig | null>(() => loadShelfConfig())
  const [shelf, setShelf] = useState<Shelf | null>(null)
  const [library, setLibrary] = useState<Library>(() => emptyLibrary())
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [errorRegrant, setErrorRegrant] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [importing, setImporting] = useState(false)
  /** 上一次导入的逐项结果（成功/重复/失败都要能看见原因） */
  const [report, setReport] = useState<ImportResult[] | null>(null)
  /** 失败项：可以原样再试一次 */
  const [failed, setFailed] = useState<ImportItem[]>([])
  /** 重复的书：在列表里闪一下，把人带到原条目 */
  const [locateId, setLocateId] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'saved' })
  const [openId, setOpenId] = useState<string | null>(null)

  const saveTimer = useRef(0)
  const pendingRef = useRef<Pending | null>(null)
  const shelfRef = useRef<Shelf | null>(null)
  const configRef = useRef<ShelfConfig | null>(config)
  const libRef = useRef<Library>(library)
  const genRef = useRef(0)
  const importingRef = useRef(false)
  const cancelRef = useRef(false)
  const failedRef = useRef<ImportItem[]>([])
  const tailRef = useRef<Promise<unknown>>(Promise.resolve())

  shelfRef.current = shelf
  libRef.current = library
  configRef.current = config

  const say = useCallback((kind: Notice['kind'], text: string) => {
    setNotice({ kind, text, at: Date.now() })
  }, [])

  /* ── 一把锁：导入 / 保存 / 换目录都排队 ── */
  const lock = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = tailRef.current.then(fn, fn)
    tailRef.current = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }, [])

  /* ── 写清单 ── */

  const schedule = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void lock(async () => {
        await writePendingRef.current()
      })
    }, 350)
  }, [lock])

  /** 真正落盘。**只有成功才清待存**；失败保留原样，等用户重试 */
  const writePending = useCallback(async (): Promise<boolean> => {
    const job = pendingRef.current
    if (!job) {
      setSaveState((s) => (s.kind === 'error' ? s : { kind: 'saved' }))
      return true
    }
    if (job.gen !== genRef.current) {
      // 旧目录的账：换目录前已经 flush 过，这里只剩竞态尾巴，丢掉是对的
      pendingRef.current = null
      return true
    }
    setSaveState({ kind: 'saving' })
    try {
      await job.host.write(LIBRARY_FILE, encodeText(serializeLibrary(job.lib)))
      if (pendingRef.current === job) pendingRef.current = null
      if (pendingRef.current) {
        setSaveState({ kind: 'dirty' })
        schedule()
      } else {
        setSaveState({ kind: 'saved' })
      }
      return true
    } catch (e) {
      // 关键：**不清 pending**。可能在写的过程中又有更新的版本进来，保留最新的那份
      if (!pendingRef.current) pendingRef.current = job
      setSaveState({ kind: 'error', message: messageOf(e), at: Date.now() })
      return false
    }
  }, [schedule])

  const writePendingRef = useRef(writePending)
  writePendingRef.current = writePending

  const persist = useCallback(
    (next: Library) => {
      const s = shelfRef.current
      if (!s) return
      setLibrary(next)
      libRef.current = next
      pendingRef.current = { gen: genRef.current, host: s.host, lib: next }
      setSaveState((prev) => (prev.kind === 'error' ? prev : { kind: 'dirty' }))
      schedule()
    },
    [schedule],
  )

  const saveNow = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(saveTimer.current)
    return lock(writePending)
  }, [lock, writePending])

  /* ── 打开目录 + 读清单 ── */

  /**
   * 必须在锁里调用。
   * `commit` 为 true 时，只有在目录**成功打开并读完清单之后**才写配置和句柄；
   * 失败则原样保留旧书架 —— 这是"取消换目录不影响当前书架"的另一半。
   */
  const bootTarget = useCallback(
    async (target: ShelfTarget, commit: boolean): Promise<boolean> => {
      const prev = shelfRef.current
      const prevLib = libRef.current
      genRef.current += 1
      const gen = genRef.current

      setStatus('loading')
      setError(null)
      setErrorRegrant(false)

      const opened =
        target.cfg.kind === 'fsa' && target.handle
          ? await openShelfTarget(target)
          : await openShelf(target.cfg)
      if (!opened.ok) {
        if (prev) {
          setShelf(prev)
          shelfRef.current = prev
          setLibrary(prevLib)
          libRef.current = prevLib
          setStatus('ready')
          setError(opened.error)
          setErrorRegrant(Boolean(opened.canRegrant))
        } else {
          setShelf(null)
          shelfRef.current = null
          setStatus(opened.reason === 'no-config' ? 'setup' : 'error')
          setError(opened.error)
          setErrorRegrant(Boolean(opened.canRegrant))
        }
        return false
      }

      const s = opened.shelf
      setShelf(s)
      shelfRef.current = s
      setOpenId(null)
      pendingRef.current = null

      try {
        await s.host.mkdir('')
      } catch {
        /* 根目录已存在时会抛，忽略 */
      }

      let raw: string | null = null
      try {
        raw = await readText(s.host, LIBRARY_FILE)
      } catch (e) {
        setStatus('error')
        setError(`书架清单读不出来：${messageOf(e)}`)
        return false
      }

      let lib: Library
      let repaired = ''
      const parsed = parseLibrary(raw)
      if (!parsed.ok) {
        // 清单坏了：先备份，再从目录里真实存在的书重建 —— 书不能因为清单坏了就消失
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        try {
          await s.host.write(`library.broken-${stamp}.json`, encodeText(raw ?? ''))
        } catch {
          /* 备份失败也别挡着重开 */
        }
        lib = emptyLibrary()
        repaired = `书架清单损坏（${parsed.error}），已备份并重建。书还在目录里，没有删任何文件。`
      } else {
        lib = parsed.library
        if (parsed.warnings.length) repaired = parsed.warnings.join('；')
      }

      // 跟磁盘对一遍：文件没了标 broken，多出来的补进清单
      try {
        const files = await listEpubs(s.host)
        const known = new Set(activeBooks(lib).map((b) => b.file.toLowerCase()))
        const onDisk = new Set(files.map((f) => f.path.toLowerCase()))

        const marked = lib.books.map((b) =>
          b.trashedAt || onDisk.has(b.file.toLowerCase()) ? b : { ...b, broken: true },
        )
        const fresh = files.filter((f) => !known.has(f.path.toLowerCase()))
        const added = fresh.length ? rebuildFromFiles(fresh, marked) : []

        lib = { ...lib, books: [...marked, ...added] }
        if (added.length) {
          repaired = repaired || `在书架目录里发现 ${added.length} 本没有登记的书，已补进列表`
        }
      } catch (e) {
        repaired = repaired || `列书架目录失败：${messageOf(e)}`
      }

      setLibrary(lib)
      libRef.current = lib

      if (commit) {
        const saved = await commitShelfTarget(target)
        setConfig(target.cfg)
        configRef.current = target.cfg
        if (!saved.configSaved) {
          repaired = `${repaired ? `${repaired}；` : ''}换好了，但浏览器没记住这个书架位置（本地存储被禁），下次打开要重选`
        } else if (!saved.handleSaved) {
          repaired = `${repaired ? `${repaired}；` : ''}换好了，但浏览器没记住目录授权（IndexedDB 不可用），下次打开要重新授权`
        }
      }

      setStatus('ready')
      if (repaired) say('warn', repaired)

      // 补登记的新书要落盘；失败也要让用户看见（不是只写 console）
      if (lib.books.some((b) => b.id.startsWith('pending-')) || repaired.includes('补进列表')) {
        pendingRef.current = { gen, host: s.host, lib }
        const ok = await writePending()
        if (!ok) say('warn', '有新增书目还没写进书架清单，页面底部可以重试保存')
      }
      return true
    },
    [say, writePending],
  )

  /* 第一次进来：没有配置就用默认位置；浏览器没有目录授权就进"待设置" */
  useEffect(() => {
    let alive = true
    void (async () => {
      const saved = loadShelfConfig()
      if (saved) {
        if (!alive) return
        setConfig(saved)
        await lock(() =>
          bootTarget({ cfg: saved, label: saved.dir, nameOnly: saved.kind === 'fsa' }, false),
        )
        return
      }
      const fallback = await defaultShelfConfig()
      if (!alive) return
      if (fallback) {
        if (!alive) return
        await lock(() =>
          bootTarget({ cfg: fallback, label: fallback.dir, nameOnly: false }, true),
        )
      } else {
        setStatus('setup')
      }
    })()
    return () => {
      alive = false
    }
  }, [bootTarget, lock])

  /**
   * 换到另一个目录。
   * 顺序：拒绝导入中 → 把旧清单写完（写不完就不切）→ 开新目录 → 提交配置。
   */
  const useConfig = useCallback(
    async (target: ShelfTarget): Promise<void> => {
      await lock(async () => {
        if (importingRef.current) throw new Error('正在导入，等这一批结束再换书架')
        const ok = await writePending()
        if (!ok) throw new Error('书架清单还有没保存的改动，先点「重试保存」再换目录')
        const done = await bootTarget(target, true)
        if (!done) throw new Error('新目录打不开，当前书架没有改变')
      })
    },
    [bootTarget, lock, writePending],
  )

  /** 重试：重新打开当前目录（不动配置、不动句柄） */
  const reload = useCallback(
    async (cfg: ShelfConfig): Promise<boolean> => {
      return lock(async () => {
        if (importingRef.current) throw new Error('正在导入，先等这一批结束')
        const ok = await writePending()
        if (!ok) throw new Error('书架清单还有没保存的改动，先重试保存')
        const current = shelfRef.current
        return bootTarget(
          {
            cfg,
            handle: current?.kind === 'fsa' ? current.handle : undefined,
            label: cfg.dir,
            nameOnly: cfg.kind === 'fsa',
          },
          false,
        )
      })
    },
    [bootTarget, lock, writePending],
  )

  /** 重新授权：**必须**由一次点击直接调用（浏览器要用户手势） */
  const regrant = useCallback(async (): Promise<boolean> => {
    const ok = await regrantShelf()
    if (!ok) {
      // 句柄还在就允许再试一次；真的没句柄了才引导"重新选目录"
      setError('重新授权没有成功（可能点了拒绝，或浏览器不允许）。可以再试一次，或重新选一个目录。')
      setErrorRegrant(await hasShelfHandle().catch(() => false))
      return false
    }
    const cfg = configRef.current
    if (!cfg) return false
    return reload(cfg)
  }, [reload])

  /* 页关掉/切走前尽量把清单刷下去 */
  useEffect(() => {
    const onHide = () => {
      void saveNow()
    }
    window.addEventListener('pagehide', onHide)
    window.addEventListener('beforeunload', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('beforeunload', onHide)
      void saveNow()
    }
  }, [saveNow])

  /* ── 导入 ── */

  const readBytesOf = async (item: ImportItem): Promise<Uint8Array> => {
    if (item.kind === 'file') return new Uint8Array(await item.file.arrayBuffer())
    if (item.kind === 'bytes') return item.bytes
    // 桌面路径：Rust 已经复制进来了，这里读回来做校验 / 哈希
    const s = shelfRef.current
    if (!s) throw new Error('书架还没打开')
    return s.host.read(item.path)
  }

  const importFiles = useCallback(
    async (items: ImportItem[]): Promise<ImportResult[]> => {
      const s = shelfRef.current
      if (!s || status !== 'ready') {
        say('warn', '书架还没准备好，先选一个书架目录')
        return []
      }
      if (importingRef.current) {
        say('warn', '上一批还在导入，等它结束再添加')
        return []
      }

      return lock(async () => {
        const target = shelfRef.current
        if (!target) return []
        const gen = genRef.current
        importingRef.current = true
        cancelRef.current = false
        setImporting(true)
        setReport(null)

        const results: ImportResult[] = []
        const retry: ImportItem[] = []
        const total = items.length
        setProgress({ done: 0, total, current: items[0] ? nameOf(items[0]) : '', results: [], phase: 'copy', cancelled: false })

        const done = (r: ImportResult, phase: ImportProgress['phase'] = 'copy') => {
          results.push(r)
          setProgress({ done: results.length, total, current: r.name, results: [...results], phase, cancelled: cancelRef.current })
        }

        // 目标目录里真实存在的名字也要算进"已占用"—— 不能只信清单
        let taken: string[] = []
        try {
          const names = await listEpubs(target.host)
          taken = names.map((n) => n.path)
        } catch {
          taken = []
        }
        taken = [...taken, ...libRef.current.books.map((b) => b.fileName)]

        let lib = libRef.current

        for (let i = 0; i < total; i++) {
          if (cancelRef.current) {
            const left = items.slice(i)
            for (const it of left) {
              results.push({ name: nameOf(it), ok: false, message: '已取消，没有导入' })
            }
            setProgress({ done: total, total, current: '', results: [...results], phase: 'copy', cancelled: true })
            break
          }
          const item = items[i] as ImportItem
          const name = nameOf(item)
          const size = sizeOf(item)
          setProgress({ done: i, total, current: name, results: [...results], phase: 'copy', cancelled: false })

          if (gen !== genRef.current) {
            done({ name, ok: false, message: '书架已经换了，这一项没有导入' })
            continue
          }
          if (!EPUB_EXT.test(name)) {
            const hint = /\.(md|txt|pdf|png|jpe?g|gif|webp)$/i.test(name) ? '书架只收 .epub；这个文件请放回文件区' : '书架只收 .epub'
            done({ name, ok: false, message: hint })
            retry.push(item)
            continue
          }
          if (size > MAX_BOOK_BYTES) {
            done({
              name,
              ok: false,
              message: `超过单本上限 ${Math.round(MAX_BOOK_BYTES / 1024 / 1024)}MB（这本 ${(size / 1024 / 1024).toFixed(1)}MB），没有复制`,
            })
            continue
          }

          let placed: string | null = null
          try {
            let dest = uniqueFileName(name, taken)
            // 目标文件已存在（清单没登记 / 上一轮残留）→ 再退一个名字，绝不覆盖
            for (let k = 0; k < 50; k++) {
              if (!(await target.host.exists?.(dest))) break
              dest = uniqueFileName(`${dest.replace(/\.epub$/i, '')} (${k + 2})`, taken)
            }
            if (await target.host.exists?.(dest)) throw new Error('目标文件名一直被占用')

            // 字节只读一次：浏览器里 200MB 的文件读两遍就是白白多占一份内存
            let bytes: Uint8Array
            if (item.kind === 'path') {
              if (target.kind !== 'tauri') throw new Error('这个导入方式只在桌面端可用')
              const { importPath } = await import('../../hosts/tauri')
              await importPath(item.path, target.where, dest)
              bytes = await target.host.read(dest)
            } else {
              bytes = await readBytesOf(item)
              await target.host.write(dest, bytes)
            }
            placed = dest
            taken.push(dest)
            if (!looksLikeEpub(bytes)) {
              await target.host.remove(dest).catch(() => {})
              done({ name, ok: false, message: '这个文件不是标准 EPUB（缺少 mimetype），没有加入书架' })
              retry.push(item)
              continue
            }
            if ((await encryptionOfBytes(bytes)) === 'drm') {
              await target.host.remove(dest).catch(() => {})
              done({ name, ok: false, message: '这本书带 DRM 保护，不支持阅读，未加入书架' })
              continue
            }

            const id = await hashBytes(bytes)
            const dup = lib.books.find((b) => b.id === id)
            if (dup) {
              await target.host.remove(dest).catch(() => {})
              setLocateId(dup.id)
              done({
                name,
                ok: true,
                duplicate: true,
                bookId: dup.id,
                trashed: Boolean(dup.trashedAt),
                message: dup.trashedAt
                  ? `已在回收站里：《${dup.title}》，可以还原`
                  : `已在书架中：《${dup.title}》`,
              })
              continue
            }

            setProgress({ done: i, total, current: name, results: [...results], phase: 'meta', cancelled: false })
            const opened = await openEpub(arrayBufferOf(bytes))
            const meta = opened.meta
            opened.destroy()

            const book: Book = {
              id,
              file: dest,
              fileName: dest,
              title: meta.title || dest.replace(/\.epub$/i, ''),
              author: meta.author,
              ...(meta.publisher ? { publisher: meta.publisher } : {}),
              ...(meta.language ? { language: meta.language } : {}),
              ...(meta.cover ? { cover: meta.cover } : {}),
              size,
              mtime: Date.now(),
              addedAt: Date.now(),
              lastReadAt: 0,
              percent: 0,
              cfi: '',
              bookmarks: [],
            }
            lib = upsertBook(lib, book)
            libRef.current = lib
            persist(lib)
            done({ name, ok: true, bookId: id, message: `已加入：《${book.title}》` })
          } catch (e) {
            if (placed) await target.host.remove(placed).catch(() => {})
            const kind = classifyEpubError(e)
            done({
              name,
              ok: false,
              message: kind === 'unknown' ? `导入失败：${messageOf(e)}` : epubErrorMessage(kind),
            })
            retry.push(item)
          }
        }

        // 一批结束：把清单写下去（失败会保留 pending + 红条）
        const saved = await writePending()
        importingRef.current = false
        setImporting(false)
        setProgress(null)
        setReport(results)
        setFailed(retry)
        failedRef.current = retry

        const ok = results.filter((r) => r.ok && !r.duplicate).length
        const dup = results.filter((r) => r.duplicate).length
        const bad = results.filter((r) => !r.ok).length
        if (ok || dup || bad) {
          say(
            bad ? 'warn' : 'ok',
            `导入完成：成功 ${ok} 本${dup ? `，已在书架 ${dup} 本` : ''}${bad ? `，失败 ${bad} 本` : ''}${
              saved ? '' : '；清单没写进去，底部可重试保存'
            }`,
          )
        }
        return results
      })
    },
    [lock, persist, say, status, writePending],
  )

  const cancelImport = useCallback(() => {
    if (importingRef.current) cancelRef.current = true
  }, [])

  const retryFailed = useCallback(async () => {
    const items = failedRef.current
    if (items.length === 0) {
      say('warn', '没有需要重试的项目')
      return []
    }
    return importFiles(items)
  }, [importFiles, say])

  /** 从系统文件选择器添加（桌面端走绝对路径，浏览器走 File） */
  const addBooks = useCallback(async () => {
    const s = shelfRef.current
    if (!s || status !== 'ready') return
    if (importingRef.current) {
      say('warn', '上一批还在导入，等它结束再添加')
      return
    }
    if (s.kind === 'tauri') {
      const { pickTauriFiles, statPath } = await import('../../hosts/tauri')
      const paths = await pickTauriFiles('添加 EPUB 到书架', [{ name: 'EPUB 电子书', extensions: ['epub'] }])
      if (paths.length === 0) return
      const items: ImportItem[] = []
      const bad: string[] = []
      for (const p of paths) {
        try {
          const st = await statPath(p)
          items.push({ kind: 'path', path: p, name: st.name, size: st.size })
        } catch (e) {
          bad.push(`${p.split(/[\\/]/).pop() ?? p}（${messageOf(e)}）`)
        }
      }
      if (bad.length) say('error', `这些文件读不了，已跳过：${bad.join('；')}`)
      if (items.length) await importFiles(items)
      return
    }

    // 浏览器：input[type=file] 由调用方提供更顺手，这里兜底用隐藏 input
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.epub,application/epub+zip'
    input.multiple = true
    const files = await new Promise<File[]>((resolve) => {
      input.onchange = () => resolve([...(input.files ?? [])])
      input.oncancel = () => resolve([])
      input.click()
    })
    if (files.length) await importFiles(files.map((file) => ({ kind: 'file' as const, file })))
  }, [importFiles, say, status])

  /* ── 阅读状态 ── */

  const patchReading = useCallback(
    (id: string, patch: Partial<Book>) => {
      const book = libRef.current.books.find((b) => b.id === id)
      if (!book || book.trashedAt) return
      const next = patchBook(libRef.current, id, { ...patch, lastReadAt: patch.lastReadAt ?? Date.now() })
      persist(next)
    },
    [persist],
  )

  /** 加书签。同一位置（CFI 相同或百分比几乎一样）不重复加 */
  const addMark = useCallback(
    (id: string, mark: Bookmark): 'ok' | 'dup' | 'missing' => {
      const book = libRef.current.books.find((b) => b.id === id)
      if (!book) return 'missing'
      const same = book.bookmarks.some(
        (m) => (mark.cfi && m.cfi === mark.cfi) || (!mark.cfi && Math.abs(m.percent - mark.percent) < 0.002),
      )
      if (same) return 'dup'
      persist(patchBook(libRef.current, id, { bookmarks: [...book.bookmarks, mark] }))
      return 'ok'
    },
    [persist],
  )

  const dropMark = useCallback(
    (id: string, markId: string): boolean => {
      const book = libRef.current.books.find((b) => b.id === id)
      if (!book) return false
      if (!book.bookmarks.some((m) => m.id === markId)) return false
      persist(patchBook(libRef.current, id, { bookmarks: book.bookmarks.filter((m) => m.id !== markId) }))
      return true
    },
    [persist],
  )

  /* ── 删除（先进回收站，文件不立刻删） ── */

  const removeBook = useCallback(
    async (id: string) => {
      await lock(async () => {
        const s = shelfRef.current
        const book = libRef.current.books.find((b) => b.id === id)
        if (!s || !book) return
        const dest = `.trash/${Date.now().toString(36)}-${safeFileName(book.fileName)}`
        try {
          await s.host.mkdir('.trash')
          if (await s.host.exists?.(book.file)) {
            await moveWithin(s.host, book.file, dest)
          } else {
            say('warn', `书架目录里已经找不到这个文件了：《${book.title}》。可以「从列表移除」，不会删任何东西`)
            return
          }
        } catch (e) {
          say('error', `删不掉这个文件：${messageOf(e)}`)
          return
        }
        const next = markTrashed(libRef.current, id, dest)
        persist(next)
        setOpenId((cur) => (cur === id ? null : cur))
        const saved = await writePending()
        say(
          saved ? 'ok' : 'warn',
          saved
            ? `已移到书架回收站：《${book.title}》（你自己的原始文件没动）`
            : `《${book.title}》已移到回收站，但清单没写进去，底部可重试保存`,
        )
      })
    },
    [lock, persist, say, writePending],
  )

  const restoreBook = useCallback(
    async (id: string) => {
      await lock(async () => {
        const s = shelfRef.current
        const book = libRef.current.books.find((b) => b.id === id)
        if (!s || !book?.trashFile) return
        try {
          if (!(await s.host.exists?.(book.trashFile))) {
            say('error', `回收站里找不到这个文件了：${book.trashFile}`)
            return
          }
          let back = book.file
          if (await s.host.exists?.(back)) back = uniqueFileName(back, libRef.current.books.map((b) => b.file))
          await moveWithin(s.host, book.trashFile, back)
          persist(markRestored(libRef.current, id, back))
          const saved = await writePending()
          say(saved ? 'ok' : 'warn', saved ? `已还原《${book.title}》` : `《${book.title}》已还原，但清单没写进去`)
        } catch (e) {
          say('error', `还原失败：${messageOf(e)}`)
        }
      })
    },
    [lock, persist, say, writePending],
  )

  const purgeBook = useCallback(
    async (id: string) => {
      await lock(async () => {
        const s = shelfRef.current
        const book = libRef.current.books.find((b) => b.id === id)
        if (!s || !book?.trashedAt) return
        try {
          if (book.trashFile && (await s.host.exists?.(book.trashFile))) {
            await s.host.remove(book.trashFile)
          }
        } catch (e) {
          say('error', `彻底删不掉：${messageOf(e)}`)
          return
        }
        persist(removeBookEntry(libRef.current, id))
        await writePending()
        say('ok', `已彻底删除《${book.title}》`)
      })
    },
    [lock, persist, say, writePending],
  )

  /** 只从列表里移除条目（文件已经不在了的时候用），不删任何文件 */
  const forgetBook = useCallback(
    async (id: string) => {
      await lock(async () => {
        const book = libRef.current.books.find((b) => b.id === id)
        if (!book) return
        persist(removeBookEntry(libRef.current, id))
        await writePending()
        say('ok', `已从列表移除《${book.title}》；没有删除任何文件`)
      })
    },
    [lock, persist, say, writePending],
  )

  const reveal = useCallback(
    async (book?: Book) => {
      const s = shelfRef.current
      if (!s?.host.reveal) {
        say('warn', '当前运行环境拿不到真实文件路径，没法在文件管理器里定位')
        return
      }
      const path = book ? book.trashFile ?? book.file : ''
      try {
        await s.host.reveal(path)
      } catch (e) {
        say('error', `打不开文件管理器：${messageOf(e)}`)
      }
    },
    [say],
  )

  const copyPath = useCallback(
    async (book: Book) => {
      const path = book.trashFile ?? book.file
      try {
        await navigator.clipboard.writeText(path)
        say('ok', `已复制：${path}`)
      } catch {
        say('warn', '剪贴板不可用')
      }
    },
    [say],
  )

  /** 换书前把上一本的进度刷下去；不 await，但队列保证顺序 */
  const openBook = useCallback(
    (id: string) => {
      void lock(async () => {
        await writePending()
      })
      setOpenId(id)
    },
    [lock, writePending],
  )
  const closeBook = useCallback(() => setOpenId(null), [])

  const clearError = useCallback(() => {
    setError(null)
    setErrorRegrant(false)
  }, [])

  const retrySave = useCallback(async (): Promise<boolean> => {
    const ok = await saveNow()
    if (ok) say('ok', '书架清单已保存')
    else say('error', '还是写不进去，检查一下书架目录的权限或磁盘空间')
    return ok
  }, [saveNow, say])

  /** 重新扫一遍目录：补登记新书、标出缺失。不动已有进度/书签 */
  const rescan = useCallback(async () => {
    const cfg = configRef.current
    if (!cfg) return
    try {
      const ok = await reload(cfg)
      if (ok) say('ok', '已重新扫描书架目录')
    } catch (e) {
      say('error', messageOf(e))
    }
  }, [reload, say])

  return {
    config,
    shelf,
    library,
    status,
    error,
    errorRegrant,
    notice,
    progress,
    importing,
    report,
    failedCount: failed.length,
    clearReport: () => setReport(null),
    retryFailed,
    cancelImport,
    locateId,
    clearLocate: () => setLocateId(null),
    saveState,
    retrySave,
    openId,
    books: activeBooks(library),
    trashBooks: trashedBooks(library),
    openBook,
    closeBook,
    addBooks,
    importFiles,
    removeBook,
    restoreBook,
    purgeBook,
    forgetBook,
    patchReading,
    addMark,
    dropMark,
    reveal,
    copyPath,
    setNotice,
    clearError,
    say,
    saveNow,
    useConfig,
    regrant,
    rescan,
    setOpenId,
    reload,
  }
}

function nameOf(item: ImportItem): string {
  return item.kind === 'file' ? item.file.name : item.name
}

function sizeOf(item: ImportItem): number {
  if (item.kind === 'file') return item.file.size
  if (item.kind === 'bytes') return item.bytes.length
  return item.size
}

export type ShelfApi = ReturnType<typeof useShelf>
