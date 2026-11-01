import { describe, expect, it } from 'vitest'
import {
  BOARD_FILE_VERSION,
  addLink,
  blockLabel,
  boardOutline,
  boardPlainText,
  copiedAssets,
  copyAssetPath,
  diffBoardFile,
  duplicateBlock,
  insertBlock,
  isCopiedAsset,
  linksOf,
  moveBlockTo,
  newBlock,
  newBoardFile,
  nextBlockId,
  parseBoardFile,
  removeBlock,
  removeLink,
  serializeBoardFile,
  updateBlock,
  type BoardFileDoc,
} from '../../src/core/board/file'
import { refsOfBoard, resolveBoard, scanBoardRefs } from '../../src/core/board/refs'
import { boardFiles, emptyBoardDoc, insertBoardBlock, newBoardBlock } from '../../src/core/note/board'

function docWithBlocks(): BoardFileDoc {
  let doc = newBoardFile('项目白板', new Date('2026-11-01T08:00:00Z'))
  doc = insertBlock(doc, null, newBlock('heading1', 'n1'))
  doc = updateBlock(doc, 'n1', { content: [{ type: 'text', text: '本周' }] })
  doc = insertBlock(doc, 'n1', newBlock('todo', 'n2'))
  doc = updateBlock(doc, 'n2', { checked: true, content: [{ type: 'text', text: '写白板' }] })
  doc = insertBlock(doc, 'n2', { ...newBlock('image', 'n3'), src: '.dusk/board/bd-1/a.png' })
  doc = addLink(doc, {
    id: 'l1',
    from: 'n1',
    to: 'n2',
    type: 'depends',
    label: '先做这个',
    createdAt: 1,
  })
  return doc
}

describe('.board 文件：读写', () => {
  it('往返一致：块、顺序、连接、来源都还在', () => {
    const doc = docWithBlocks()
    const text = serializeBoardFile(doc)
    const parsed = parseBoardFile(text, '兜底')
    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') return

    expect(parsed.doc.boardId).toBe(doc.boardId)
    expect(parsed.doc.title).toBe('项目白板')
    expect(parsed.doc.layout.order).toEqual(['n1', 'n2', 'n3'])
    expect(parsed.doc.blocks.n2?.checked).toBe(true)
    expect(parsed.doc.blocks.n2?.content).toEqual([{ type: 'text', text: '写白板' }])
    expect(parsed.doc.blocks.n3?.source).toBe('copy')
    expect(parsed.doc.links).toHaveLength(1)
    expect(parsed.doc.links[0]?.type).toBe('depends')
    expect(parsed.doc.links[0]?.label).toBe('先做这个')
    expect(parsed.warnings).toEqual([])
  })

  it('版本标记明确：version 写在文件里', () => {
    const text = serializeBoardFile(newBoardFile('x'))
    const raw = JSON.parse(text) as Record<string, unknown>
    expect(raw.format).toBe('board')
    expect(raw.version).toBe(BOARD_FILE_VERSION)
    expect(typeof raw.boardId).toBe('string')
  })

  it('未知块原样保留，不降级成空正文', () => {
    const text = JSON.stringify({
      format: 'board',
      version: 1,
      boardId: 'bd-x',
      title: 't',
      layout: { mode: 'stack', order: ['n1', 'n2'] },
      blocks: {
        n1: { id: 'n1', type: 'paragraph', content: [{ type: 'text', text: '看得懂' }] },
        n2: { id: 'n2', type: 'chart', spec: { series: [1, 2, 3] }, label: '以后才有' },
      },
      links: [],
    })
    const parsed = parseBoardFile(text)
    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') return
    expect(parsed.doc.blocks.n2?.type).toBe('unknown')

    const out = JSON.parse(serializeBoardFile(parsed.doc)) as {
      blocks: Record<string, Record<string, unknown>>
    }
    expect(out.blocks.n2).toEqual({ id: 'n2', type: 'chart', spec: { series: [1, 2, 3] }, label: '以后才有' })
  })

  it('已知块里的未知字段也留着', () => {
    const text = JSON.stringify({
      format: 'board',
      version: 1,
      boardId: 'bd-x',
      title: 't',
      layout: { mode: 'stack', order: ['n1'] },
      blocks: { n1: { id: 'n1', type: 'paragraph', content: [], color: 'red', pinned: true } },
      links: [],
    })
    const parsed = parseBoardFile(text)
    if (parsed.kind !== 'ok') throw new Error('parse failed')
    const out = JSON.parse(serializeBoardFile(parsed.doc)) as {
      blocks: Record<string, Record<string, unknown>>
    }
    expect(out.blocks.n1?.color).toBe('red')
    expect(out.blocks.n1?.pinned).toBe(true)
  })

  it('顶层未知字段留着', () => {
    const text = JSON.stringify({
      format: 'board',
      version: 1,
      boardId: 'bd-x',
      title: 't',
      theme: { accent: 'green' },
      layout: { mode: 'stack', order: [] },
      blocks: {},
      links: [],
    })
    const parsed = parseBoardFile(text)
    if (parsed.kind !== 'ok') throw new Error('parse failed')
    const out = JSON.parse(serializeBoardFile(parsed.doc)) as Record<string, unknown>
    expect(out.theme).toEqual({ accent: 'green' })
  })

  it('版本超前：不解析、不写回，给出提示', () => {
    const text = JSON.stringify({ format: 'board', version: 9, boardId: 'bd-x', title: 't' })
    const parsed = parseBoardFile(text)
    expect(parsed.kind).toBe('unsupported')
    if (parsed.kind !== 'unsupported') return
    expect(parsed.version).toBe(9)
    expect(parsed.message).toContain('v9')
  })

  it('不是 JSON / 不是白板 / 空文件：都明确报错', () => {
    expect(parseBoardFile('').kind).toBe('bad')
    expect(parseBoardFile('{oops').kind).toBe('bad')
    expect(parseBoardFile('{"a":1}').kind).toBe('bad')
  })

  it('也认数组形式的 blocks（别的工具写的）', () => {
    const text = JSON.stringify({
      format: 'board',
      version: 1,
      boardId: 'bd-x',
      title: 't',
      blocks: [
        { id: 'n1', type: 'paragraph', content: [{ type: 'text', text: '甲' }] },
        { id: 'n2', type: 'quote', content: [{ type: 'text', text: '乙' }] },
      ],
      links: [],
    })
    const parsed = parseBoardFile(text)
    if (parsed.kind !== 'ok') throw new Error('parse failed')
    expect(parsed.doc.layout.order).toEqual(['n1', 'n2'])
    expect(parsed.doc.blocks.n2?.type).toBe('quote')
  })

  it('顺序表里漏掉的块补到末尾（宁可多显示也不丢）', () => {
    const text = JSON.stringify({
      format: 'board',
      version: 1,
      boardId: 'bd-x',
      title: 't',
      layout: { mode: 'stack', order: ['n2'] },
      blocks: {
        n1: { id: 'n1', type: 'paragraph', content: [] },
        n2: { id: 'n2', type: 'paragraph', content: [] },
      },
      links: [],
    })
    const parsed = parseBoardFile(text)
    if (parsed.kind !== 'ok') throw new Error('parse failed')
    expect(parsed.doc.layout.order.sort()).toEqual(['n1', 'n2'])
  })

  it('自由布局的坐标原样带着（未来扩展）', () => {
    const text = JSON.stringify({
      format: 'board',
      version: 1,
      boardId: 'bd-x',
      title: 't',
      layout: { mode: 'free', order: ['n1'], pos: { n1: { x: 10, y: 20 } } },
      blocks: { n1: { id: 'n1', type: 'paragraph', content: [] } },
      links: [],
    })
    const parsed = parseBoardFile(text)
    if (parsed.kind !== 'ok') throw new Error('parse failed')
    expect(parsed.doc.layout.mode).toBe('free')
    expect(parsed.doc.layout.pos).toEqual({ n1: { x: 10, y: 20 } })
    const out = JSON.parse(serializeBoardFile(parsed.doc)) as {
      layout: { pos: Record<string, { x: number; y: number }> }
    }
    expect(out.layout.pos).toEqual({ n1: { x: 10, y: 20 } })
  })

  it('内容没变就不写盘（diff 返回 null）', () => {
    const doc = docWithBlocks()
    const text = serializeBoardFile(doc)
    expect(diffBoardFile(text, doc)).toBeNull()
    const edited = updateBlock(doc, 'n1', { content: [{ type: 'text', text: '下周' }] })
    expect(diffBoardFile(text, edited)).not.toBeNull()
  })
})

describe('.board 文件：编辑', () => {
  it('改一个块不动别的块和连接', () => {
    const doc = docWithBlocks()
    const next = updateBlock(doc, 'n2', { checked: false })
    expect(next.blocks.n1).toBe(doc.blocks.n1)
    expect(next.links).toEqual(doc.links)
    expect(next.blocks.n2?.checked).toBe(false)
  })

  it('删块顺手收掉挂在它身上的连接', () => {
    const doc = docWithBlocks()
    const next = removeBlock(doc, 'n2')
    expect(next.blocks.n2).toBeUndefined()
    expect(next.layout.order).toEqual(['n1', 'n3'])
    expect(next.links).toEqual([])
  })

  it('拖动排序按插入位置语义', () => {
    const doc = docWithBlocks()
    expect(moveBlockTo(doc, 'n3', 0).layout.order).toEqual(['n3', 'n1', 'n2'])
    expect(moveBlockTo(doc, 'n1', 3).layout.order).toEqual(['n2', 'n3', 'n1'])
  })

  it('复制块：新 id，行内内容独立（不共享引用）', () => {
    const doc = docWithBlocks()
    const dup = duplicateBlock(doc, 'n1')
    expect(dup).not.toBeNull()
    if (!dup) return
    expect(dup.id).toBe(nextBlockId(doc))
    expect(dup.doc.layout.order).toEqual(['n1', dup.id, 'n2', 'n3'])
    expect(dup.doc.blocks[dup.id]?.content).not.toBe(doc.blocks.n1?.content)
  })

  it('连接不能自己连自己，也不能重复', () => {
    const doc = docWithBlocks()
    const self = addLink(doc, { id: 'l9', from: 'n1', to: 'n1', type: 'related', label: '', createdAt: 0 })
    expect(self.links).toHaveLength(1)
    const dup = addLink(doc, { id: 'l10', from: 'n1', to: 'n2', type: 'depends', label: '先做这个', createdAt: 0 })
    expect(dup.links).toHaveLength(1)
    expect(linksOf(doc, 'n2')).toHaveLength(1)
    expect(removeLink(doc, 'l1').links).toHaveLength(0)
  })

  it('复制进白板的附件：路径按 boardId 归拢，能列出来', () => {
    const doc = docWithBlocks()
    const p = copyAssetPath(doc.boardId, '图表 1.png', 1_700_000_000_000)
    expect(p.startsWith(`.dusk/board/${doc.boardId}/`)).toBe(true)
    expect(p.endsWith('-图表 1.png')).toBe(true)
    expect(isCopiedAsset(p)).toBe(true)
    expect(isCopiedAsset('素材/图.png')).toBe(false)

    const withAsset = updateBlock(doc, 'n3', { src: p })
    expect(copiedAssets(withAsset)).toEqual([p])
  })
})

describe('.board 文件：展示', () => {
  it('纯文本与大纲', () => {
    const doc = docWithBlocks()
    expect(boardPlainText(doc)).toContain('本周')
    expect(boardPlainText(doc)).toContain('[x] 写白板')
    expect(boardOutline(doc)).toEqual([{ level: 1, text: '本周' }])
    expect(blockLabel(doc.blocks.n1, 'n1')).toBe('H1 · 本周')
  })
})

describe('白板引用：按 id 认，不按路径认', () => {
  const boards = [
    { path: '白板/项目.board', boardId: 'bd-1', title: '项目' },
    { path: '白板/调研.board', boardId: 'bd-2', title: '调研' },
  ]

  it('改名/搬家后仍然按 id 找得到', () => {
    const hit = resolveBoard({ boardId: 'bd-1', path: '老路径.board', view: 'compact' }, boards)
    expect(hit?.entry.path).toBe('白板/项目.board')
    expect(hit?.via).toBe('id')
  })

  it('id 对不上时退回路径，并说明是靠路径认的', () => {
    const hit = resolveBoard({ boardId: 'bd-旧', path: '白板/调研.board', view: 'compact' }, boards)
    expect(hit?.entry.boardId).toBe('bd-2')
    expect(hit?.via).toBe('path')
  })

  it('都找不到就是 null（界面要说"白板找不到"）', () => {
    expect(resolveBoard({ boardId: 'bd-无', path: '无.board', view: 'compact' }, boards)).toBeNull()
  })

  it('扫 .note 找引用：能定位到笔记与块', async () => {
    const dir = '笔记/周会.note'
    let doc = emptyBoardDoc('周会')
    doc = insertBoardBlock(doc, 'b1', newBoardBlock('paragraph', 'b2'))
    doc = insertBoardBlock(doc, 'b2', {
      ...newBoardBlock('boardref', 'b3'),
      boardId: 'bd-1',
      path: '白板/项目.board',
      view: 'preview',
    })
    const files = boardFiles(dir, doc)

    const result = await scanBoardRefs([dir], async () => files)
    expect(result.failed).toEqual([])
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.noteTitle).toBe('周会')
    expect(result.hits[0]?.blockId).toBe('b3')
    expect(result.hits[0]?.ref.boardId).toBe('bd-1')
    expect(result.hits[0]?.ref.view).toBe('preview')
    expect(refsOfBoard(result.hits, 'bd-1')).toHaveLength(1)
    expect(refsOfBoard(result.hits, 'bd-2')).toHaveLength(0)
  })

  it('读不出来的笔记记一笔失败，不当成"没有引用"', async () => {
    const result = await scanBoardRefs(['坏.note'], async () => {
      throw new Error('权限没了')
    })
    expect(result.hits).toEqual([])
    expect(result.failed).toHaveLength(1)
  })

  it('引用块没有 boardId 就降级成 unknown，不会变成空卡片', async () => {
    const dir = '坏引用.note'
    let doc = emptyBoardDoc('坏引用')
    doc = insertBoardBlock(doc, 'b1', { ...newBoardBlock('boardref', 'b2'), boardId: '' })
    const files = boardFiles(dir, doc)
    const result = await scanBoardRefs([dir], async () => files)
    expect(result.hits).toEqual([])
    expect(files[`${dir}/blocks/b2.json`]).toContain('boardref')
    const parsed = await scanBoardRefs([dir], async () => files)
    expect(parsed.failed).toEqual([])
  })
})
