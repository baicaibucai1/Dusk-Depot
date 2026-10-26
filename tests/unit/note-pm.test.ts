import { describe, expect, it } from 'vitest'
import { emptyDoc } from '../../src/core/note/format'
import {
  blocksToPm,
  inlineToPm,
  pmInlineToMarkdown,
  pmOrder,
  pmToBlocks,
  pmToSnapshot,
} from '../../src/core/note/pm'

describe('行内 markdown ⇄ PM', () => {
  it('粗体/斜体/划掉/行内码变成 mark', () => {
    const nodes = inlineToPm('**粗** *斜* ~~划~~ `码`')
    expect(nodes.find((n) => n.text === '粗')?.marks).toEqual([{ type: 'bold' }])
    expect(nodes.find((n) => n.text === '斜')?.marks).toEqual([{ type: 'italic' }])
    expect(nodes.find((n) => n.text === '划')?.marks).toEqual([{ type: 'strike' }])
    expect(nodes.find((n) => n.text === '码')?.marks).toEqual([{ type: 'code' }])
  })

  it('链接带 href', () => {
    const nodes = inlineToPm('[官网](https://a.b)')
    expect(nodes[0]?.marks).toEqual([{ type: 'link', attrs: { href: 'https://a.b' } }])
  })

  it('换行变成 hardBreak', () => {
    const nodes = inlineToPm('第一行\n第二行')
    expect(nodes.some((n) => n.type === 'hardBreak')).toBe(true)
  })

  it('转回来还是同样的 markdown', () => {
    const md = '**粗** *斜* ~~划~~ `码` [官网](https://a.b)'
    expect(pmInlineToMarkdown(inlineToPm(md))).toBe(md)
  })

  it('换行转回来是 \\n', () => {
    expect(pmInlineToMarkdown(inlineToPm('一\n二'))).toBe('一\n二')
  })
})

describe('块 ⇄ PM 顶层节点', () => {
  const doc = emptyDoc('t')

  it('每种块都有对应的 PM 节点类型', () => {
    const pm = blocksToPm(doc)
    expect(pm.content[0]?.type).toBe('paragraph')
  })

  it('往返之后块内容不变', () => {
    const pm = blocksToPm(doc)
    const back = pmToBlocks(pm)
    expect(back.b1?.type).toBe('paragraph')
    expect(pmOrder(pm)).toEqual(['b1'])
  })

  it('标题保留级别、图片保留路径和位置', () => {
    const pm = blocksToPm({
      meta: { title: 't', createdAt: '' },
      order: ['h', 'i'],
      blocks: {
        h: { id: 'h', type: 'heading', text: '大标题', level: 1 },
        i: { id: 'i', type: 'image', text: '', src: '附件/a.png', layout: { x: 63, y: 54, w: 37 } },
      },
    })
    expect(pm.content[0]?.attrs?.level).toBe(1)
    expect(pm.content[1]?.attrs?.src).toBe('附件/a.png')
    expect(pm.content[1]?.attrs?.layout).toEqual({ x: 63, y: 54, w: 37 })

    const back = pmToBlocks(pm)
    expect(back.h?.level).toBe(1)
    expect(back.i?.src).toBe('附件/a.png')
    expect(back.i?.layout).toEqual({ x: 63, y: 54, w: 37 })
  })

  it('没有 id 的节点会被跳过（不让脏数据进来）', () => {
    const pm = { type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }
    expect(pmToSnapshot(pm).order).toEqual([])
  })
})
