/*
 * 图床里的图片 → 浏览器能显示的 URL。
 *
 * 仓库里的图片是**字节**，`<img src="附件/x.png">` 这种相对路径在浏览器里根本加载不出来
 * （尤其是在 File System Access / Tauri 下）。所以读到字节后用 Blob URL 显示。
 *
 * 缓存放在模块里：阅读模式的组件和编写模式的 widget 都要用它，
 * 走 React context 传不进 CodeMirror 的 widget，只能走这个共享表。
 */

const cache = new Map<string, string>()

/** 已经是可直接用的地址（外链 / data / blob）就原样返回 */
export function isDirectSrc(src: string): boolean {
  return /^(https?:|data:|blob:|file:)/i.test(src)
}

export function normalizeSrc(src: string): string {
  return src.trim().replace(/^\.\//, '')
}

export function putImage(path: string, url: string): void {
  const old = cache.get(path)
  if (old && old !== url) URL.revokeObjectURL(old)
  cache.set(path, url)
}

export function hasImage(path: string): boolean {
  return cache.has(path)
}

/** 拿到可显示的地址；还没加载好就返回 null（渲染成"图片加载中"占位） */
export function resolveImage(src: string): string | null {
  if (isDirectSrc(src)) return src
  return cache.get(normalizeSrc(src)) ?? null
}

/** 换仓库时清掉，别把上一个仓库的 Blob URL 留着 */
export function clearImages(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url)
  cache.clear()
}
