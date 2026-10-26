import { describe, expect, it } from 'vitest'
import {
  blockPath,
  diffDoc,
  docFiles,
  emptyDoc,
  insertBlock,
  isNoteDocPath,
  moveBlock,
  moveBlockTo,
  orderedBlocks,
  parseNoteDoc,
  removeBlock,
  removedBlockFiles,
  updateBlock,
} from '../../src/core/note/format'

const DIR = '演示.note'

function makeDoc() {
  return emptyDoc('演示')
}

describe('路径与标记', () => {
  it('认 .note 后缀', () => {
    expect(isNoteDocPath('a.note')).toBe(true)
    expect(isNoteDocPath('dir/b.note')).toBe(true)
    expect(isNoteDocPath('c.md')).toBe(false)
  })

  it('块文件路径落在 blocks/ 下', () => {
    expect(blockPath(DIR, 'b1')).toBe('演示.note/blocks/b1.json')
  })
})

describe('往返', () => {
  it('docFiles → parseNoteDoc 得回同样的结构', () => {
    const doc = makeDoc()
    const files = docFiles(DIR, doc)
    const back = parseNoteDoc(DIR, files)
    expect(back?.order).toEqual(doc.order)
    expect(back?.blocks.b1?.type).toBe('paragraph')
    expect(back?.meta.title).toBe('演示')
  })

  it('没有标记文件就不认（防止把普通目录当 .note）', () => {
    expect(parseNoteDoc(DIR, {})).toBeNull()
  })

  it('块 JSON 坏掉只丢那一块，不炸整篇', () => {
    const files = docFiles(DIR, makeDoc())
    files['演示.note/blocks/b2.json'] = '{ 这不是 json'
    const back = parseNoteDoc(DIR, files)
    expect(back).not.toBeNull()
    expect(back?.blocks.b2).toBeUndefined()
  })

  it('order 里没提到但文件存在的块会补到末尾', () => {
    const files = docFiles(DIR, makeDoc())
    files['演示.note/blocks/zz.json'] = JSON.stringify({ id: 'zz', type: 'paragraph', text: '孤儿块' })
    const back = parseNoteDoc(DIR, files)
    expect(back?.order).toContain('zz')
  })
})

describe('只写变动（这是这个格式的意义）', () => {
  it('什么都没改 → 一个文件都不写', () => {
    const doc = makeDoc()
    expect(diffDoc(DIR, doc, doc)).toEqual({})
  })

  it('改一段文字 → 只写那一个块文件', () => {
    const before = makeDoc()
    const after = updateBlock(before, 'b1', { text: '改了一句' })
    const changed = Object.keys(diffDoc(DIR, before, after))
    expect(changed).toEqual(['演示.note/blocks/b1.json'])
  })

  it('改标题 → 只写 meta.json', () => {
    const before = makeDoc()
    const after = { ...before, meta: { ...before.meta, title: '新标题' } }
    expect(Object.keys(diffDoc(DIR, before, after))).toEqual(['演示.note/meta.json'])
  })

  it('加一块 → 写新块 + order.json', () => {
    const before = makeDoc()
    const after = insertBlock(before, 'b1', { id: 'b2', type: 'paragraph', text: '' })
    const changed = Object.keys(diffDoc(DIR, before, after)).sort()
    expect(changed).toEqual(['演示.note/blocks/b2.json', '演示.note/order.json'])
  })

  it('删一块 → 要删对应的块文件', () => {
    const before = insertBlock(makeDoc(), 'b1', { id: 'b2', type: 'paragraph', text: '' })
    const after = removeBlock(before, 'b2')
    expect(removedBlockFiles(DIR, before, after)).toEqual(['演示.note/blocks/b2.json'])
  })
})

describe('拖动排序', () => {
  const three = () => {
    let d = emptyDoc('t')
    d = insertBlock(d, 'b1', { id: 'b2', type: 'paragraph', text: '' })
    d = insertBlock(d, 'b2', { id: 'b3', type: 'paragraph', text: '' })
    return d
  }

  it('往后拖', () => {
    expect(moveBlockTo(three(), 'b1', 3).order).toEqual(['b2', 'b3', 'b1'])
  })

  it('往前拖', () => {
    expect(moveBlockTo(three(), 'b3', 0).order).toEqual(['b3', 'b1', 'b2'])
  })

  it('拖到原位不动', () => {
    expect(moveBlockTo(three(), 'b2', 1).order).toEqual(['b1', 'b2', 'b3'])
    expect(moveBlockTo(three(), 'b2', 2).order).toEqual(['b1', 'b2', 'b3'])
  })
})
describe('编辑操作', () => {
  it('插入到指定的块后面', () => {
    let doc = makeDoc()
    doc = insertBlock(doc, 'b1', { id: 'b2', type: 'paragraph', text: '第二块' })
    doc = insertBlock(doc, 'b1', { id: 'b3', type: 'paragraph', text: '夹在中间' })
    expect(doc.order).toEqual(['b1', 'b3', 'b2'])
  })

  it('移动块', () => {
    let doc = makeDoc()
    doc = insertBlock(doc, 'b1', { id: 'b2', type: 'paragraph', text: '' })
    doc = insertBlock(doc, 'b2', { id: 'b3', type: 'paragraph', text: '' })
    doc = moveBlock(doc, 'b3', -1)
    expect(doc.order).toEqual(['b1', 'b3', 'b2'])
    doc = moveBlock(doc, 'b1', 1)
    expect(doc.order).toEqual(['b3', 'b1', 'b2'])
  })

  it('orderedBlocks 只给出对得上的块', () => {
    const doc = makeDoc()
    const broken = { ...doc, order: ['b1', '不存在'] }
    expect(orderedBlocks(broken)).toHaveLength(1)
  })
})
