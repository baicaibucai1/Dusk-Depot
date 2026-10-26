import { describe, expect, it } from 'vitest'
import {
  normalizeText,
  outlineOf,
  parseMarkdown,
  plainText,
  tokenize,
} from '../../src/core/markdown/parse'

describe('normalizeText', () => {
  it('CRLF 与 CR 都归一成 LF', () => {
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('吃掉 BOM', () => {
    expect(normalizeText('\uFEFF# 标题')).toBe('# 标题')
  })
})

describe('tokenize', () => {
  it('认粗体、斜体、行内代码', () => {
    expect(tokenize('**重** *轻* `码`')).toEqual([
      { t: 'bold', v: '重' },
      { t: 'text', v: ' ' },
      { t: 'italic', v: '轻' },
      { t: 'text', v: ' ' },
      { t: 'code', v: '码' },
    ])
  })

  it('认双链与标签', () => {
    expect(tokenize('见 [[路径层]] 和 #设计')).toEqual([
      { t: 'text', v: '见 ' },
      { t: 'wiki', v: '路径层' },
      { t: 'text', v: ' 和 ' },
      { t: 'tag', v: '设计' },
    ])
  })

  it('纯文字原样返回', () => {
    expect(tokenize('一干二净')).toEqual([{ t: 'text', v: '一干二净' }])
  })
})

describe('parseMarkdown', () => {
  it('认标题层级', () => {
    const blocks = parseMarkdown('# 一\n## 二\n### 三')
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'heading', 'heading'])
    expect(blocks[1]).toMatchObject({ t: 'heading', level: 2 })
  })

  it('空行分段，段内的换行并成一段', () => {
    const blocks = parseMarkdown('第一行\n第二行\n\n另一段')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ t: 'para' })
    expect(blocks[0]?.t === 'para' ? plainText(blocks[0].inlines) : '').toBe(
      '第一行 第二行',
    )
  })

  it('认列表、引用、代码围栏', () => {
    const blocks = parseMarkdown('- 甲\n\n> 乙\n\n```ts\nconst a = 1\n```')
    expect(blocks.map((b) => b.t)).toEqual(['li', 'quote', 'code'])
    expect(blocks[2]).toMatchObject({ t: 'code', lang: 'ts', text: 'const a = 1' })
  })

  it('不认识的语法当普通文字，不猜', () => {
    const blocks = parseMarkdown('| 表格 | 不认 |')
    expect(blocks[0]).toMatchObject({ t: 'para' })
  })
})

describe('表格', () => {
  it('认出表头与数据行', () => {
    const blocks = parseMarkdown('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |')
    expect(blocks).toHaveLength(1)
    const t = blocks[0]
    expect(t?.t).toBe('table')
    if (t?.t !== 'table') throw new Error('不是表格')
    expect(t.head.map((c) => plainText(c))).toEqual(['甲', '乙'])
    expect(t.rows[0]?.map((c) => plainText(c))).toEqual(['1', '2'])
  })

  it('单元格里的行内语法照常解析', () => {
    const t = parseMarkdown('| **粗** | [[链]] |\n| --- | --- |\n| a | b |')[0]
    if (t?.t !== 'table') throw new Error('不是表格')
    expect(t.head[0]?.[0]).toEqual({ t: 'bold', v: '粗' })
    expect(t.head[1]?.[0]).toEqual({ t: 'wiki', v: '链' })
  })
})

describe('数学', () => {
  it('行内 $x$', () => {
    expect(tokenize('面积 $S=\\pi r^2$ 好')).toContainEqual({ t: 'math', v: 'S=\\pi r^2' })
  })

  it('块级：折行写', () => {
    expect(parseMarkdown('$$\nE=mc^2\n$$')[0]).toMatchObject({ t: 'mathblock', tex: 'E=mc^2' })
  })

  it('块级：单行写', () => {
    expect(parseMarkdown('$$a+b$$')[0]).toMatchObject({ t: 'mathblock', tex: 'a+b' })
  })
})

describe('图片', () => {
  it('![文字](地址)', () => {
    expect(tokenize('看图 ![说明](a.png) 完')).toContainEqual({
      t: 'image',
      alt: '说明',
      src: 'a.png',
    })
  })
})
describe('普通链接', () => {
  it('[文字](地址) 解析成 link', () => {
    expect(tokenize('看 [官网](https://example.com) 吧')).toContainEqual({
      t: 'link',
      v: '官网',
      href: 'https://example.com',
    })
  })

  it('图片不会被当成链接', () => {
    const items = tokenize('![图](a.png)')
    expect(items).toContainEqual({ t: 'image', alt: '图', src: 'a.png' })
    expect(items.some((i) => i.t === 'link')).toBe(false)
  })
})
describe('outlineOf', () => {
  it('只取标题，按顺序', () => {
    expect(outlineOf('# 一\n正文\n## 二')).toEqual([
      { level: 1, text: '一' },
      { level: 2, text: '二' },
    ])
  })
})
