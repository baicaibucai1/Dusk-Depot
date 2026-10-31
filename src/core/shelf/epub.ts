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

/*
 * ── ZIP 读取（只读中央目录，不扫全文件） ──
 *
 * 为什么不用 epub.js 的 archive：判断 DRM 必须看 `META-INF/encryption.xml`
 * 的**内容**，而它是压缩的；在整份字节里 grep 只能看到文件名，还会给 200MB 的
 * 书多造一份大字符串。这里只做三件事：找 EOCD → 走中央目录 → 解一个小条目。
 *
 * 所有长度都来自文件本身，必须当成不可信输入：条目数、目录大小、解压后大小
 * 都有上限，任何越界一律返回 null（当作"没有这个条目"），绝不抛异常拖垮导入。
 */

/** 中央目录最多认这么多条 —— 正常 EPUB 是几百到几千 */
const MAX_ZIP_ENTRIES = 100_000
/** 中央目录本身的上限，挡住"目录比文件还大"的构造输入 */
const MAX_CD_BYTES = 8 * 1024 * 1024
/** encryption.xml 是几百字节的小文件；给到 256KB 已经很宽松 */
const MAX_ENTRY_BYTES = 256 * 1024

export type ZipEntryInfo = {
  name: string
  method: number
  compSize: number
  uncompSize: number
  localOffset: number
}

function at(bytes: Uint8Array, i: number): number {
  return bytes[i] ?? -1
}

function u16(bytes: Uint8Array, i: number): number {
  return (at(bytes, i) & 0xff) | ((at(bytes, i + 1) & 0xff) << 8)
}

function u32(bytes: Uint8Array, i: number): number {
  return (
    ((at(bytes, i) & 0xff) |
      ((at(bytes, i + 1) & 0xff) << 8) |
      ((at(bytes, i + 2) & 0xff) << 16) |
      ((at(bytes, i + 3) & 0xff) << 24)) >>>
    0
  )
}

/** 从尾部找 EOCD（`PK\x05\x06`）；ZIP 注释最长 65535，所以只扫最后 66KB */
function findEocd(bytes: Uint8Array): { count: number; cdOffset: number; cdSize: number } | null {
  const min = Math.max(0, bytes.length - 66_000)
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(bytes, i) !== 0x06054b50) continue
    const commentLen = u16(bytes, i + 20)
    if (i + 22 + commentLen > bytes.length) continue
    const count = u16(bytes, i + 10)
    const cdSize = u32(bytes, i + 12)
    const cdOffset = u32(bytes, i + 16)
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null // ZIP64：不认
    if (count > MAX_ZIP_ENTRIES || cdSize > MAX_CD_BYTES) return null
    if (cdOffset + cdSize > bytes.length) return null
    return { count, cdOffset, cdSize }
  }
  return null
}

/** 在中央目录里找一条。找不到 / 结构不对都返回 null */
export function zipEntryInfo(bytes: Uint8Array, name: string): ZipEntryInfo | null {
  const eocd = findEocd(bytes)
  if (!eocd) return null
  const want = new TextEncoder().encode(name)

  let p = eocd.cdOffset
  const end = eocd.cdOffset + eocd.cdSize
  for (let i = 0; i < eocd.count; i++) {
    if (p + 46 > end || p + 46 > bytes.length) return null
    if (u32(bytes, p) !== 0x02014b50) return null

    const method = u16(bytes, p + 10)
    const compSize = u32(bytes, p + 20)
    const uncompSize = u32(bytes, p + 24)
    const nameLen = u16(bytes, p + 28)
    const extraLen = u16(bytes, p + 30)
    const commentLen = u16(bytes, p + 32)
    const localOffset = u32(bytes, p + 42)
    if (p + 46 + nameLen > end) return null

    let hit = nameLen === want.length
    if (hit) {
      for (let k = 0; k < nameLen; k++) {
        if (at(bytes, p + 46 + k) !== want[k]) {
          hit = false
          break
        }
      }
    }
    if (hit) {
      return { name, method, compSize, uncompSize, localOffset }
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

/** 解压 deflate-raw，**带输出上限**：超过就取消，绝不把 zip bomb 全解进内存 */
async function inflateCapped(data: Uint8Array, cap: number): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > cap) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/**
 * 从 ZIP 里读一个小文本条目（store / deflate）。
 * 找不到、超限、结构坏、解压失败都返回 null。
 */
export async function readZipText(bytes: Uint8Array, name: string): Promise<string | null> {
  const info = zipEntryInfo(bytes, name)
  if (!info) return null
  if (info.uncompSize > MAX_ENTRY_BYTES || info.compSize > MAX_ENTRY_BYTES) return null

  // 本地文件头：签名、名字长度、扩展长度都要复核 —— 中央目录和本地头可能不一致
  const lo = info.localOffset
  if (lo + 30 > bytes.length || u32(bytes, lo) !== 0x04034b50) return null
  const localNameLen = u16(bytes, lo + 26)
  const localExtraLen = u16(bytes, lo + 28)
  const start = lo + 30 + localNameLen + localExtraLen
  const stop = start + info.compSize
  if (start > bytes.length || stop > bytes.length) return null
  const data = bytes.subarray(start, stop)

  try {
    if (info.method === 0) {
      if (data.length > MAX_ENTRY_BYTES) return null
      return new TextDecoder('utf-8').decode(data)
    }
    if (info.method === 8) {
      const raw = await inflateCapped(data, MAX_ENTRY_BYTES)
      return raw ? new TextDecoder('utf-8').decode(raw) : null
    }
  } catch {
    return null
  }
  return null
}

export type EncryptionKind = 'none' | 'fonts' | 'drm'

/**
 * `META-INF/encryption.xml` 到底说了什么。
 *
 * EPUB 里这份清单有两种用途，**必须分开**：
 *   · 字体混淆（idpf.org/2008/embedding、adobe pdf/enc#RC，或 CipherReference
 *     指向 .otf/.ttf/.woff）—— 合法，书能正常读；
 *   · DRM（xmlenc#aes*、adept、rights.xml）—— 不支持，也不绕。
 *
 * 一刀切成"有 encryption.xml 就是 DRM"会误伤大量带字体混淆的老书。
 */
export function classifyEncryptionXml(xml: string): EncryptionKind {
  const blocks = xml.split(/<(?:\w+:)?EncryptedData\b/i).slice(1)
  if (blocks.length === 0) {
    // 没有 EncryptedData 结构，退化成看算法串；但仍然优先认字体混淆
    if (/xmlenc#aes|aes(128|256)-cbc|adept|rights\.xml|encrypted-key/i.test(xml)) return 'drm'
    if (/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/i.test(xml)) return 'fonts'
    return 'none'
  }

  let fonts = false
  for (const b of blocks) {
    const alg = /<(?:\w+:)?EncryptionMethod\b[^>]*Algorithm\s*=\s*"([^"]*)"/i.exec(b)?.[1] ?? ''
    const uri = /<(?:\w+:)?CipherReference\b[^>]*URI\s*=\s*"([^"]*)"/i.exec(b)?.[1] ?? ''
    const fontAlg = /idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/i.test(alg)
    const drmAlg = /xmlenc#aes|aes(128|256)?-cbc|adept|rights\.xml|encrypted-key/i.test(alg)
    const fontUri = /\.(otf|ttf|ttc|woff2?|eot)(?:[?#]|$)/i.test(uri)

    if (drmAlg) return 'drm'
    if (fontAlg || fontUri) fonts = true
    else return 'drm' // 有加密资源，但既不是字体也不是已知算法 —— 当作 DRM
  }
  return fonts ? 'fonts' : 'none'
}

/**
 * 这本书到底加没加密。
 *
 * 只读中央目录 + `encryption.xml` 一个小条目，**不会**把整本书解码成字符串。
 */
export async function encryptionOfBytes(bytes: Uint8Array): Promise<EncryptionKind> {
  const xml = await readZipText(bytes, 'META-INF/encryption.xml')
  if (xml) {
    const kind = classifyEncryptionXml(xml)
    if (kind !== 'none') return kind
  }
  // Adobe DRM 有时只有 rights.xml（没有 encryption.xml）
  const rights = await readZipText(bytes, 'META-INF/rights.xml')
  if (rights && /rights|adept|drm/i.test(rights)) return 'drm'
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
