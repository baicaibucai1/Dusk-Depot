import { describe, expect, it } from 'vitest'
import {
  BOARD_FILE,
  RELATIONS_FILE,
  addRelation,
  assetPath,
  blockLabel,
  boardFiles,
  boardOutline,
  diffBoardDoc,
  emptyBoardDoc,
  insertBoardBlock,
  newBoardBlock,
  nextBoardId,
  parseBoardDoc,
  removeBoardBlock,
  removeRelation,
  removedBoardBlockFiles,
  updateBoardBlock,
} from '../../src/core/note/board'
import { readNoteMarker } from '../../src/core/note/format'

const DIR = '笔记/测试.note'

function filesOf(dir: string, texts: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [p, t] of Object.entries(texts)) out[`${dir}/${p}`] = t
  return out
}

function baseDoc() {
  let doc = emptyBoardDoc('测试')
  doc = updateBoardBlock(doc, 'b1', {
    content: [{ type: 'text', text: '开头', marks: ['bold'] }],
  })
  doc = insertBoardBlock(doc, 'b1', newBoardBlock('todo', 'b2'))
  doc = updateBoardBlock(doc, 'b2', {
    checked: true,
    content: [{ type: 'text', text: '买书' }],
  })
  doc = insertBoardBlock(doc, 'b2', newBoardBlock('heading1', 'b3'))
  doc = updateBoardBlock(doc, 'b3', { content: [{ type: 'text', text: '第一章' }] })
  doc = insertBoardBlock(doc, 'b3', newBoardBlock('quote', 'b4'))
  doc = updateBoardBlock(doc, 'b4', { content: [{ type: 'text', text: '引用' }] })
  doc = insertBoardBlock(doc, 'b4', {
    ...newBoardBlock('image', 'b5'),
    src: `${DIR}/assets/x.png`,
    alt: '图',
  })
  doc = insertBoardBlock(doc, 'b5', {
    ...newBoardBlock('file', 'b6'),
    src: `${DIR}/assets/y.pdf`,
    name: '资料.pdf',
    size: 1234,
  })
  doc = insertBoardBlock(doc, 'b6', newBoardBlock('divider', 'b7'))
  doc = {
    ...doc,
    relations: [
      { id: 'r1', from: 'b1', to: 'b2', type: 'depends', label: '先做这个', createdAt: 1 },
    ],
    settings: { background: 'paper', future: { x: 1 } },
  }
  return doc
}

describe('v3 落盘：目录与文件', () => {
  it('新建文档写 v3 标记、board/relations、一块一文件', () => {
    const doc = emptyBoardDoc('未命名')
    const files = boardFiles(DIR, doc)
    expect(files[`${DIR}/.note`]).toContain('"version": 3')
    expect(files[`${DIR}/.note`]).toContain('"layoutMode": "flow"')
    expect(files[`${DIR}/${BOARD_FILE}`]).toBeTruthy()
    expect(files[`${DIR}/${RELATIONS_FILE}`]).toBeTruthy()
    expect(files[`${DIR}/blocks/b1.json`]).toBeTruthy()
    expect(Object.keys(files).some((p) => p.includes('/assets/'))).toBe(false)
  })

  it('readNoteMarker 能认出 v3', () => {
    const files = boardFiles(DIR, emptyBoardDoc('x'))
    expect(readNoteMarker(DIR, files)).toEqual({ version: 3, layoutMode: 'flow' })
  })
})

describe('v3 解析 / 序列化往返', () => {
  it('所有块类型、行内标记、待办状态、文件信息、设置都保留', () => {
    const doc = baseDoc()
    const parsed = parseBoardDoc(DIR, boardFiles(DIR, doc))
    expect(parsed).not.toBeNull()
    if (!parsed) return

    const got = parsed.doc
    expect(got.order).toEqual(doc.order)
    expect(got.blocks.b1?.content).toEqual([{ type: 'text', text: '开头', marks: ['bold'] }])
    expect(got.blocks.b2).toMatchObject({ type: 'todo', checked: true })
    expect(got.blocks.b5).toMatchObject({ type: 'image', src: `${DIR}/assets/x.png`, alt: '图' })
    expect(got.blocks.b6).toMatchObject({ type: 'file', name: '资料.pdf', size: 1234 })
    expect(got.relations).toHaveLength(1)
    expect(got.settings).toEqual({ background: 'paper', future: { x: 1 } })
    expect(got.layoutMode).toBe('flow')
  })

  it('未知块和未知字段原样写回，不静默降级', () => {
    const files = filesOf(DIR, {
      '.note': JSON.stringify({ version: 3, layoutMode: 'flow' }),
      'meta.json': JSON.stringify({ title: 't', createdAt: '' }),
      'board.json': JSON.stringify({ version: 3, order: ['b1', 'b2'], settings: {} }),
      'relations.json': JSON.stringify({ relations: [] }),
      'blocks/b1.json': JSON.stringify({ id: 'b1', type: 'futureBlock', payload: { deep: [1, 2] } }),
      'blocks/b2.json': JSON.stringify({
        id: 'b2',
        type: 'paragraph',
        content: [{ type: 'text', text: 'x' }],
        futureAttr: 'keep-me',
      }),
    })
    const parsed = parseBoardDoc(DIR, files)
    expect(parsed).not.toBeNull()
    if (!parsed) return
    expect(parsed.doc.blocks.b1?.type).toBe('unknown')

    const out = boardFiles(DIR, parsed.doc)
    const b1 = JSON.parse(out[`${DIR}/blocks/b1.json`] ?? '{}')
    expect(b1).toMatchObject({ type: 'futureBlock', payload: { deep: [1, 2] } })
    const b2 = JSON.parse(out[`${DIR}/blocks/b2.json`] ?? '{}')
    expect(b2.futureAttr).toBe('keep-me')
  })

  it('board.json 坏了不丢块：顺序按文件补，给出提示', () => {
    const files = filesOf(DIR, {
      '.note': JSON.stringify({ version: 3 }),
      'meta.json': JSON.stringify({ title: 't' }),
      'board.json': '{ 坏掉的',
      'relations.json': '{ 也坏了',
      'blocks/b2.json': JSON.stringify({ id: 'b2', type: 'paragraph', content: [] }),
      'blocks/b1.json': JSON.stringify({ id: 'b1', type: 'paragraph', content: [] }),
    })
    const parsed = parseBoardDoc(DIR, files)
    expect(parsed).not.toBeNull()
    if (!parsed) return
    expect(parsed.doc.order.sort()).toEqual(['b1', 'b2'])
    expect(parsed.warnings.join('；')).toMatch('board.json')
    expect(parsed.warnings.join('；')).toMatch('relations.json')
  })

  it('连接缺起点/终点会被跳过并提示，块不受影响', () => {
    const doc = baseDoc()
    const files = boardFiles(DIR, doc)
    files[`${DIR}/${RELATIONS_FILE}`] = JSON.stringify({
      version: 3,
      relations: [
        { id: 'bad', from: 'b1', to: '', type: 'related', label: '' },
        { id: 'ok', from: 'b1', to: 'b2', type: 'related', label: '' },
      ],
    })
    const parsed = parseBoardDoc(DIR, files)
    expect(parsed?.doc.relations.map((r) => r.id)).toEqual(['ok'])
    expect(parsed?.warnings.join('；')).toMatch('缺少起点或终点')
  })
})

describe('v3 差异写盘', () => {
  it('只改一块就只写这一块', () => {
    const before = baseDoc()
    const after = updateBoardBlock(before, 'b1', {
      content: [{ type: 'text', text: '改过了' }],
    })
    const diff = diffBoardDoc(DIR, before, after)
    expect(Object.keys(diff)).toEqual([`${DIR}/blocks/b1.json`])
  })

  it('只改顺序只写 board.json', () => {
    const before = baseDoc()
    const after = { ...before, order: [...before.order].reverse() }
    expect(Object.keys(diffBoardDoc(DIR, before, after))).toEqual([`${DIR}/${BOARD_FILE}`])
  })

  it('只改连接只写 relations.json', () => {
    const before = baseDoc()
    const after = addRelation(before, {
      id: 'r2',
      from: 'b2',
      to: 'b3',
      type: 'related',
      label: '',
      createdAt: 2,
    })
    expect(Object.keys(diffBoardDoc(DIR, before, after))).toEqual([`${DIR}/${RELATIONS_FILE}`])
  })

  it('删块会同时删连接和块文件', () => {
    const before = baseDoc()
    const after = removeBoardBlock(before, 'b2')
    expect(after.relations).toHaveLength(0)
    expect(removedBoardBlockFiles(DIR, before, after)).toEqual([`${DIR}/blocks/b2.json`])
  })

  it('没有任何改动时 diff 为空', () => {
    const doc = baseDoc()
    expect(diffBoardDoc(DIR, doc, doc)).toEqual({})
  })
})

describe('v3 编辑小工具', () => {
  it('id 取当前最大编号 + 1；最大的删掉后可以复用（不撞号）', () => {
    expect(nextBoardId(removeBoardBlock(baseDoc(), 'b7'))).toBe('b7')
    expect(nextBoardId(removeBoardBlock(baseDoc(), 'b3'))).toBe('b8')
  })

  it('同一对块的同一类型/说明不重复加连接', () => {
    const doc = baseDoc()
    const dup = addRelation(doc, doc.relations[0]!)
    expect(dup.relations).toHaveLength(1)
  })

  it('删连接只删那一条', () => {
    const doc = addRelation(baseDoc(), {
      id: 'r2',
      from: 'b2',
      to: 'b3',
      type: 'source',
      label: '',
      createdAt: 2,
    })
    expect(removeRelation(doc, 'r1').relations.map((r) => r.id)).toEqual(['r2'])
  })

  it('大纲只收 H1/H2；标签对空块/文件也说得清', () => {
    const doc = baseDoc()
    expect(boardOutline(doc)).toEqual([{ level: 1, text: '第一章' }])
    expect(blockLabel(doc.blocks.b6, 'b6')).toContain('文件')
    expect(blockLabel(doc.blocks.b7, 'b7')).toContain('分隔线')
    expect(blockLabel(undefined, 'b9')).toContain('已删除')
  })

  it('资产路径会清理非法字符并落在本笔记 assets/ 下', () => {
    const p = assetPath(DIR, 'a:b/c?.png', 1000)
    expect(p.startsWith(`${DIR}/assets/`)).toBe(true)
    expect(p).not.toContain(':')
    expect(p).not.toContain('?')
    expect(p.endsWith('.png')).toBe(true)
  })
})
