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
  layoutOf,
  linksOf,
  moveBlockTo,
  newBlock,
  newBoardFile,
  nextBlockId,
  parseBoardFile,
  posOf,
  clearHeight,
  removeBlock,
  removeLink,
  reverseLink,
  serializeBoardFile,
  setPos,
  updateBlock,
  updateLink,
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

describe('.board 画布：自由坐标', () => {
  it('新白板默认就是自由画布', () => {
    expect(newBoardFile('t').layout.mode).toBe('free')
  })

  it('挪一块会把旧版纵向白板切成自由画布', () => {
    const stack = parseBoardFile(
      JSON.stringify({
        format: 'board',
        version: 1,
        boardId: 'bd-x',
        title: 't',
        layout: { mode: 'stack', order: ['n1', 'n2'] },
        blocks: {
          n1: { id: 'n1', type: 'paragraph', content: [] },
          n2: { id: 'n2', type: 'paragraph', content: [] },
        },
        links: [],
      }),
    )
    if (stack.kind !== 'ok') throw new Error('parse failed')
    expect(stack.doc.layout.mode).toBe('stack')

    const moved = setPos(stack.doc, 'n2', { x: 120, y: 260 })
    expect(moved.layout.mode).toBe('free')
    expect(posOf(moved, 'n2')).toEqual({ x: 120, y: 260 })
    // 没挪的那块还是没坐标 —— 由兜底位置顶上，不算丢
    expect(posOf(moved, 'n1')).toBeNull()
  })

  it('坐标取整、宽度保留；没变化时不产生新对象（避免假 diff）', () => {
    const doc = newBoardFile('t')
    const withBlock = insertBlock(doc, null, newBlock('paragraph', 'n1'))

    const a = setPos(withBlock, 'n1', { x: 10.4, y: 20.6, w: 300.2 })
    expect(posOf(a, 'n1')).toEqual({ x: 10, y: 21, w: 300 })

    const same = setPos(a, 'n1', { x: 10, y: 21, w: 300 })
    expect(same).toBe(a)
  })

  it('宽度可以单独调，坐标不变', () => {
    const doc = insertBlock(newBoardFile('t'), null, newBlock('paragraph', 'n1'))
    const a = setPos(doc, 'n1', { x: 5, y: 5, w: 320 })
    const b = setPos(a, 'n1', { x: 5, y: 5, w: 420 })
    expect(posOf(b, 'n1')).toEqual({ x: 5, y: 5, w: 420 })
  })

  it('layoutOf：有坐标用坐标，没坐标按顺序兜底成一列（行距够高，不会叠）', () => {
    let doc = insertBlock(newBoardFile('t'), null, newBlock('paragraph', 'n1'))
    doc = insertBlock(doc, 'n1', newBlock('paragraph', 'n2'))
    doc = insertBlock(doc, 'n2', newBlock('paragraph', 'n3'))
    const placed = setPos(doc, 'n2', { x: 400, y: 10 })
    const spots = layoutOf(placed)
    expect(spots.n2).toEqual({ x: 400, y: 10 })
    expect(spots.n1?.x).toBe(0)
    expect(spots.n1?.y).toBe(0)
    // 没坐标的两块落在同一列上，且隔得开
    expect(spots.n3?.x).toBe(0)
    expect((spots.n3?.y ?? 0) - (spots.n1?.y ?? 0)).toBeGreaterThanOrEqual(150)
  })

  it('坏坐标整条丢掉，不把 NaN 带进画布', () => {
    const parsed = parseBoardFile(
      JSON.stringify({
        format: 'board',
        version: 1,
        boardId: 'bd-x',
        title: 't',
        layout: {
          mode: 'free',
          order: ['n1', 'n2', 'n3'],
          pos: { n1: { x: 1, y: 2 }, n2: { x: 'x', y: 2 }, n3: { x: 3 } },
        },
        blocks: {
          n1: { id: 'n1', type: 'paragraph', content: [] },
          n2: { id: 'n2', type: 'paragraph', content: [] },
          n3: { id: 'n3', type: 'paragraph', content: [] },
        },
        links: [],
      }),
    )
    if (parsed.kind !== 'ok') throw new Error('parse failed')
    expect(parsed.doc.layout.pos).toEqual({ n1: { x: 1, y: 2 } })
    // 剩下两块仍能显示（靠兜底）
    expect(Object.keys(layoutOf(parsed.doc))).toEqual(['n1', 'n2', 'n3'])
  })

  it('删块把坐标一起清掉，不留死数据', () => {
    let doc = insertBlock(newBoardFile('t'), null, newBlock('paragraph', 'n1'))
    doc = setPos(doc, 'n1', { x: 10, y: 10 })
    const next = removeBlock(doc, 'n1')
    expect(next.layout.pos).toBeUndefined()
  })

  it('复制出来的块往右下错开 28px，不压在原件上', () => {
    let doc = insertBlock(newBoardFile('t'), null, newBlock('paragraph', 'n1'))
    doc = setPos(doc, 'n1', { x: 100, y: 100, w: 320 })
    const dup = duplicateBlock(doc, 'n1')
    expect(dup).not.toBeNull()
    if (!dup) return
    expect(posOf(dup.doc, dup.id)).toEqual({ x: 128, y: 128, w: 320 })
  })

  it('高度也能存、能清：拖过下边缘就固定，双击回"跟着内容走"', () => {
    let doc = insertBlock(newBoardFile('t'), null, newBlock('paragraph', 'n1'))
    doc = setPos(doc, 'n1', { x: 10, y: 20, w: 400 })
    expect(posOf(doc, 'n1')).toEqual({ x: 10, y: 20, w: 400 })

    const fixed = setPos(doc, 'n1', { x: 10, y: 20, h: 260 })
    expect(posOf(fixed, 'n1')).toEqual({ x: 10, y: 20, w: 400, h: 260 })

    // 只挪位置：宽高都该原样留着
    const moved = setPos(fixed, 'n1', { x: 90, y: 90 })
    expect(posOf(moved, 'n1')).toEqual({ x: 90, y: 90, w: 400, h: 260 })

    const auto = clearHeight(moved, 'n1')
    expect(posOf(auto, 'n1')).toEqual({ x: 90, y: 90, w: 400 })
    // 已经是自动高度了就原样返回（不制造假改动）
    expect(clearHeight(auto, 'n1')).toBe(auto)

    const parsed = parseBoardFile(serializeBoardFile(fixed))
    if (parsed.kind !== 'ok') throw new Error('parse failed')
    expect(parsed.doc.layout.pos).toEqual({ n1: { x: 10, y: 20, w: 400, h: 260 } })
  })

  it('高度写坏了只丢这个字段，坐标留着', () => {
    const text = JSON.stringify({
      app: 'dusk-depot',
      format: 'board',
      version: 1,
      boardId: 'bd-y',
      title: 't',
      layout: { mode: 'free', order: ['a'], pos: { a: { x: 5, y: 6, w: 300, h: -3 } } },
      blocks: { a: { id: 'a', type: 'paragraph', content: [] } },
      links: [],
    })
    const parsed = parseBoardFile(text)
    if (parsed.kind !== 'ok') throw new Error('parse failed')
    expect(parsed.doc.layout.pos).toEqual({ a: { x: 5, y: 6, w: 300 } })
  })

  it('坐标和宽度能原样往返', () => {
    let doc = insertBlock(newBoardFile('t'), null, newBlock('image', 'n1'))
    doc = setPos(doc, 'n1', { x: -40, y: 88, w: 512 })
    const parsed = parseBoardFile(serializeBoardFile(doc))
    if (parsed.kind !== 'ok') throw new Error('parse failed')
    expect(parsed.doc.layout.mode).toBe('free')
    expect(parsed.doc.layout.pos).toEqual({ n1: { x: -40, y: 88, w: 512 } })
  })
})

describe('连接：锚边、改、反向', () => {
  const withLink = (): BoardFileDoc =>
    addLink(docWithBlocks(), {
      id: 'l2',
      from: 'n2',
      to: 'n3',
      type: 'related',
      label: '',
      fromSide: 'right',
      toSide: 'left',
      createdAt: 2,
    })

  it('锚边能原样往返（从哪个圆点拖出来的，重开还在那个点）', () => {
    const parsed = parseBoardFile(serializeBoardFile(withLink()))
    if (parsed.kind !== 'ok') throw new Error('parse failed')
    const l = parsed.doc.links.find((x) => x.id === 'l2')
    expect(l?.fromSide).toBe('right')
    expect(l?.toSide).toBe('left')
  })

  it('锚边写坏时只丢这个字段，连接本身留着', () => {
    const text = JSON.stringify({
      app: 'dusk-depot',
      format: 'board',
      version: 1,
      boardId: 'bd-x',
      title: 't',
      layout: { mode: 'free', order: ['a', 'b'] },
      blocks: {
        a: { id: 'a', type: 'paragraph', content: [] },
        b: { id: 'b', type: 'paragraph', content: [] },
      },
      links: [{ id: 'l1', from: 'a', to: 'b', type: 'related', label: '', fromSide: '斜着' }],
    })
    const parsed = parseBoardFile(text)
    if (parsed.kind !== 'ok') throw new Error('parse failed')
    expect(parsed.doc.links).toHaveLength(1)
    const kept = parsed.doc.links[0]
    expect(kept?.fromSide).toBeUndefined()
    expect(kept?.toSide).toBeUndefined()
  })

  it('没记锚边的老连接照样能读（线自己找边）', () => {
    const parsed = parseBoardFile(serializeBoardFile(docWithBlocks()))
    if (parsed.kind !== 'ok') throw new Error('parse failed')
    const old = parsed.doc.links[0]
    expect(old?.fromSide).toBeUndefined()
    expect(old?.type).toBe('depends')
    expect(old?.label).toBe('先做这个')
  })

  it('updateLink 只动这一条，别的连接和块不受影响', () => {
    const before = withLink()
    const after = updateLink(before, 'l2', { type: 'source', label: '出处' })
    const l2 = after.links.find((x) => x.id === 'l2')
    expect(l2?.type).toBe('source')
    expect(l2?.label).toBe('出处')
    expect(l2?.fromSide).toBe('right')
    expect(after.links.find((x) => x.id === 'l1')).toEqual(before.links.find((x) => x.id === 'l1'))
    expect(after.blocks).toEqual(before.blocks)
    expect(after.layout).toEqual(before.layout)
  })

  it('updateLink 传 undefined 是"清掉锚边"，不是存一个 undefined', () => {
    const after = updateLink(withLink(), 'l2', { toSide: undefined })
    const l2 = after.links.find((x) => x.id === 'l2')
    expect(l2 && 'toSide' in l2).toBe(false)
    expect(l2?.fromSide).toBe('right')
    expect(JSON.parse(serializeBoardFile(after)).links[1].toSide).toBeUndefined()
  })

  it('updateLink 找不到 id 就原样返回（引用同一个对象，不制造假改动）', () => {
    const doc = withLink()
    expect(updateLink(doc, 'nope', { label: 'x' })).toBe(doc)
  })

  it('reverseLink 对调起点终点，锚边换到对面', () => {
    const after = reverseLink(withLink(), 'l2')
    const l2 = after.links.find((x) => x.id === 'l2')
    expect(l2?.from).toBe('n3')
    expect(l2?.to).toBe('n2')
    expect(l2?.fromSide).toBe('right') // 原来的左边 → 反过来是右边
    expect(l2?.toSide).toBe('left')
  })

  it('reverseLink 不动没有锚边的连接（不会凭空长出边）', () => {
    const after = reverseLink(docWithBlocks(), 'l1')
    const l1 = after.links.find((x) => x.id === 'l1')
    expect(l1?.from).toBe('n2')
    expect(l1?.to).toBe('n1')
    expect(l1?.fromSide).toBeUndefined()
    expect(l1?.toSide).toBeUndefined()
  })
})

describe('组块与字号', () => {
  /** 绕开 parse 直接从原始 JSON 读，才能测"写坏了会怎样" */
  const rawDoc = (blocks: Record<string, unknown>) =>
    JSON.stringify({
      app: 'dusk-depot',
      format: 'board',
      version: 1,
      boardId: 'bd-g',
      title: 't',
      layout: { mode: 'free', order: Object.keys(blocks), pos: {} },
      blocks,
      links: [],
    })

  const parse = (text: string): BoardFileDoc => {
    const r = parseBoardFile(text)
    if (r.kind !== 'ok') throw new Error(`parse failed: ${JSON.stringify(r)}`)
    return r.doc
  }

  it('group 的标题与成员能原样往返', () => {
    const fresh = newBlock('group', 'g1')
    expect(fresh.title).toBe('分组')
    expect(fresh.children).toEqual([])

    let doc = newBoardFile('t')
    doc = insertBlock(doc, null, { ...fresh, title: '第一章', children: ['n1', 'n2'] })
    const back = parse(serializeBoardFile(doc))
    expect(back.blocks.g1?.type).toBe('group')
    expect(back.blocks.g1?.title).toBe('第一章')
    expect(back.blocks.g1?.children).toEqual(['n1', 'n2'])
  })

  it('group 的 title / children 写坏了给兜底，不整块降级成 unknown', () => {
    const doc = parse(
      rawDoc({ g1: { id: 'g1', type: 'group', title: 3, children: ['a', 7, null, 'b'] } }),
    )
    const g = doc.blocks.g1
    expect(g?.type).toBe('group')
    expect(g?.title).toBe('分组')
    expect(g?.children).toEqual(['a', 'b'])
  })

  it('group 的未知字段原样保留（组合以后加属性也不会丢）', () => {
    const doc = parse(
      rawDoc({ g1: { id: 'g1', type: 'group', title: 't', children: [], collapsed: true } }),
    )
    expect(doc.blocks.g1?.extra).toEqual({ collapsed: true })
    expect(serializeBoardFile(doc)).toContain('"collapsed": true')
  })

  it('字号能原样往返，且只属于这一块', () => {
    let doc = newBoardFile('t')
    doc = insertBlock(doc, null, newBlock('paragraph', 'n1'))
    doc = insertBlock(doc, 'n1', newBlock('paragraph', 'n2'))
    doc = updateBlock(doc, 'n1', { fontSize: 26 })
    const back = parse(serializeBoardFile(doc))
    expect(back.blocks.n1?.fontSize).toBe(26)
    expect(back.blocks.n2?.fontSize).toBeUndefined()
    expect(back.links).toEqual(doc.links)
    expect(back.layout).toEqual(doc.layout)
  })

  it('字号越界 / 不是数字时只丢这个字段，文字块照常能读', () => {
    const doc = parse(
      rawDoc({
        a: { id: 'a', type: 'paragraph', content: [{ type: 'text', text: '甲' }], fontSize: 999 },
        b: { id: 'b', type: 'quote', content: [{ type: 'text', text: '乙' }], fontSize: '大' },
        c: { id: 'c', type: 'todo', content: [], checked: false, fontSize: 20 },
      }),
    )
    expect(doc.blocks.a?.fontSize).toBeUndefined()
    expect(doc.blocks.b?.fontSize).toBeUndefined()
    expect(doc.blocks.c?.fontSize).toBe(20)
    expect(Object.keys(doc.blocks)).toEqual(['a', 'b', 'c'])
  })

  it('组合只是一条框记录：子块仍在顶层，删掉组不动它们', () => {
    let doc = newBoardFile('t')
    doc = insertBlock(doc, null, newBlock('paragraph', 'n1'))
    doc = insertBlock(doc, 'n1', newBlock('paragraph', 'n2'))
    doc = insertBlock(doc, 'n2', { ...newBlock('group', 'g1'), children: ['n1', 'n2'] })
    const after = removeBlock(doc, 'g1')
    expect(after.blocks.g1).toBeUndefined()
    expect(Object.keys(after.blocks).sort()).toEqual(['n1', 'n2'])
    expect(after.layout.order).toEqual(['n1', 'n2'])
  })
})
