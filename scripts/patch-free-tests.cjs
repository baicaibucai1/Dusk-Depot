const fs = require('fs')

// ── cdp-note.ps1：把 span 相关断言改成自由排版语义 ──
{
  const p = 'scripts/cdp-note.ps1'
  let t = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

  // ③ 拖到右侧：改成检查两块横向并排（left 不同、top 接近）
  const oldSplit = t.match(/⑥b[\s\S]*?Shot 'note-split\.png'/)
  if (oldSplit) {
    t = t.replace(
      oldSplit[0],
      `⑥b 拖到右侧 → 两块并排（自由排版：各摆到左右半边）
[void](Eval @'
(() => {
  const cards = [...document.querySelectorAll('.dd-note-card')]
  const src = cards[0]
  const tgt = cards[cards.length - 1]
  const handle = src.querySelector('[aria-label="拖动这一块"]')
  const dt = new DataTransfer()
  handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
  const r = tgt.getBoundingClientRect()
  const x = r.left + r.width * 0.25
  const y = r.top + r.height / 2
  tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
  tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
  handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
  return 'ok'
})()
'@)
Start-Sleep -Milliseconds 1400
$split = [string](Eval @'
(() => {
  const raw = localStorage.getItem('dusk.memory.repo.v2')
  const f = JSON.parse(raw).files
  const cards = [...document.querySelectorAll('.dd-note-card')]
  const lays = cards.map((c) => {
    const b = JSON.parse(f['示例-块笔记.note/blocks/' + c.dataset.blockId + '.json'] || '{}')
    return b.layout || null
  }).filter(Boolean)
  const half = lays.filter((l) => l.w > 40 && l.w < 60)
  if (half.length < 2) return 'halfCount=' + half.length
  const a = half[half.length - 2]
  const b2 = half[half.length - 1]
  return 'wA=' + Math.round(a.w) + ' wB=' + Math.round(b2.w) + ' 同一行=' + (Math.abs(a.y - b2.y) <= 4) + ' 左右=' + (a.x < b2.x)
})()
'@)
"  $split"
Check '拖到侧边后两块各占半幅、并排' ($split -like 'wA=49 wB=49 同一行=true 左右=true') "split=$split"
Shot 'note-split.png'`,
    )
  }

  // ⑥c solo：改成"没有 layout 的块会被补上位置"
  const soloMatch = t.match(/⑥c[\s\S]*?Shot 'note-auto-width\.png'|⑥c[\s\S]*?\n\n"⑦/)
  if (soloMatch) {
    t = t.replace(
      soloMatch[0],
      `⑥c 每块都有自由位置（x / y / w）
$allHaveLayout = [string](Eval "(() => { const raw = localStorage.getItem('dusk.memory.repo.v2'); const f = JSON.parse(raw).files; const keys = Object.keys(f).filter((k) => k.indexOf('示例-块笔记.note/blocks/') === 0); const blocks = keys.map((k) => JSON.parse(f[k])).filter((b) => b.type !== 'columns'); const ok = blocks.every((b) => b.layout && typeof b.layout.x === 'number' && typeof b.layout.y === 'number' && typeof b.layout.w === 'number'); return ok + ' n=' + blocks.length })()")
"  $allHaveLayout"
Check '每个块都存了 layout(x/y/w)' ($allHaveLayout -like 'true*') "check=$allHaveLayout"
`,
    )
  }

  fs.writeFileSync(p, t, 'utf8')
  console.log('cdp-note ok')
}

// ── cdp-note-aside.ps1：拖把手改 layout.w ──
{
  const p = 'scripts/cdp-note-aside.ps1'
  let t = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
  t = t.replace(
    `return Math.round(c.getBoundingClientRect().width) + "|" + JSON.stringify(b.width ?? null)`,
    `return Math.round(c.getBoundingClientRect().width) + "|" + JSON.stringify(b.layout ? b.layout.w : null)`,
  )
  const oldCheck = t.match(/Check '拖右边缘改变了 span[^\n]*\n/)
  if (oldCheck) {
    t = t.replace(
      oldCheck[0],
      `Check '拖右边缘把 layout.w 改小了' ($aw[1] -match '^[\\d.]+$' -and [double]$aw[1] -lt 50) "after=$after"\n`,
    )
  }
  fs.writeFileSync(p, t, 'utf8')
  console.log('cdp-note-aside ok')
}
