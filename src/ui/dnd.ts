/*
 * 拖放落点：DOM 上只认一个属性 `data-drop-zone`。
 *
 * 为什么不在每个组件里各写一套 onDragOver：
 *   ① 桌面端的原生拖放**不经过 DOM 事件**（Tauri 只给坐标），只能靠命中测试；
 *   ② 高亮要"只有真正接收这种格式的区域才亮"，统一由 zone 决定最不容易漏。
 *
 * 于是浏览器端和桌面端共用这套 zone 名字：
 *   shelf-list / shelf-welcome / reader / tree / tree-blank / editor / board
 *
 * `path` 是"这个落点具体属于哪个文件"（目前只有 board 用）——
 * 同一个界面上可能开着好几块白板，光有 zone 分不出该往哪块里放。
 */
export type DropTarget = {
  zone: string
  dir: string | null
  /** 落点属于哪个文件（只有 board 用）；其余落点是 null */
  path?: string | null
  el: HTMLElement | null
}

export function targetAt(x: number, y: number): DropTarget | null {
  if (typeof document === 'undefined') return null
  const el = document.elementFromPoint(x, y)
  const zoneEl = el?.closest('[data-drop-zone]') as HTMLElement | null
  if (!zoneEl) return null
  return {
    zone: zoneEl.dataset.dropZone ?? '',
    dir: zoneEl.dataset.dropDir ?? null,
    path: zoneEl.dataset.dropPath ?? null,
    el: zoneEl,
  }
}

/**
 * 高亮走 `<html data-dd-drop="zone">` + CSS。
 * 这样拖动过程中不动 React 状态（每秒几十次 mousemove 不该触发重渲染）。
 */
let lastEl: HTMLElement | null = null

export function setHighlight(t: DropTarget | null): void {
  lastEl?.removeAttribute('data-dd-hover')
  lastEl = t?.el ?? null
  lastEl?.setAttribute('data-dd-hover', '')

  const root = document.documentElement
  if (!t || !t.zone) {
    delete root.dataset.ddDrop
    delete root.dataset.ddDropDir
    return
  }
  root.dataset.ddDrop = t.zone
  if (t.dir) root.dataset.ddDropDir = t.dir
  else delete root.dataset.ddDropDir
}

/** 浏览器 DataTransfer 里有没有文件（区分内部拖动） */
export function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types).includes('Files')
}
