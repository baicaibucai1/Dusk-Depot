import { describe, expect, it } from 'vitest'
import {
  blockText,
  cloneBlock,
  convertFlowNodes,
  emptyBlock,
  flowOutline,
  flowSnapshot,
  inlineNodes,
  inlineOf,
  inlineText,
  makeFlowNode,
  pmFromFlow,
  pmNodeOf,
  type FlowBlock,
} from '../../src/core/note/flow'
import {
  FLOW_MARK_TEXT,
  type FlowDoc,
  diffFlowDoc,
  emptyFlowDoc,
  flowDocFiles,
  flowDocToPm,
  parseFlowBlock,
  parseFlowDoc,
  pmToFlowDoc,
  removedFlowBlockFiles,
} from '../../src/core/note/flowDoc'
import { inferNoteMarker, readNoteMarker } from '../../src/core/note/format'
import type { PmDoc, PmNode } from '../../src/core/note/pm'

const DIR = '文档.note'

function doc(nodes: PmNode[]): PmDoc {
  return { type: 'doc', content: nodes }
}

describe('行内：mark ⇄ PM', () => {
  it('粗/斜/删/码都在', () => {
    const nodes = inlineNodes([
      { type: 'text', text: '粗', marks: ['bold'] },
      { type: 'text', text: '斜', marks: ['italic'] },
      { type: 'text', text: '删', marks: ['strike'] },
      { type: 'text', text: '码', marks: ['code'] },
    ])
    expect(nodes.map((n) => n.marks?.[0]?.type)).toEqual(['bold', 'italic', 'strike', 'code'])
    expect(inlineOf(nodes)).toEqual([
      { type: 'text', text: '粗', marks: ['bold'] },
      { type: 'text', text: '斜', marks: ['italic'] },
      { type: 'text', text: '删', marks: ['strike'] },
      { type: 'text', text: '码', marks: ['code'] },
    ])
  })

  it('链接带 href，能原样回来', () => {
    const inline = [
      { type: 'text' as const, text: '内部', marks: [{ type: 'link' as const, href: '项目/周计划.md' }] },
    ]
    expect(inlineOf(inlineNodes(inline))).toEqual(inline)
  })

  it('软换行保留成 hardBreak', () => {
    const nodes = inlineNodes([
      { type: 'text', text: '一' },
      { type: 'hardBreak' },
      { type: 'text', text: '二' },
    ])
    expect(nodes.map((n) => n.type)).toEqual(['text', 'hardBreak', 'text'])
    expect(inlineText(inlineOf(nodes))).toBe('一\n二')
  })

  it('相邻同样式文本会合并，不在文件里碎成一堆', () => {
    const merged = inlineOf([
      { type: 'text', text: '甲', marks: [{ type: 'bold' }] },
      { type: 'text', text: '乙', marks: [{ type: 'bold' }] },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ text: '甲乙' })
  })

  it('认不出的 mark 丢掉，但不影响文字', () => {
    const inline = inlineOf([{ type: 'text', text: '字', marks: [{ type: 'underline' }, { type: 'bold' }] }])
    expect(inline).toEqual([{ type: 'text', text: '字', marks: ['bold'] }])
  })
})

describe('块：PM ⇄ 模型', () => {
  it('段落 / 两级标题 / 引用 / 代码', () => {
    const pm = doc([
      { type: 'paragraph', attrs: { id: 'b1' }, content: [{ type: 'text', text: '正文' }] },
      { type: 'heading', attrs: { id: 'b2', level: 1 }, content: [{ type: 'text', text: '大标题' }] },
      { type: 'heading', attrs: { id: 'b3', level: 2 }, content: [{ type: 'text', text: '小标题' }] },
      { type: 'blockquote', attrs: { id: 'b4' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '引用' }] }] },
      { type: 'codeBlock', attrs: { id: 'b5', language: 'bash' }, content: [{ type: 'text', text: 'npm i\nnpm t' }] },
      { type: 'horizontalRule', attrs: { id: 'b6' } },
    ])
    const snap = flowSnapshot(pm)
    expect(snap.order).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
    expect(snap.blocks.b2?.type).toBe('heading1')
    expect(snap.blocks.b3?.type).toBe('heading2')
    expect(snap.blocks.b4).toMatchObject({ type: 'quote', content: [{ text: '引用' }] })
    expect(snap.blocks.b5).toMatchObject({ type: 'code', text: 'npm i\nnpm t', lang: 'bash' })
    expect(snap.blocks.b6?.type).toBe('divider')

    const back = pmFromFlow(snap.order, snap.blocks)
    expect(back.content.map((n) => n.type)).toEqual([
      'paragraph',
      'heading',
      'heading',
      'blockquote',
      'codeBlock',
      'horizontalRule',
    ])
    expect(back.content[1]?.attrs?.level).toBe(1)
    expect(back.content[4]?.attrs?.language).toBe('bash')
  })

  it('列表：项目符号 / 编号 / 待办，层级是显式结构', () => {
    const pm = doc([
      {
        type: 'bulletList',
        attrs: { id: 'l1' },
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '一' }] }] },
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '二' }] },
              { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '二·子' }] }] }] },
            ],
          },
        ],
      },
      { type: 'orderedList', attrs: { id: 'l2', start: 1 }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
      {
        type: 'taskList',
        attrs: { id: 'l3' },
        content: [
          { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '做完' }] }] },
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '没做' }] }] },
        ],
      },
    ])

    const snap = flowSnapshot(pm)
    expect(snap.blocks.l1?.items).toHaveLength(2)
    expect(snap.blocks.l1?.items?.[1]?.children?.[0]?.items?.[0]?.content).toEqual([{ type: 'text', text: '二·子' }])
    expect(snap.blocks.l3?.items?.map((i) => i.checked)).toEqual([true, false])

    const back = pmFromFlow(snap.order, snap.blocks)
    expect(back.content[0]?.content?.[1]?.content?.[1]?.type).toBe('bulletList')
    expect(back.content[2]?.content?.[0]?.attrs?.checked).toBe(true)
  })

  it('图片只存路径，不塞二进制', () => {
    const snap = flowSnapshot(doc([{ type: 'image', attrs: { id: 'i1', src: '附件/a.png', alt: '图' } }]))
    expect(snap.blocks.i1).toEqual({ id: 'i1', type: 'image', src: '附件/a.png', alt: '图' })
    expect(pmNodeOf(snap.blocks.i1 as FlowBlock)?.attrs?.src).toBe('附件/a.png')
  })

  it('分栏在文档流里还是一个块', () => {
    const pm = doc([
      {
        type: 'columns',
        attrs: { id: 'c1' },
        content: [
          { type: 'column', attrs: { width: 40 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '左' }] }] },
          { type: 'column', attrs: { width: 60 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '右' }] }] },
        ],
      },
    ])
    const snap = flowSnapshot(pm)
    expect(snap.blocks.c1?.columns?.map((c) => c.width)).toEqual([40, 60])
    expect(snap.blocks.c1?.columns?.[1]?.blocks[0]?.content).toEqual([{ type: 'text', text: '右' }])
  })

  it('认不出的块原样留在 raw 里，再转回去还是它', () => {
    const table = {
      type: 'table',
      attrs: { id: 't1', cols: 3 },
      content: [{ type: 'tableRow', content: [] }],
    } as unknown as PmNode
    const snap = flowSnapshot(doc([table]))
    expect(snap.blocks.t1?.type).toBe('unknown')
    expect(snap.blocks.t1?.raw).toMatchObject({ type: 'table', attrs: { cols: 3 } })

    const node = pmNodeOf(snap.blocks.t1 as FlowBlock)
    expect(node?.type).toBe('flowUnknown')
    const again = flowSnapshot(doc([node as PmNode]))
    expect(again.blocks.t1?.raw).toMatchObject({ type: 'table', attrs: { cols: 3 } })
  })

  it('纯文本 / 大纲', () => {
    const snap = flowSnapshot(
      doc([
        { type: 'heading', attrs: { id: 'h', level: 2 }, content: [{ type: 'text', text: '小节' }] },
        { type: 'paragraph', attrs: { id: 'p' }, content: [{ type: 'text', text: '正文' }] },
      ]),
    )
    expect(flowOutline(Object.values(snap.blocks))).toEqual([{ level: 2, text: '小节' }])
    expect(blockText(snap.blocks.p as FlowBlock)).toBe('正文')
  })
})

describe('块类型转换（块菜单）', () => {
  const para = (text: string, id = 'b1'): PmNode => ({
    type: 'paragraph',
    attrs: { id },
    content: [{ type: 'text', text }],
  })

  it('正文 → 一级标题，id 不变', () => {
    const out = convertFlowNodes([para('标题')], 'heading1')
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe('heading')
    expect(out[0]?.attrs).toMatchObject({ id: 'b1', level: 1 })
  })

  it('正文 → 待办，包成一项', () => {
    const out = convertFlowNodes([para('一件事')], 'todoList')
    expect(out[0]?.type).toBe('taskList')
    expect(out[0]?.content?.[0]?.attrs?.checked).toBe(false)
    expect(out[0]?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe('一件事')
  })

  it('三项列表 → 三个段落，第一个继承 id', () => {
    const list: PmNode = {
      type: 'bulletList',
      attrs: { id: 'l1' },
      content: ['甲', '乙', '丙'].map((t) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
      })),
    }
    const out = convertFlowNodes([list], 'paragraph')
    expect(out).toHaveLength(3)
    expect(out[0]?.attrs?.id).toBe('l1')
    expect(out[1]?.attrs?.id).toBeUndefined()
    expect(out.map((n) => n.content?.[0]?.text)).toEqual(['甲', '乙', '丙'])
  })

  it('列表 → 另一种列表，勾选状态不串', () => {
    const todo: PmNode = {
      type: 'taskList',
      attrs: { id: 't' },
      content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }],
    }
    const out = convertFlowNodes([todo], 'bulletList')
    expect(out[0]?.type).toBe('bulletList')
    expect(flowSnapshot({ content: out }).blocks.t).toMatchObject({ type: 'bulletList' })
  })

  it('图片转正文 → 不转（返回空），别把图弄没了', () => {
    expect(convertFlowNodes([{ type: 'image', attrs: { id: 'i', src: 'a.png' } }], 'paragraph')).toEqual([])
  })

  it('复制一块会换 id', () => {
    let n = 0
    const copy = cloneBlock(
      { type: 'bulletList', attrs: { id: 'b1' }, content: [{ type: 'listItem', content: [{ type: 'paragraph', attrs: { id: 'x' } }] }] } as PmNode,
      () => `n${++n}`,
    )
    expect(copy.attrs?.id).toBe('n1')
    expect(copy.content?.[0]?.content?.[0]?.attrs?.id).toBe('n2')
  })

  it('空块构造对每种类型都出得来', () => {
    for (const t of ['paragraph', 'heading1', 'heading2', 'quote', 'code', 'bulletList', 'orderedList', 'todoList', 'divider', 'image', 'columns'] as const) {
      const node = makeFlowNode(t, 'z')
      expect(node, t).not.toBeNull()
      expect(node?.attrs?.id).toBe('z')
      expect(emptyBlock(t, 'z').type).toBe(t)
    }
  })
})

describe('v2 落盘格式', () => {
  it('标记写明 version 2 + layoutMode flow', () => {
    expect(FLOW_MARK_TEXT).toContain('"version": 2')
    expect(FLOW_MARK_TEXT).toContain('"layoutMode": "flow"')
  })

  it('docFiles → parseFlowDoc 得回同样的结构', () => {
    let d = emptyFlowDoc('演示')
    d = {
      ...d,
      order: ['b1', 'b2', 'b3'],
      blocks: {
        b1: { id: 'b1', type: 'paragraph', content: [{ type: 'text', text: '开头' }] },
        b2: { id: 'b2', type: 'bulletList', items: [{ content: [{ type: 'text', text: '一项' }] }, { content: [], children: [{ type: 'divider' }] }] },
        b3: { id: 'b3', type: 'image', src: '附件/a.png' },
      },
    }
    const files = flowDocFiles(DIR, d)
    const back = parseFlowDoc(DIR, files)
    expect(back?.meta.title).toBe('演示')
    expect(back?.order).toEqual(['b1', 'b2', 'b3'])
    expect(back?.blocks.b2?.items?.[1]?.children?.[0]?.type).toBe('divider')
    expect(back?.blocks.b3?.src).toBe('附件/a.png')
    expect(back?.layoutMode).toBe('flow')
  })

  it('没有标记文件就不认', () => {
    expect(parseFlowDoc(DIR, {})).toBeNull()
  })

  it('什么都没改 → 一个文件都不写', () => {
    const d = emptyFlowDoc('t')
    expect(diffFlowDoc(DIR, d, d)).toEqual({})
  })

  it('改一段 → 只写那一个块文件', () => {
    const before = emptyFlowDoc('t')
    const after: FlowDoc = {
      ...before,
      blocks: { b1: { id: 'b1', type: 'paragraph', content: [{ type: 'text', text: '改了' }] } },
    }
    expect(Object.keys(diffFlowDoc(DIR, before, after))).toEqual([`${DIR}/blocks/b1.json`])
  })

  it('加一块 → 写新块 + order.json', () => {
    const before = emptyFlowDoc('t')
    const after: FlowDoc = {
      ...before,
      order: ['b1', 'b2'],
      blocks: { ...before.blocks, b2: { id: 'b2', type: 'divider' } },
    }
    expect(Object.keys(diffFlowDoc(DIR, before, after)).sort()).toEqual([
      `${DIR}/blocks/b2.json`,
      `${DIR}/order.json`,
    ])
  })

  it('删一块 → 要删块文件', () => {
    const before: FlowDoc = {
      ...emptyFlowDoc('t'),
      order: ['b1', 'b2'],
      blocks: { b1: { id: 'b1', type: 'divider' }, b2: { id: 'b2', type: 'divider' } },
    }
    const after: FlowDoc = { ...before, order: ['b1'], blocks: { b1: before.blocks.b1 as FlowBlock } }
    expect(removedFlowBlockFiles(DIR, before, after)).toEqual([`${DIR}/blocks/b2.json`])
  })

  it('未知块类型保存时原样写回，不降级成正文', () => {
    const raw = { id: 'x1', type: 'database', version: 3, payload: { a: 1 } }
    const parsed = parseFlowBlock('x1', JSON.stringify(raw))
    expect(parsed?.type).toBe('unknown')

    const d: FlowDoc = {
      ...emptyFlowDoc('t'),
      order: ['x1'],
      blocks: { x1: parsed as FlowBlock },
    }
    const files = flowDocFiles(DIR, d)
    const written = JSON.parse(files[`${DIR}/blocks/x1.json`] as string) as Record<string, unknown>
    expect(written).toEqual(raw)
  })

  it('块文件坏掉只丢那一块，不炸整篇', () => {
    const files = flowDocFiles(DIR, emptyFlowDoc('t'))
    files[`${DIR}/blocks/b9.json`] = '{ 不是 json'
    const back = parseFlowDoc(DIR, files)
    expect(back).not.toBeNull()
    expect(back?.blocks.b9).toBeUndefined()
  })

  it('order 里没提到的块补到末尾', () => {
    const files = flowDocFiles(DIR, emptyFlowDoc('t'))
    files[`${DIR}/blocks/zz.json`] = JSON.stringify({ id: 'zz', type: 'paragraph', content: [] })
    expect(parseFlowDoc(DIR, files)?.order).toContain('zz')
  })

  it('PM → 文档 → PM 走一圈内容不变', () => {
    const pm = doc([
      { type: 'paragraph', attrs: { id: 'b1' }, content: [{ type: 'text', text: '甲', marks: [{ type: 'bold' }] }] },
      { type: 'horizontalRule', attrs: { id: 'b2' } },
      { type: 'codeBlock', attrs: { id: 'b3', language: 'ts' }, content: [{ type: 'text', text: 'const a = 1' }] },
    ])
    const d = pmToFlowDoc({ title: 't', createdAt: '' }, pm)
    const files = flowDocFiles(DIR, d)
    const back = parseFlowDoc(DIR, files)
    const pm2 = flowDocToPm(back as FlowDoc)
    expect(pm2.content.map((n) => n.type)).toEqual(['paragraph', 'horizontalRule', 'codeBlock'])
    expect(pm2.content[0]?.content?.[0]?.marks?.[0]?.type).toBe('bold')
    expect(pm2.content[2]?.attrs?.language).toBe('ts')
  })
})

describe('v1 / v2 互不干扰', () => {
  const v1Files: Record<string, string> = {
    '旧.note/.note': `${JSON.stringify({ app: 'dusk-depot', format: 'blocks', version: 1 }, null, 2)}\n`,
    '旧.note/meta.json': `${JSON.stringify({ title: '旧', createdAt: '2026-01-01' }, null, 2)}\n`,
    '旧.note/order.json': `${JSON.stringify(['b1', 'b2'], null, 2)}\n`,
    '旧.note/blocks/b1.json': `${JSON.stringify({ id: 'b1', type: 'paragraph', text: '旧正文', layout: { x: 0, y: 20, w: 60 } }, null, 2)}\n`,
    '旧.note/blocks/b2.json': `${JSON.stringify({ id: 'b2', type: 'image', src: '附件/x.png', layout: { x: 62, y: 20, w: 38 } }, null, 2)}\n`,
  }

  it('v1 的标记读成 canvas', () => {
    expect(readNoteMarker('旧.note', v1Files)).toEqual({ version: 1, layoutMode: 'canvas' })
  })

  it('v2 的标记读成 flow', () => {
    const files = flowDocFiles(DIR, emptyFlowDoc('新'))
    expect(readNoteMarker(DIR, files)).toEqual({ version: 2, layoutMode: 'flow' })
  })

  it('标记坏了也能凭块形状认出 v2（不会把 v2 当 v1 覆盖）', () => {
    const files = flowDocFiles(DIR, emptyFlowDoc('新'))
    delete files[`${DIR}/.note`]
    expect(inferNoteMarker(DIR, files)).toEqual({ version: 2, layoutMode: 'flow' })
    expect(inferNoteMarker('旧.note', v1Files)).toEqual({ version: 1, layoutMode: 'canvas' })
  })
})
