import { describe, expect, it } from 'vitest'
import {
  buildTable,
  emptyTable,
  escapeCell,
  splitRow,
  tableAt,
} from '../../src/core/markdown/table'

describe('splitRow', () => {
  it('拆出单元格，首尾竖线可有可无', () => {
    expect(splitRow('| a | b |')).toEqual(['a', 'b'])
    expect(splitRow('a | b')).toEqual(['a', 'b'])
  })

  it('转义的竖线当成单元格内容', () => {
    expect(splitRow('| a \\| b | c |')).toEqual(['a | b', 'c'])
  })

  it('空单元格保留', () => {
    expect(splitRow('| a |  | c |')).toEqual(['a', '', 'c'])
  })
})

describe('buildTable', () => {
  it('第一行当表头，补分隔行', () => {
    expect(buildTable([['甲', '乙'], ['1', '2']])).toBe(
      ['| 甲 | 乙 |', '| --- | --- |', '| 1 | 2 |'].join('\n'),
    )
  })

  it('行长度不齐时补空', () => {
    expect(buildTable([['甲', '乙'], ['1']])).toBe(
      ['| 甲 | 乙 |', '| --- | --- |', '| 1 |  |'].join('\n'),
    )
  })

  it('能往返：build → tableAt 得回同样的单元格', () => {
    const cells = [
      ['a', 'b'],
      ['1', '2'],
    ]
    const text = buildTable(cells)
    const back = tableAt(text.split('\n'), 1)
    expect(back?.cells).toEqual(cells)
  })

  it('单元格里的竖线不会破坏结构', () => {
    const text = buildTable([['a | b', 'c']])
    const back = tableAt(text.split('\n'), 1)
    expect(back?.cells[0]).toEqual(['a | b', 'c'])
  })
})

describe('escapeCell', () => {
  it('竖线转义，换行压成空格', () => {
    expect(escapeCell('a | b\nc')).toBe('a \\| b c')
  })
})

describe('tableAt', () => {
  const doc = ['# 标题', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '正文'].join('\n')

  it('命中表头、数据行都能找到整张表', () => {
    expect(tableAt(doc.split('\n'), 3)?.cells).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(tableAt(doc.split('\n'), 5)?.cells).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('给出行范围（1 起算）', () => {
    const t = tableAt(doc.split('\n'), 4)
    expect([t?.fromLine, t?.toLine]).toEqual([3, 5])
  })

  it('不在表格里返回 null', () => {
    expect(tableAt(doc.split('\n'), 1)).toBeNull()
    expect(tableAt(doc.split('\n'), 7)).toBeNull()
  })

  it('没有分隔行的竖线不算表格', () => {
    expect(tableAt(['| a | b |', '| 1 | 2 |'], 1)).toBeNull()
  })
})

describe('emptyTable', () => {
  it('rows 行数据 + 1 行表头，cols 列', () => {
    const t = emptyTable(2, 3)
    expect(t).toHaveLength(3)
    expect(t[0]).toEqual(['列 1', '列 2', '列 3'])
    expect(t[1]).toEqual(['', '', ''])
  })
})
