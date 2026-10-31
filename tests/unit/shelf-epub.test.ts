import { describe, expect, it } from 'vitest'
import {
  classifyEncryptionXml,
  encryptionOfBytes,
  looksLikeEpub,
  readZipText,
  zipEntryInfo,
} from '../../src/core/shelf/epub'

const enc = new TextEncoder()

type Entry = { name: string; text?: string; data?: Uint8Array; method?: 0 | 8; fakeSize?: number }

/**
 * 造一个**结构完整**的最小 ZIP：本地头 + 中央目录 + EOCD。
 * 读取逻辑现在只认中央目录，所以测试数据必须真的像 ZIP，不能拿几个本地头拼一拼。
 */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function zip(entries: Entry[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const name = enc.encode(e.name)
    const raw = e.data ?? enc.encode(e.text ?? '')
    const method = e.method ?? 0
    const body = method === 8 ? await deflateRaw(raw) : raw
    const uncomp = e.fakeSize ?? raw.length

    const local = new Uint8Array(30 + name.length + body.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, method, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, uncomp, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(body, 30 + name.length)
    locals.push(local)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, method, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, uncomp, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    centrals.push(central)

    offset += local.length
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(offset + cdSize + 22)
  let p = 0
  for (const l of locals) {
    out.set(l, p)
    p += l.length
  }
  const cdOffset = p
  for (const c of centrals) {
    out.set(c, p)
    p += c.length
  }
  const ev = new DataView(out.buffer)
  ev.setUint32(p, 0x06054b50, true)
  ev.setUint16(p + 8, entries.length, true)
  ev.setUint16(p + 10, entries.length, true)
  ev.setUint32(p + 12, cdSize, true)
  ev.setUint32(p + 16, cdOffset, true)
  return out
}

const mimetype = { name: 'mimetype', text: 'application/epub+zip' }

describe('EPUB 嗅探', () => {
  it('ZIP 魔数 + mimetype 才算 EPUB', async () => {
    expect(looksLikeEpub(await zip([mimetype]))).toBe(true)
    expect(looksLikeEpub(enc.encode('just text'))).toBe(false)
  })

  it('普通 ZIP（没有 epub mimetype）不算', async () => {
    expect(looksLikeEpub(await zip([{ name: 'readme.txt', text: 'hello' }]))).toBe(false)
  })
})

describe('从 ZIP 中央目录里读文本', () => {
  it('读得到 store 条目', async () => {
    const bytes = await zip([mimetype, { name: 'META-INF/encryption.xml', text: '<encryption/>' }])
    expect(await readZipText(bytes, 'META-INF/encryption.xml')).toBe('<encryption/>')
  })

  it('读得到 deflate 条目', async () => {
    const xml = `<encryption>${'字体'.repeat(400)}</encryption>`
    const bytes = await zip([mimetype, { name: 'META-INF/encryption.xml', text: xml, method: 8 }])
    expect(await readZipText(bytes, 'META-INF/encryption.xml')).toBe(xml)
  })

  it('没有这个条目返回 null', async () => {
    expect(await readZipText(await zip([mimetype]), 'META-INF/encryption.xml')).toBeNull()
  })

  it('不是 ZIP 也不炸', async () => {
    expect(await readZipText(enc.encode('nope'), 'a')).toBeNull()
  })

  it('声明的解压大小超限：不解压，直接拒绝（挡住 zip bomb）', async () => {
    const bytes = await zip([
      mimetype,
      { name: 'META-INF/encryption.xml', text: '<encryption/>', method: 8, fakeSize: 900 * 1024 },
    ])
    expect(await readZipText(bytes, 'META-INF/encryption.xml')).toBeNull()
  })

  it('中央目录偏移被改坏 → null，不抛异常', async () => {
    const bytes = await zip([mimetype, { name: 'META-INF/encryption.xml', text: '<encryption/>' }])
    const dv = new DataView(bytes.buffer)
    const eocd = bytes.length - 22
    dv.setUint32(eocd + 16, bytes.length + 10, true)
    expect(await readZipText(bytes, 'META-INF/encryption.xml')).toBeNull()
  })

  it('条目名按 UTF-8 比，中文名也能取到', async () => {
    const bytes = await zip([{ name: 'OEBPS/第一章.xhtml', text: 'x' }])
    expect(zipEntryInfo(bytes, 'OEBPS/第一章.xhtml')?.uncompSize).toBe(1)
  })
})

describe('DRM 判定：字体混淆不能误伤', () => {
  const withEnc = (xml: string) => zip([mimetype, { name: 'META-INF/encryption.xml', text: xml, method: 8 }])

  it('没有 encryption.xml → none', async () => {
    expect(await encryptionOfBytes(await zip([mimetype]))).toBe('none')
  })

  it('只有字体混淆（idpf embedding）→ fonts，不是 DRM', async () => {
    const xml =
      '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>' +
      '<CipherData><CipherReference URI="OEBPS/fonts/a.otf"/></CipherData></EncryptedData></encryption>'
    expect(await encryptionOfBytes(await withEnc(xml))).toBe('fonts')
  })

  it('Adobe 字体混淆（pdf/enc#RC）→ fonts', async () => {
    const xml =
      '<encryption><EncryptedData><EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/>' +
      '<CipherData><CipherReference URI="OEBPS/fonts/a.otf"/></CipherData></EncryptedData></encryption>'
    expect(await encryptionOfBytes(await withEnc(xml))).toBe('fonts')
  })

  it('AES 加密 → drm', async () => {
    const xml =
      '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>' +
      '<CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData></EncryptedData></encryption>'
    expect(await encryptionOfBytes(await withEnc(xml))).toBe('drm')
  })

  it('Adobe ADEPT → drm', async () => {
    const xml =
      '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>' +
      '<CipherData><CipherReference URI="META-INF/rights.xml"/></CipherData></EncryptedData></encryption>'
    expect(await encryptionOfBytes(await withEnc(xml))).toBe('drm')
  })

  it('字体 + 正文混在一起 → drm（不能只看第一条）', () => {
    const xml =
      '<encryption>' +
      '<EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>' +
      '<CipherData><CipherReference URI="OEBPS/fonts/a.otf"/></CipherData></EncryptedData>' +
      '<EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>' +
      '<CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData></EncryptedData>' +
      '</encryption>'
    expect(classifyEncryptionXml(xml)).toBe('drm')
  })

  it('未知算法 + 非字体资源 → drm', () => {
    const xml =
      '<encryption><EncryptedData><EncryptionMethod Algorithm="http://example.com/custom"/>' +
      '<CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData></EncryptedData></encryption>'
    expect(classifyEncryptionXml(xml)).toBe('drm')
  })

  it('只有 rights.xml（没有 encryption.xml）→ drm', async () => {
    const bytes = await zip([
      mimetype,
      { name: 'META-INF/rights.xml', text: '<rights><adept/></rights>', method: 8 },
    ])
    expect(await encryptionOfBytes(bytes)).toBe('drm')
  })
})
