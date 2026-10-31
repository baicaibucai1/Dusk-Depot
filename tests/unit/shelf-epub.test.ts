import { describe, expect, it } from 'vitest'
import { encryptionOfBytes, looksLikeEpub, readZipText } from '../../src/core/shelf/epub'

const enc = new TextEncoder()

/** 只写"本地文件头 + 数据"的最小 ZIP（store，不压缩）—— 够测读取逻辑 */
function zipStore(name: string, text: string): Uint8Array {
  const nameBytes = enc.encode(name)
  const data = enc.encode(text)
  const buf = new Uint8Array(30 + nameBytes.length + data.length)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, 0x04034b50, true) // PK\x03\x04
  dv.setUint16(8, 0, true) // method = store
  dv.setUint32(18, data.length, true) // 压缩后大小
  dv.setUint32(22, data.length, true) // 原始大小
  dv.setUint16(26, nameBytes.length, true)
  buf.set(nameBytes, 30)
  buf.set(data, 30 + nameBytes.length)
  return buf
}

describe('EPUB 嗅探', () => {
  it('ZIP 魔数 + mimetype 才算 EPUB', () => {
    const ok = zipStore('mimetype', 'application/epub+zip')
    expect(looksLikeEpub(ok)).toBe(true)
    expect(looksLikeEpub(enc.encode('just text'))).toBe(false)
  })

  it('普通 ZIP（没有 epub mimetype）不算', () => {
    expect(looksLikeEpub(zipStore('readme.txt', 'hello'))).toBe(false)
  })
})

describe('从 ZIP 里读文本', () => {
  it('读得到指定条目', async () => {
    const zip = zipStore('META-INF/encryption.xml', '<encryption/>')
    expect(await readZipText(zip, 'META-INF/encryption.xml')).toBe('<encryption/>')
  })

  it('没有这个条目返回 null', async () => {
    const zip = zipStore('mimetype', 'application/epub+zip')
    expect(await readZipText(zip, 'META-INF/encryption.xml')).toBeNull()
  })

  it('不是 ZIP 也不炸', async () => {
    expect(await readZipText(enc.encode('nope'), 'a')).toBeNull()
  })
})

describe('DRM 判定：字体混淆不能误伤', () => {
  const withEnc = (xml: string) => {
    // 两个条目拼在一起（读的时候扫本地头，不需要中央目录）
    const a = zipStore('mimetype', 'application/epub+zip')
    const b = zipStore('META-INF/encryption.xml', xml)
    const out = new Uint8Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
  }

  it('没有 encryption.xml → none', async () => {
    expect(await encryptionOfBytes(zipStore('mimetype', 'application/epub+zip'))).toBe('none')
  })

  it('只有字体混淆（idpf embedding）→ fonts，不是 DRM', async () => {
    const xml =
      '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>' +
      '<CipherData><CipherReference URI="OEBPS/fonts/a.otf"/></CipherData></EncryptedData></encryption>'
    expect(await encryptionOfBytes(withEnc(xml))).toBe('fonts')
  })

  it('Adobe 字体混淆（pdf/enc#RC）→ fonts', async () => {
    const xml =
      '<encryption><EncryptedData><EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/>' +
      '<CipherData><CipherReference URI="OEBPS/fonts/a.otf"/></CipherData></EncryptedData></encryption>'
    expect(await encryptionOfBytes(withEnc(xml))).toBe('fonts')
  })

  it('AES 加密 → drm', async () => {
    const xml =
      '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>' +
      '<CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData></EncryptedData></encryption>'
    expect(await encryptionOfBytes(withEnc(xml))).toBe('drm')
  })

  it('Adobe ADEPT → drm', async () => {
    const xml =
      '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>' +
      '<CipherData><CipherReference URI="META-INF/rights.xml"/></CipherData></EncryptedData></encryption>'
    expect(await encryptionOfBytes(withEnc(xml))).toBe('drm')
  })
})
