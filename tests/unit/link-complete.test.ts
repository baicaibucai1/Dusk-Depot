import { describe, expect, it } from 'vitest'
import { wikiOptions, wikiQueryAt, type LinkTarget } from '../../src/core/markdown/linkComplete'

const targets: LinkTarget[] = [
  { path: '开始这里.md', title: '开始这里', headings: ['今天要做的', '一张表'] },
  { path: '项目/周计划.md', title: '周计划', headings: ['本周', '待定'] },
  { path: '语法示例.md', title: '语法示例', headings: [] },
]

describe('wikiQueryAt', () => {
  it('刚打完 [[ 就认', () => {
    const t = '看 [['
    expect(wikiQueryAt(t, t.length)).toEqual({ from: 2, typed: '' })
  })

  it('接着打的字算 typed', () => {
    const t = '看 [[周计'
    expect(wikiQueryAt(t, t.length)).toEqual({ from: 2, typed: '周计' })
  })

  it('已经收尾的 [[x]] 不算 —— 光标在 ]] 后面不该再弹', () => {
    const t = '看 [[周计划]] '
    expect(wikiQueryAt(t, t.length)).toBeNull()
  })

  it('光标退到 ] 之后就不再是"正在输入"', () => {
    const t = '[[周计划]]'
    expect(wikiQueryAt(t, t.length)).toBeNull()
  })

  it('换行断开就不算（双链不跨行）', () => {
    const t = '[[\n周'
    expect(wikiQueryAt(t, t.length)).toBeNull()
  })

  it('没有 [[ 就是 null', () => {
    expect(wikiQueryAt('普通句子', 4)).toBeNull()
  })
})

describe('wikiOptions', () => {
  it('空输入列全部（最多 30 条）', () => {
    expect(wikiOptions(targets, '').map((i) => i.insert)).toEqual([
      '[[开始这里.md]]',
      '[[项目/周计划.md]]',
      '[[语法示例.md]]',
    ])
  })

  it('按标题过滤', () => {
    expect(wikiOptions(targets, '周').map((i) => i.label)).toEqual(['周计划'])
  })

  it('按路径过滤（打目录名也能找到）', () => {
    expect(wikiOptions(targets, '项目/').map((i) => i.label)).toEqual(['周计划'])
  })

  it('打了 # 就列那一篇的小节，插出去带小节', () => {
    expect(wikiOptions(targets, '周计划#').map((i) => i.insert)).toEqual([
      '[[项目/周计划.md#本周]]',
      '[[项目/周计划.md#待定]]',
    ])
  })

  it('小节名也能过滤', () => {
    expect(wikiOptions(targets, '周计划#待').map((i) => i.label)).toEqual(['周计划 › 待定'])
  })

  it('篇名对不上就什么都不列（不拿别篇的小节骗人）', () => {
    expect(wikiOptions(targets, '不存在的篇#本周')).toEqual([])
  })

  it('没有小节的篇，打 # 之后是空列表', () => {
    expect(wikiOptions(targets, '语法示例#')).toEqual([])
  })

  it('搜不到就空，不硬凑', () => {
    expect(wikiOptions(targets, 'zzzz')).toEqual([])
  })
})
