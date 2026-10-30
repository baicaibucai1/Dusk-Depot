import { describe, expect, it } from 'vitest'
import { parseMarkdown, plainText, tokenize } from '../../src/core/markdown/parse'
import { buildTable, tableAt } from '../../src/core/markdown/table'

/*
 * 2026-10 对齐参考编辑器（Vditor / Cherry / Milkdown）基线的补充用例。
 * 原有行为在 parse.test.ts / table.test.ts 里守着，这里只测新认的语法。
 */

describe('有序列表', () => {
  it('认 1. 2. 和 1) 2)', () => {
    const blocks = parseMarkdown('1. 甲\n2. 乙\n\n3) 丙')
    expect(blocks.map((b) => b.t)).toEqual(['li', 'li', 'li'])
    const [a, b, c] = blocks
    if (a?.t !== 'li' || b?.t !== 'li' || c?.t !== 'li') throw new Error('不是 li')
    expect([a.ordered, a.start, plainText(a.inlines)]).toEqual([true, 1, '甲'])
    expect([b.ordered, b.start, plainText(b.inlines)]).toEqual([true, 2, '乙'])
    expect([c.ordered, c.start, plainText(c.inlines)]).toEqual([true, 3, '丙'])
  })

  it('序号不重新编号：3. 就是 3', () => {
    const blocks = parseMarkdown('3. 甲\n7. 乙')
    if (blocks[0]?.t !== 'li' || blocks[1]?.t !== 'li') throw new Error('不是 li')
    expect([blocks[0].start, blocks[1].start]).toEqual([3, 7])
  })
})

describe('任务列表', () => {
  it('- [ ] 未做 / - [x] 已做', () => {
    const blocks = parseMarkdown('- [ ] 甲\n- [x] 乙')
    if (blocks[0]?.t !== 'li' || blocks[1]?.t !== 'li') throw new Error('不是 li')
    expect([blocks[0].checked, plainText(blocks[0].inlines)]).toEqual([false, '甲'])
    expect([blocks[1].checked, plainText(blocks[1].inlines)]).toEqual([true, '乙'])
  })

  it('有序任务项：两种记号都认，大小写不敏感', () => {
    const blocks = parseMarkdown('1. [X] 甲\n2. [x] 乙')
    if (blocks[0]?.t !== 'li' || blocks[1]?.t !== 'li') throw new Error('不是 li')
    expect([blocks[0].checked, blocks[0].ordered, blocks[0].start]).toEqual([true, true, 1])
    expect(blocks[1].checked).toBe(true)
  })

  it('普通列表项没有勾态', () => {
    const blocks = parseMarkdown('- 甲\n1. 乙')
    if (blocks[0]?.t !== 'li' || blocks[1]?.t !== 'li') throw new Error('不是 li')
    expect([blocks[0].checked, blocks[1].checked]).toEqual([null, null])
  })
})

describe('分割线', () => {
  it('--- / *** / ___ / - - - 都算', () => {
    expect(parseMarkdown('---').map((b) => b.t)).toEqual(['hr'])
    expect(parseMarkdown('***').map((b) => b.t)).toEqual(['hr'])
    expect(parseMarkdown('___').map((b) => b.t)).toEqual(['hr'])
    expect(parseMarkdown('- - -').map((b) => b.t)).toEqual(['hr'])
  })

  it('两个记号不算，退回段落', () => {
    expect(parseMarkdown('--').map((b) => b.t)).toEqual(['para'])
  })

  it('压在进行中的段落前面：先收段再画线', () => {
    const blocks = parseMarkdown('正文一句\n---')
    expect(blocks.map((b) => b.t)).toEqual(['para', 'hr'])
  })
})

describe('自动链接', () => {
  it('裸 URL 认成链接', () => {
    expect(tokenize('见 https://example.com 好吧')).toContainEqual({
      t: 'link',
      v: 'https://example.com',
      href: 'https://example.com',
    })
  })

  it('URL 尾巴上的标点不算进去', () => {
    expect(tokenize('见 https://example.com。')).toEqual([
      { t: 'text', v: '见 ' },
      { t: 'link', v: 'https://example.com', href: 'https://example.com' },
      { t: 'text', v: '。' },
    ])
    expect(tokenize('(https://a.com.)')).toEqual([
      { t: 'text', v: '(' },
      { t: 'link', v: 'https://a.com', href: 'https://a.com' },
      { t: 'text', v: '.)' },
    ])
  })
})

describe('反斜杠转义', () => {
  it('\\* 不再当天文', () => {
    expect(tokenize(String.raw`\*不斜\*`)).toEqual([{ t: 'text', v: '*不斜*' }])
  })

  it('\\[\\[ 不再是双链', () => {
    expect(tokenize(String.raw`\[\[不是双链\]\]`)).toEqual([{ t: 'text', v: '[[不是双链]]' }])
  })

  it('行内码里的星号不被转义规则动', () => {
    expect(tokenize('`a*b*c`')).toEqual([{ t: 'code', v: 'a*b*c' }])
  })
})

describe('行内数学守卫', () => {
  it('$5 到 $10 不当公式', () => {
    const items = tokenize('省 $5 到 $10 块')
    expect(items.some((i) => i.t === 'math')).toBe(false)
    expect(plainText(items)).toBe('省 $5 到 $10 块')
  })

  it('$ 前后贴空白也不当公式', () => {
    expect(tokenize('$ x $').some((i) => i.t === 'math')).toBe(false)
  })

  it('正常公式照认', () => {
    expect(tokenize('$x$ 和 $a_1$')).toEqual([
      { t: 'math', v: 'x' },
      { t: 'text', v: ' 和 ' },
      { t: 'math', v: 'a_1' },
    ])
  })
})

describe('链接与图片的标题', () => {
  it('[文字](地址 "标题") 只留地址', () => {
    expect(tokenize('[官网](https://a.com "标题")')).toEqual([
      { t: 'link', v: '官网', href: 'https://a.com' },
    ])
  })

  it('![图](a.png "标题") 只留路径', () => {
    expect(tokenize('![图](a.png "标题")')).toEqual([{ t: 'image', alt: '图', src: 'a.png' }])
  })
})

describe('表格对齐', () => {
  it('分隔行解出每列的对齐', () => {
    const t = parseMarkdown('| 甲 | 乙 | 丙 |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |')[0]
    if (t?.t !== 'table') throw new Error('不是表格')
    expect(t.align).toEqual(['left', 'center', 'right'])
  })

  it('没写对齐就是 null', () => {
    const t = parseMarkdown('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |')[0]
    if (t?.t !== 'table') throw new Error('不是表格')
    expect(t.align).toEqual([null, null])
  })

  it('转义的竖线不破坏单元格', () => {
    const t = parseMarkdown(String.raw`| a \| b | c |` + '\n| --- | --- |\n| 1 | 2 |')[0]
    if (t?.t !== 'table') throw new Error('不是表格')
    expect(t.head.map((c) => plainText(c))).toEqual(['a | b', 'c'])
  })

  it('短行补齐到列数', () => {
    const t = parseMarkdown('| 甲 | 乙 |\n| --- | --- |\n| 1 |')[0]
    if (t?.t !== 'table') throw new Error('不是表格')
    expect(t.rows[0]?.map((c) => plainText(c))).toEqual(['1', ''])
  })
})

describe('表格对齐往返', () => {
  it('buildTable 写出去、tableAt 读回来，对齐不丢', () => {
    const cells = [
      ['甲', '乙', '丙'],
      ['1', '2', '3'],
    ]
    const align = ['left', 'center', 'right'] as const
    const text = buildTable(cells, [...align])
    expect(text.split('\n')[1]).toBe('| :--- | :---: | ---: |')
    const back = tableAt(text.split('\n'), 1)
    expect(back?.align).toEqual([...align])
    expect(back?.cells).toEqual(cells)
  })

  it('默认（不给对齐）还是老三行', () => {
    expect(buildTable([['a']]).split('\n')[1]).toBe('| --- |')
  })
})

describe('硬换行', () => {
  it('行尾两个空格 = 换行', () => {
    const blocks = parseMarkdown('甲  \n乙')
    if (blocks[0]?.t !== 'para') throw new Error('不是段落')
    expect(blocks[0].inlines).toEqual([{ t: 'text', v: '甲' }, { t: 'br' }, { t: 'text', v: '乙' }])
  })

  it('行尾一个反斜杠 = 换行', () => {
    const blocks = parseMarkdown('甲\\\n乙')
    if (blocks[0]?.t !== 'para') throw new Error('不是段落')
    expect(blocks[0].inlines.some((i) => i.t === 'br')).toBe(true)
  })

  it('普通换行还是并成一段（原有行为不动）', () => {
    const blocks = parseMarkdown('甲\n乙')
    if (blocks[0]?.t !== 'para') throw new Error('不是段落')
    expect(blocks[0].inlines).toEqual([{ t: 'text', v: '甲' }, { t: 'text', v: ' ' }, { t: 'text', v: '乙' }])
  })
})

describe('代码围栏', () => {
  it('~~~ 也认，收尾记号要和开头一样', () => {
    const blocks = parseMarkdown('~~~ts\nconst a = 1\n~~~')
    expect(blocks[0]).toMatchObject({ t: 'code', lang: 'ts', text: 'const a = 1' })
  })

  it('``` 里出现 ~~~ 不当结尾', () => {
    const blocks = parseMarkdown('```\n~~~\n```')
    expect(blocks[0]).toMatchObject({ t: 'code', text: '~~~' })
  })
})

describe('大纲不受新语法影响', () => {
  it('标题照取，任务/分割线不进大纲', () => {
    expect(plainText([])).toBe('')
    const out = parseMarkdown('# 甲\n\n- [x] 乙\n\n---\n\n## 丙')
    expect(out.map((b) => b.t)).toEqual(['heading', 'li', 'hr', 'heading'])
  })
})

describe('块公式的行号必须落在文档内（回归：打第二个 $ 会抛 RangeError）', () => {
  it('没收尾的 $$ 也不能给出界行号', () => {
    const blocks = parseMarkdown('前文\n$$')
    const mb = blocks.find((b) => b.t === 'mathblock')
    expect(mb).toBeTruthy()
    if (mb) {
      expect(mb.from).toBe(2)
      expect(mb.to).toBeLessThanOrEqual(2)
    }
  })

  it('刚打出 $$ 加空行（还没写公式）也一样', () => {
    const blocks = parseMarkdown('线\n$$\n')
    for (const b of blocks) expect(b.to).toBeLessThanOrEqual(3)
  })

  it('正常收尾的行号不变', () => {
    const blocks = parseMarkdown('前文\n$$\nE=mc^2\n$$\n后文')
    const mb = blocks.find((b) => b.t === 'mathblock')
    expect(mb?.from).toBe(2)
    expect(mb?.to).toBe(4)
  })
})

describe('$$…$$ 夹在句子里也不能露出美元符号（回归：截图里的 $…$ 就是这条）', () => {
  it('整行只有 $$…$$ 是块公式', () => {
    const b = parseMarkdown('$$E = mc^2$$')[0]
    expect(b?.t).toBe('mathblock')
  })

  it('句子中间的 $$…$$ 是"展示型行内公式"，不是「$ + 公式 + $」', () => {
    const blocks = parseMarkdown('公式：$$E = mc^2$$ 就这样')
    const para = blocks[0]
    if (para?.t !== 'para') throw new Error('不是段落')
    const texts = para.inlines.filter((i) => i.t === 'text').map((i) => i.v).join('')
    expect(texts).not.toContain('$')
    const math = para.inlines.find((i) => i.t === 'math')
    expect(math).toBeTruthy()
    if (math?.t === 'math') {
      expect(math.v).toBe('E = mc^2')
      expect(math.display).toBe(true)
    }
  })

  it('$$…$$ 后面跟文字也一样', () => {
    const para = parseMarkdown('$$E=mc^2$$ 后文')[0]
    if (para?.t !== 'para') throw new Error('不是段落')
    expect(para.inlines.filter((i) => i.t === 'text').map((i) => i.v).join('')).not.toContain('$')
  })

  it('单个 $…$ 不受影响，仍是普通行内公式', () => {
    const para = parseMarkdown('行内 $x^2$ 结束')[0]
    if (para?.t !== 'para') throw new Error('不是段落')
    const math = para.inlines.find((i) => i.t === 'math')
    if (math?.t === 'math') expect(math.display).toBeUndefined()
  })

  it('$$…$$ 中间有换行就不当块（行内公式本来不跨行）', () => {
    const para = parseMarkdown('前 $$a\nb$$ 后')[0]
    if (para?.t !== 'para') throw new Error('不是段落')
    expect(para.inlines.some((i) => i.t === 'math')).toBe(false)
  })

  it('空公式 $$  $$ 不崩，也不吞掉后面的字', () => {
    const blocks = parseMarkdown('$$\n\n$$\n后文')
    expect(blocks.some((b) => b.t === 'mathblock')).toBe(true)
    expect(blocks.some((b) => b.t === 'para')).toBe(true)
  })
})

describe('没闭合的块公式标记为 closed:false（编辑器据此不渲染 widget）', () => {
  it('有收尾 → closed true', () => {
    const b = parseMarkdown('$$\nE=mc^2\n$$')[0]
    if (b?.t !== 'mathblock') throw new Error('不是块公式')
    expect(b.closed).toBe(true)
  })

  it('没写收尾 → closed false，且一路吃到末尾', () => {
    const blocks = parseMarkdown('$$\nE=mc^2\n后面还有字')
    const b = blocks[0]
    if (b?.t !== 'mathblock') throw new Error('不是块公式')
    expect(b.closed).toBe(false)
    expect(b.to).toBe(3)
  })

  it('只打了 $$ 和空行也算没闭合', () => {
    const b = parseMarkdown('$$\n')[0]
    if (b?.t !== 'mathblock') throw new Error('不是块公式')
    expect(b.closed).toBe(false)
  })
})

describe('没闭合的块公式标记为 closed:false（编辑器据此不渲染 widget）', () => {
  it('有收尾 → closed true', () => {
    const b = parseMarkdown('$$\nE=mc^2\n$$')[0]
    if (b?.t !== 'mathblock') throw new Error('不是块公式')
    expect(b.closed).toBe(true)
  })

  it('没写收尾 → closed false，且一路吃到末尾', () => {
    const blocks = parseMarkdown('$$\nE=mc^2\n后面还有字')
    const b = blocks[0]
    if (b?.t !== 'mathblock') throw new Error('不是块公式')
    expect(b.closed).toBe(false)
    expect(b.to).toBe(3)
  })

  it('只打了 $$ 和空行也算没闭合', () => {
    const b = parseMarkdown('$$\n')[0]
    if (b?.t !== 'mathblock') throw new Error('不是块公式')
    expect(b.closed).toBe(false)
  })
})
