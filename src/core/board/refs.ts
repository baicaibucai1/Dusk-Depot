/*
 * 白板引用：`.note` 的 `boardref` 块 ↔ 仓库里那些 `.board` 文件。
 *
 * 两条规矩：
 *
 *   ① **按 `boardId` 认，不按路径认**。路径只是"定位提示"：白板被改名/搬家后，
 *      引用块仍然指向同一块白板。只有查不到 id 时才退回路径（比如白板是别的工具
 *      建的，没走过这个程序的索引）。
 *   ② **查不到就是查不到**：不猜、不显示过期内容，交给界面说"白板找不到"。
 *
 * 这一层是纯逻辑，读文件通过回调进来 —— node 里能直接测。
 */
import type { Path } from '../model/path'
import { parseBoardDoc } from '../note/board'
import type { BoardRefView } from './file'

export type BoardRef = {
  /** 被引用白板的稳定身份 */
  boardId: string
  /** 仓库相对路径，作为定位提示 */
  path: string
  /** 显示方式 */
  view: BoardRefView
}

/** 仓库里一块白板的索引条目（只放解析需要的最少信息） */
export type BoardEntry = { path: Path; boardId: string; title: string }

export type BoardRefHit = {
  noteDir: Path
  noteTitle: string
  blockId: string
  ref: BoardRef
}

/**
 * 按 id 找，找不到再按路径找。
 * 返回的 `via` 让界面能说清楚"是靠 id 认出来的，还是路径碰巧还在"。
 */
export function resolveBoard(
  ref: BoardRef,
  boards: BoardEntry[],
): { entry: BoardEntry; via: 'id' | 'path' } | null {
  const byId = boards.find((b) => b.boardId === ref.boardId)
  if (byId) return { entry: byId, via: 'id' }
  const byPath = ref.path ? boards.find((b) => b.path === ref.path) : undefined
  if (byPath) return { entry: byPath, via: 'path' }
  return null
}

/** 哪些笔记引用了这块白板（删/改名前给用户看的影响面） */
export function refsOfBoard(hits: BoardRefHit[], boardId: string): BoardRefHit[] {
  return hits.filter((h) => h.ref.boardId === boardId)
}

/**
 * 扫一遍所有 `.note` 找引用。
 *
 * `load` 由调用方给：界面那边是"从宿主读这个目录下的文本文件"，
 * 单测里就是一个返回固定文件表的函数。读不出来的目录**记一笔失败**，
 * 不当作"没有引用" —— 那样会让删除确认少报影响面。
 */
export async function scanBoardRefs(
  noteDirs: Path[],
  load: (dir: Path) => Promise<Record<Path, string>>,
): Promise<{ hits: BoardRefHit[]; failed: { dir: Path; message: string }[] }> {
  const hits: BoardRefHit[] = []
  const failed: { dir: Path; message: string }[] = []

  for (const dir of noteDirs) {
    try {
      const files = await load(dir)
      const parsed = parseBoardDoc(dir, files)
      if (!parsed) continue
      const title = parsed.doc.meta.title
      for (const b of Object.values(parsed.doc.blocks)) {
        if (b.type !== 'boardref') continue
        const boardId = typeof b.boardId === 'string' ? b.boardId : ''
        if (!boardId) continue
        hits.push({
          noteDir: dir,
          noteTitle: title,
          blockId: b.id,
          ref: {
            boardId,
            path: typeof b.path === 'string' ? b.path : '',
            view: b.view === 'preview' ? 'preview' : 'compact',
          },
        })
      }
    } catch (e) {
      failed.push({ dir, message: e instanceof Error ? e.message : String(e) })
    }
  }

  return { hits, failed }
}
