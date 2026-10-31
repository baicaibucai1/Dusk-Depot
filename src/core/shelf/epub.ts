/*
 * EPUB 的"轻解析"层。
 *
 * 只做两件事：
 *   ① 进书架**之前**先判一眼：是不是 EPUB、有没有加密/DRM、文件大不大；
 *   ② 进书架时读一次元数据 + 封面缩略图，写进 `library.json`。
 *
 * 真正的排版/翻页在阅读器里（`EpubReader.tsx`），这里不碰渲染。
 * 首屏列表只读清单，**不会**逐本解包 —— 这条是性能底线。
 */
import type { Book as EpubBook } from 'epubjs'

/** EPUB 就是 ZIP：前四个字节必须是 `PK\x03\x04` */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/**
 * 是不是 EPUB。
 *
 * 规范要求第一个条目是**不压缩**的 `mimetype`，内容为 `application/epub+zip`，
 * 所以在前 200 字节里能直接看到这串字。看不到就大概率不是 EPUB
 * （也有一小撮工具不守规矩，交给 epub.js 再判一次）。
 */
export function looksLikeEpub(bytes: Uint8Array): boolean {
  if (!looksLikeZip(bytes)) return false
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 200))
  return head.includes('application/epub+zip')
}

/**
 * 从 ZIP 里读一个小文本文件（只支持 store / deflate）。
 *
 * 为什么自己读：判断"这本书是不是 DRM"必须看 `META-INF/encryption.xml` 的内容，
 * 而它是压缩的 —— 在字节流里直接 grep 只能看到文件名。epub.js 的 archive 接口
 * 对不存在的条目返回 undefined，也不方便区分"字体混淆"和"真加密"。
 *
 * 只扫本地文件头（PK\\x03\\x04），够用且不依赖任何库。
 */
export async function readZipText(bytes: Uint8Array, name: string): Promise<string | null> {
  const want = new TextEncoder().encode(name)
  const at = (i: number) => bytes[i] ?? 0
  const u16 = (i: number) => at(i) | (at(i + 1) << 8)
  const u32 = (i: number) => (at(i) | (at(i + 1) << 8) | (at(i + 2) << 16) | (at(i + 3) << 24)) >>> 0

  for (let i = 0; i + 30 < bytes.length; i++) {
    if (at(i) !== 0x50 || at(i + 1) !== 0x4b || at(i + 2) !== 0x03 || at(i + 3) !== 0x04) continue
    const method = u16(i + 8)
    const compSize = u32(i + 18)
    const nameLen = u16(i + 26)
    const extraLen = u16(i + 28)
    if (nameLen !== want.length) continue
    let same = true
    for (let k = 0; k < nameLen; k++) {
      if (bytes[i + 30 + k] !== want[k]) {
        same = false
        break
      }
    }
    if (!same) continue
    if (compSize === 0) return null
    const start = i + 30 + nameLen + extraLen
    const data = bytes.subarray(start, start + compSize)
    try {
      if (method === 0) return new TextDecoder('utf-8').decode(data)
      if (method === 8 && typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('deflate-raw')
        const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds)
        return await new Response(stream).text()
      }
    } catch {
      return null
    }
    return null
  }
  return null
}

export type EncryptionKind = 'none' | 'fonts' | 'drm'

/**
 * 这本书到底加没加密。
 *
 *   · 只有 `embedding` / `pdf/enc#RC` → **字体混淆**，正常书，照读；
 *   · 出现 `xmlenc#aes` / `adept` / `rights.xml` → **DRM**，不支持，也不绕。
 *
 * 一刀切会把带字体混淆的老书误判成 DRM，那种书其实完全能读。
 */
export async function encryptionOfBytes(bytes: Uint8Array): Promise<EncryptionKind> {
  const xml = await readZipText(bytes, 'META-INF/encryption.xml')
  if (!xml) return 'none'
  if (/xmlenc#aes|aes(128|256)-cbc|adept|rights\.xml|encrypted-key/i.test(xml)) return 'drm'
  if (/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/i.test(xml)) return 'fonts'
  return 'none'
}

export type EpubMeta = {
  title: string
  author: string
  publisher?: string
  language?: string
  /** 封面缩略图（data URL，最长边 220px） */
  cover?: string
  chapters: number
}

export type TocItem = { label: string; href: string; depth: number }

/** epub.js 的 book 对象只在这里出现，外面拿到的都是纯数据 */
export type OpenedEpub = {
  book: EpubBook
  meta: EpubMeta
  toc: TocItem[]
  /** 加密情况：font 混淆是正常的，drm 才不能读 */
  encryption: EncryptionKind
  /** 释放 book 与它内部的 blob */
  destroy: () => void
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function flattenToc(items: { label?: string; href?: string; subitems?: unknown[] }[], depth = 0): TocItem[] {
  const out: TocItem[] = []
  for (const it of items) {
    const label = String(it.label ?? '').trim()
    const href = String(it.href ?? '')
    if (label && href) out.push({ label, href, depth })
    const sub = Array.isArray(it.subitems) ? (it.subitems as typeof items) : []
    if (sub.length) out.push(...flattenToc(sub, depth + 1))
  }
  return out
}

/**
 * 打开一本书（导入时读元数据、阅读时给 rendition 用）。
 * 调用方负责在不用时调用 `destroy()`。
 */
export async function openEpub(bytes: ArrayBuffer): Promise<OpenedEpub> {
  // 动态 import：epub.js 只在你真的碰电子书时才下载（首屏不为它付钱）
  const { default: ePub } = await import('epubjs')
  const book = ePub(bytes)
  await withTimeout(book.ready as unknown as Promise<unknown>, 25_000, 'EPUB 解析超时（可能已损坏）')
  const encryption = await encryptionOfBytes(new Uint8Array(bytes))

  // ⚠️ `book.loaded.*` 是 Promise，不是值 —— 直接取属性只会得到 undefined
  const md = (await book.loaded.metadata) as unknown as Record<string, unknown>
  const nav = await book.loaded.navigation
  const toc = flattenToc((nav?.toc ?? []) as never)

  let cover: string | undefined
  try {
    const url = await book.coverUrl()
    if (url) cover = await thumbOf(url)
  } catch {
    /* 没封面不是错 */
  }

  const meta: EpubMeta = {
    title: String(md.title ?? '').trim(),
    author: String(md.creator ?? '').trim(),
    ...(md.publisher ? { publisher: String(md.publisher) } : {}),
    ...(md.language ? { language: String(md.language) } : {}),
    ...(cover ? { cover } : {}),
    chapters: (book.spine as unknown as { length?: number })?.length ?? 0,
  }

  return {
    book,
    meta,
    toc,
    encryption,
    destroy: () => {
      try {
        book.destroy()
      } catch {
        /* 已经销毁就算了 */
      }
    },
  }
}

/**
 * 把封面缩成一张小图（data URL）。
 *
 * 为什么不存原图：一本 3MB 的封面塞进 `library.json`，书架有 50 本时
 * 清单就变成 150MB —— 清单是每次打开都要读的，不能这么干。
 */
async function thumbOf(url: string): Promise<string | undefined> {
  try {
    return await new Promise<string | undefined>((resolve) => {
      const img = new Image()
      img.onload = () => {
        try {
          const max = 220
          const scale = Math.min(1, max / Math.max(img.naturalWidth || max, img.naturalHeight || max))
          const w = Math.max(1, Math.round((img.naturalWidth || max) * scale))
          const h = Math.max(1, Math.round((img.naturalHeight || max) * scale))
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')
          if (!ctx) return resolve(undefined)
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, w, h)
          ctx.drawImage(img, 0, 0, w, h)
          resolve(canvas.toDataURL('image/jpeg', 0.82))
        } catch {
          resolve(undefined)
        }
      }
      img.onerror = () => resolve(undefined)
      img.src = url
    })
  } catch {
    return undefined
  }
}

/** 人能看懂的错误分类（阅读器里要给出可操作的提示） */
export type EpubErrorKind = 'drm' | 'corrupt' | 'empty' | 'unknown'

export function classifyEpubError(e: unknown): EpubErrorKind {
  const msg = String((e as { message?: string })?.message ?? e ?? '')
  if (/drm|encrypt|rights/i.test(msg)) return 'drm'
  if (/no spine|empty|no sections|not found/i.test(msg)) return 'empty'
  if (/parse|zip|archive|invalid|corrupt/i.test(msg)) return 'corrupt'
  return 'unknown'
}

export function epubErrorMessage(kind: EpubErrorKind): string {
  switch (kind) {
    case 'drm':
      return '这本书带 DRM 保护，本程序不支持解密，也不打算绕过它。'
    case 'corrupt':
      return '这个 EPUB 打不开：文件可能损坏，或者不是标准的 EPUB。'
    case 'empty':
      return '这本书里没有可显示的章节（可能是空书或固定版式异常）。'
    default:
      return '打开这本书时出错了。'
  }
}
