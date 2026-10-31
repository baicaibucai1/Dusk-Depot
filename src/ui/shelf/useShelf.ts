/*
 * 书架的运行时状态：目录、清单、导入、阅读进度。
 *
 * 一条硬边界：**这里从来不动仓库**。所有读写都走 `shelf.host`（root = 书架目录），
 * 仓库的 FileMap / .zzq / .note 里不会出现任何书籍条目。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { decodeBytes, encodeText } from '../../core/model/text'
import {
  type Book,
  type Bookmark,
  type Library,
  LIBRARY_FILE,
  MAX_BOOK_BYTES,
  emptyLibrary,
  hashBytes,
  parseLibrary,
  patchBook,
  rebuildFromFiles,
  removeBookEntry,
  serializeLibrary,
  uniqueFileName,
  upsertBook,
} from '../../core/shelf/library'
import { classifyEpubError, encryptionOfBytes, epubErrorMessage, looksLikeEpub, openEpub } from '../../core/shelf/epub'
import {
  type Shelf,
  type ShelfConfig,
  defaultShelfConfig,
  loadShelfConfig,
  openShelf,
  saveShelfConfig,
} from '../../core/shelf/store'
import type { Host } from '../../core/ports/host'

export type ImportItem =
  | { kind: 'file'; file: File }
  | { kind: 'path'; path: string; name: string; size: number }

export type ImportResult = {
  name: string
  ok: boolean
  message: string
  bookId?: string
  duplicate?: boolean
}

export type ImportProgress = { done: number; total: number; current: string; results: ImportResult[] }

export type Notice = { kind: 'ok' | 'warn' | 'error'; text: string; at: number }

type Status = 'loading' | 'ready' | 'setup' | 'error'

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
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function useShelf() {
  const [config, setConfig] = useState<ShelfConfig | null>(() => loadShelfConfig())
  const [shelf, setShelf] = useState<Shelf | null>(null)
  const [library, setLibrary] = useState<Library>(() => emptyLibrary())
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  /** 上一次导入的逐项结果（成功/重复/失败都要能看见原因） */
  const [report, setReport] = useState<ImportResult[] | null>(null)
  /** 重复的书：在列表里闪一下，把人带到原条目 */
  const [locateId, setLocateId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const saveTimer = useRef(0)
  const pendingLib = useRef<Library | null>(null)
  const shelfRef = useRef<Shelf | null>(null)
  const libRef = useRef<Library>(library)

  shelfRef.current = shelf
  libRef.current = library

  const say = useCallback((kind: Notice['kind'], text: string) => {
    setNotice({ kind, text, at: Date.now() })
  }, [])

  /* ── 写清单（防抖；强制刷新时用 saveNow） ── */
  const flush = useCallback(async () => {
    const job = pendingLib.current
    const s = shelfRef.current
    if (!job || !s) return
    pendingLib.current = null
    try {
      await s.host.write(LIBRARY_FILE, encodeText(serializeLibrary(job)))
    } catch (e) {
      setError(`书架清单写不进去：${String(e)}`)
    }
  }, [])

  const saveNow = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    await flush()
  }, [flush])

  const persist = useCallback(
    (next: Library) => {
      setLibrary(next)
      libRef.current = next
      pendingLib.current = next
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        void flush()
      }, 350)
    },
    [flush],
  )

  /* ── 打开目录 + 读清单 ── */
  const boot = useCallback(
    async (cfg: ShelfConfig) => {
      setStatus('loading')
      setError(null)
      const opened = await openShelf(cfg)
      if (!opened.ok) {
        setShelf(null)
        shelfRef.current = null
        setStatus(opened.reason === 'no-config' ? 'setup' : 'error')
        setError(opened.error)
        return
      }
      const s = opened.shelf
      setShelf(s)
      shelfRef.current = s

      let raw: string | null = null
      try {
        await s.host.mkdir('')
      } catch {
        /* 根目录已存在时会抛，忽略 */
      }
      raw = await readText(s.host, LIBRARY_FILE)

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
        const known = new Set(lib.books.map((b) => b.file.toLowerCase()))
        const onDisk = new Set(files.map((f) => f.path.toLowerCase()))

        const marked = lib.books.map((b) =>
          onDisk.has(b.file.toLowerCase()) ? b : { ...b, broken: true },
        )
        const fresh = files.filter((f) => !known.has(f.path.toLowerCase()))
        const added = fresh.length
          ? rebuildFromFiles(files.filter((f) => !known.has(f.path.toLowerCase())), marked)
          : []

        lib = { ...lib, books: [...marked, ...added] }
        if (added.length) {
          repaired = repaired || `在书架目录里发现 ${added.length} 本没有登记的书，已补进列表`
          pendingLib.current = lib
          await s.host.write(LIBRARY_FILE, encodeText(serializeLibrary(lib)))
        }
      } catch (e) {
        repaired = repaired || `列书架目录失败：${String(e)}`
      }

      setLibrary(lib)
      libRef.current = lib
      pendingLib.current = null
      setStatus('ready')
      // 修复过就说一声（是提示，不是错误 —— 书架本身是能用的）
      if (repaired) say('warn', repaired)
    },
    [],
  )

  /* 第一次进来：没有配置就用默认位置；浏览器没有目录授权就进"待设置" */
  useEffect(() => {
    let alive = true
    void (async () => {
      const saved = loadShelfConfig()
      if (saved) {
        if (alive) setConfig(saved)
        await boot(saved)
        return
      }
      const fallback = await defaultShelfConfig()
      if (!alive) return
      if (fallback) {
        saveShelfConfig(fallback)
        setConfig(fallback)
        await boot(fallback)
      } else {
        setStatus('setup')
      }
    })()
    return () => {
      alive = false
    }
  }, [boot])

  /* 切到另一个目录 */
  const useConfig = useCallback(
    async (cfg: ShelfConfig) => {
      saveShelfConfig(cfg)
      setConfig(cfg)
      setOpenId(null)
      await boot(cfg)
    },
    [boot],
  )

  /* 页关掉/切走前尽量把清单刷下去 */
  useEffect(() => {
    const onHide = () => {
      void flush()
    }
    window.addEventListener('pagehide', onHide)
    window.addEventListener('beforeunload', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('beforeunload', onHide)
      void flush()
    }
  }, [flush])

  /* ── 导入 ── */
  const importFiles = useCallback(
    async (items: ImportItem[]): Promise<ImportResult[]> => {
      const s = shelfRef.current
      if (!s) return []
      const results: ImportResult[] = []
      let lib = libRef.current
      const total = items.length
      setProgress({ done: 0, total, current: items[0]?.kind === 'file' ? items[0].file.name : '', results: [] })

      for (let i = 0; i < total; i++) {
        const item = items[i] as ImportItem
        const name = item.kind === 'file' ? item.file.name : item.name
        const size = item.kind === 'file' ? item.file.size : item.size
        setProgress({ done: i, total, current: name, results })

        const done = (r: ImportResult) => {
          results.push(r)
          setProgress({ done: i + 1, total, current: name, results: [...results] })
        }

        if (!EPUB_EXT.test(name)) {
          done({ name, ok: false, message: '书架只收 `.epub`' })
          continue
        }
        if (size > MAX_BOOK_BYTES) {
          done({
            name,
            ok: false,
            message: `超过单本上限 ${Math.round(MAX_BOOK_BYTES / 1024 / 1024)}MB（这本 ${(size / 1024 / 1024).toFixed(1)}MB）`,
          })
          continue
        }

        let placed: string | null = null
        try {
          const taken = lib.books.map((b) => b.fileName)
          const dest = uniqueFileName(name, taken)

          let bytes: Uint8Array
          if (item.kind === 'path') {
            // 桌面端：交给 Rust 直接把文件复制进书架（不覆盖、不读源文件），
            // 再从书架里读回来做校验 —— 大文件不必从进程里过一遍
            const { importPath } = await import('../../hosts/tauri')
            await importPath(item.path, s.where, dest)
            placed = dest
            bytes = await s.host.read(dest)
          } else {
            bytes = new Uint8Array(await item.file.arrayBuffer())
            await s.host.write(dest, bytes)
            placed = dest
          }

          if (!looksLikeEpub(bytes)) {
            if (placed) await s.host.remove(placed).catch(() => {})
            done({ name, ok: false, message: '这个文件不是标准 EPUB（打不开）' })
            continue
          }
          if ((await encryptionOfBytes(bytes)) === 'drm') {
            if (placed) await s.host.remove(placed).catch(() => {})
            done({ name, ok: false, message: '这本书带 DRM 保护，不支持阅读，未加入书架' })
            continue
          }

          const id = await hashBytes(bytes)
          const dup = lib.books.find((b) => b.id === id)
          if (dup) {
            if (placed) await s.host.remove(placed).catch(() => {})
            setLocateId(dup.id)
            done({ name, ok: true, duplicate: true, bookId: dup.id, message: `已在书架中：${dup.title}` })
            continue
          }

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
          done({ name, ok: true, bookId: id, message: `已加入：${book.title}` })
        } catch (e) {
          if (placed) await s.host.remove(placed).catch(() => {})
          const kind = classifyEpubError(e)
          done({ name, ok: false, message: kind === 'unknown' ? `导入失败：${String(e)}` : epubErrorMessage(kind) })
        }
      }

      await saveNow()
      setProgress(null)
      setReport(results)
      const ok = results.filter((r) => r.ok && !r.duplicate).length
      const dup = results.filter((r) => r.duplicate).length
      const bad = results.filter((r) => !r.ok).length
      if (ok || dup || bad) {
        say(
          bad ? 'warn' : 'ok',
          `导入完成：成功 ${ok} 本${dup ? `，已在书架中 ${dup} 本` : ''}${bad ? `，失败 ${bad} 本` : ''}`,
        )
      }
      return results
    },
    [persist, saveNow, say],
  )

  /** 从系统文件选择器添加（桌面端走绝对路径，浏览器走 File） */
  const addBooks = useCallback(async () => {
    const s = shelfRef.current
    if (!s) return
    if (s.kind === 'tauri') {
      const { pickTauriFiles, statPath } = await import('../../hosts/tauri')
      const paths = await pickTauriFiles('添加 EPUB 到书架', [{ name: 'EPUB 电子书', extensions: ['epub'] }])
      if (paths.length === 0) return
      const items: ImportItem[] = []
      for (const p of paths) {
        try {
          const st = await statPath(p)
          items.push({ kind: 'path', path: p, name: st.name, size: st.size })
        } catch (e) {
          say('error', `读不了这个文件：${String(e)}`)
        }
      }
      await importFiles(items)
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
  }, [importFiles, say])

  /* ── 阅读状态 ── */
  const patchReading = useCallback(
    (id: string, patch: Partial<Book>) => {
      const next = patchBook(libRef.current, id, { ...patch, lastReadAt: patch.lastReadAt ?? Date.now() })
      persist(next)
    },
    [persist],
  )

  const addMark = useCallback(
    (id: string, mark: Bookmark) => {
      const book = libRef.current.books.find((b) => b.id === id)
      if (!book) return
      persist(patchBook(libRef.current, id, { bookmarks: [...book.bookmarks, mark] }))
    },
    [persist],
  )

  const dropMark = useCallback(
    (id: string, markId: string) => {
      const book = libRef.current.books.find((b) => b.id === id)
      if (!book) return
      persist(patchBook(libRef.current, id, { bookmarks: book.bookmarks.filter((m) => m.id !== markId) }))
    },
    [persist],
  )

  /* ── 删除（先删文件，再删条目） ── */
  const removeBook = useCallback(
    async (id: string) => {
      const s = shelfRef.current
      const book = libRef.current.books.find((b) => b.id === id)
      if (!s || !book) return
      try {
        await s.host.remove(book.file)
      } catch (e) {
        say('error', `删不掉这个文件：${String(e)}`)
        return
      }
      persist(removeBookEntry(libRef.current, id))
      if (openId === id) setOpenId(null)
      await saveNow()
      say('ok', `已从书架删除《${book.title}》`)
    },
    [openId, persist, saveNow, say],
  )

  const reveal = useCallback(
    async (book?: Book) => {
      const s = shelfRef.current
      if (!s?.host.reveal) {
        say('warn', '当前运行环境拿不到真实文件路径，没法在文件管理器里定位')
        return
      }
      try {
        await s.host.reveal(book?.file ?? '')
      } catch (e) {
        say('error', `打不开文件管理器：${String(e)}`)
      }
    },
    [say],
  )

  const copyPath = useCallback(
    async (book: Book) => {
      try {
        await navigator.clipboard.writeText(book.file)
        say('ok', `已复制：${book.file}`)
      } catch {
        say('warn', '剪贴板不可用')
      }
    },
    [say],
  )

  const openBook = useCallback((id: string) => setOpenId(id), [])
  const closeBook = useCallback(() => setOpenId(null), [])

  /** 清掉一条错误提示（界面上的"知道了"） */
  const clearError = useCallback(() => setError(null), [])

  return {
    config,
    shelf,
    library,
    status,
    error,
    notice,
    progress,
    report,
    clearReport: () => setReport(null),
    locateId,
    clearLocate: () => setLocateId(null),
    openId,
    books: library.books,
    openBook,
    closeBook,
    addBooks,
    importFiles,
    removeBook,
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
    setOpenId,
    reload: boot,
  }
}

export type ShelfApi = ReturnType<typeof useShelf>
