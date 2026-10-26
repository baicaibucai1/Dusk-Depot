/*
 * 文本与字节的分界。
 *
 * `Host.read` 一律返回字节（见 ports/host.ts 第②条），文本解码只在这里发生一次。
 * 顺手把"文本纪律"也钉在这儿：无 BOM、统一 LF —— 否则每次保存字节都变，
 * 将来的增量同步会永远判成"改过了"。
 */

const dec = new TextDecoder('utf-8')
const enc = new TextEncoder()

export function decodeBytes(bytes: Uint8Array): string {
  const text = dec.decode(bytes)
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

export function encodeText(text: string): Uint8Array {
  return enc.encode(text)
}
