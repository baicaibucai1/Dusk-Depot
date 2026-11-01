/*
 * 仓库里的图片 → 能在 <img> 里用的 URL。
 *
 * 图片是字节，界面上得换成 Blob URL；同一个路径只解一次（imageStore 缓存），
 * 所以把图放在两个块里也只读一遍。读不出来就是 `missing` —— 界面据此显示
 * "找不到这个文件"，而不是留一个破图。
 */
import { useEffect, useState } from 'react'
import type { Host } from '../core/ports/host'
import { putImage, resolveImage } from './markdown/imageStore'

export type AssetState = 'loading' | 'ok' | 'missing'

export function useAssetUrl(
  host: Host,
  src: string | undefined,
): { url: string | null; state: AssetState } {
  const [url, setUrl] = useState<string | null>(() => (src ? resolveImage(src) : null))
  const [state, setState] = useState<AssetState>(() => {
    if (!src) return 'missing'
    return resolveImage(src) ? 'ok' : 'loading'
  })

  useEffect(() => {
    let alive = true
    if (!src) {
      setUrl(null)
      setState('missing')
      return
    }
    const cached = resolveImage(src)
    if (cached) {
      setUrl(cached)
      setState('ok')
      return
    }
    setState('loading')
    void (async () => {
      try {
        const bytes = await host.read(src)
        const next = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]))
        putImage(src, next)
        if (alive) {
          setUrl(next)
          setState('ok')
        }
      } catch {
        if (alive) setState('missing')
      }
    })()
    return () => {
      alive = false
    }
  }, [host, src])

  return { url, state }
}

/** 仓库里这个文件还在不在。宿主不给 exists 时返回 `null`（不知道） */
export function useAssetExists(host: Host, src: string | undefined): boolean | null {
  const [exists, setExists] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    if (!src) {
      setExists(false)
      return
    }
    if (!host.exists) {
      setExists(null)
      return
    }
    void host.exists(src).then(
      (ok) => {
        if (alive) setExists(ok)
      },
      () => {
        if (alive) setExists(null)
      },
    )
    return () => {
      alive = false
    }
  }, [host, src])

  return exists
}
