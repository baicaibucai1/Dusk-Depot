# 验白板模型：span 栅格 / 一行自动铺满 / 拖侧边自动分栏 / 拖把手改 span
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddwb-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1500,950', 'http://localhost:5183/?vault=memory'
)
for ($i = 0; $i -lt 40; $i++) {
  try {
    $list = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2
    $page = $list | Where-Object { $_.type -eq 'page' -and $_.url -like '*localhost:5183*' } | Select-Object -First 1
    if ($page) { break }
  } catch { }
  Start-Sleep -Milliseconds 400
}
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
$id = 0
function Send-Cdp([string]$method, [hashtable]$params) {
  $script:id++
  $myId = $script:id
  $msg = @{ id = $myId; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, [Threading.CancellationToken]::None).Wait()
  while ($true) {
    $buf = [byte[]]::new(1048576)
    $sb = [Text.StringBuilder]::new()
    do {
      $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None).Result
      [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $res.Count))
    } while (-not $res.EndOfMessage)
    $obj = $sb.ToString() | ConvertFrom-Json
    if ($obj.id -eq $myId) { return $obj }
  }
}
function Eval([string]$expr) {
  $r = Send-Cdp 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true; awaitPromise = $true }
  if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.exception.description }
  return $r.result.result.value
}
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png' }
  if ($r.result.data) {
    [IO.File]::WriteAllBytes((Join-Path (Get-Location) "assets\shots\$name"), [Convert]::FromBase64String($r.result.data))
    "截图：assets\shots\$name"
  }
}
$fails = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "  ✓ $name" } else { "  ✗ $name  $detail"; $script:fails += $name }
}
function Store([string]$dir) {
  Eval "(() => { const raw = localStorage.getItem('dusk.memory.repo.v2'); const f = JSON.parse(raw).files; const o = {}; Object.keys(f).filter((k) => k.indexOf('$dir/blocks/') === 0).forEach((k) => { o[k.split('/').pop()] = JSON.parse(f[k]) }); return JSON.stringify(o) })()"
}

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Eval "(() => { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(e.message)); return 1 })()")
[void](Eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '示例-块笔记.note'); if (b) b.click(); return 'ok' })()")
Start-Sleep -Milliseconds 2600

"① span 栅格：每块都带 data-span"
$spans = [string](Eval "[...document.querySelectorAll('.dd-note-card')].map((c) => c.dataset.span).join(',')")
"  spans：$spans"
Check '每块都有 span 属性' ($spans -match '^[\d,]+$') "spans=$spans"

"② 一行没占满 → 自动铺满（宽度由这一行决定，不写死）"
$geo = [string](Eval @'
(() => {
  const cards = [...document.querySelectorAll('.dd-note-card')]
  const box = document.querySelector('.dd-note-canvas').getBoundingClientRect()
  const rows = new Map()
  cards.forEach((c) => {
    const r = c.getBoundingClientRect()
    const key = Math.round(r.top)
    if (!rows.has(key)) rows.set(key, [])
    rows.get(key).push({ w: Math.round(r.width), l: Math.round(r.left), span: c.dataset.span })
  })
  return [...rows.entries()].map(([top, items]) => {
    const sum = items.reduce((s, i) => s + i.w + 24, -24)
    return top + ':' + items.map((i) => i.span + '=' + i.w).join('/') + ' 合计=' + sum
  }).join(' | ') + ' 画布=' + Math.round(box.width)
})()
'@)
"  $geo"
Shot 'whiteboard.png'

"③ 拖到左侧 → 两块自动各占一半"
[void](Send-Cdp 'Page.reload' @{})
Start-Sleep -Milliseconds 3500
[void](Eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '示例-块笔记.note'); if (b) b.click(); return 'ok' })()")
Start-Sleep -Milliseconds 2600
[void](Eval '(() => { const c = document.querySelector(".dd-note-canvas"); if (c) c.scrollIntoView({ block: "start" }); window.scrollTo(0, 0); return 1 })()')
Start-Sleep -Milliseconds 500
$before = [string](Store '示例-块笔记.note')
$dragJs = @'
(() => {
  const cards = [...document.querySelectorAll('.dd-note-card')]
  const src = cards[0]
  const tgt = cards[1]
  const handle = src.querySelector('[aria-label="拖动这一块"]')
  if (!handle) return 'no-handle'
  const dt = new DataTransfer()
  handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
  const r = tgt.getBoundingClientRect()
  // 落在目标块的中间偏左 → 左半边 → 并排
  const x = r.left + r.width * 0.3
  const y = r.top + r.height / 2
  tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
  tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
  handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
  return 'ok'
})()
'@
$drag = [string](Eval $dragJs)
Start-Sleep -Milliseconds 1400
$after = [string](Store '示例-块笔记.note')
$split = [string](Eval @'
(() => {
  const cards = [...document.querySelectorAll('.dd-note-card')]
  const a = cards[0].getBoundingClientRect()
  const b = cards[1].getBoundingClientRect()
  return 'spanA=' + cards[0].dataset.span + ' spanB=' + cards[1].dataset.span + ' sameRow=' + (Math.abs(a.top - b.top) <= 2) + ' sideBySide=' + (a.right <= b.left)
})()
'@)
"  side=" + [string](Eval "document.body.dataset.dragSide || 'none'") + " || mv1=" + [string](Eval "document.body.dataset.mv1 || 'none'") + " || mv2=" + [string](Eval "document.body.dataset.mv2 || 'none'")
Check '拖到侧边后两块 span=6 并排' ($drag -eq 'ok' -and $split -like '*spanA=6 spanB=6 sameRow=true sideBySide=true*') "split=$split"
Shot 'whiteboard-split.png'

"④ 删掉邻居 → 剩下的自动铺满整行"
# 删掉最后一个 span=6 的块：它后面那块是整行（span=12），所以前一个 6 会独占一行
[void](Eval @'
(() => {
  const sixes = [...document.querySelectorAll('.dd-note-card')].filter((c) => c.dataset.span === '6')
  if (sixes.length < 2) return 'no-pair'
  const last = sixes[sixes.length - 1]
  const b = last.querySelector('[aria-label="删除这一块"]')
  if (b) b.click()
  return 'ok'
})()
'@)
Start-Sleep -Milliseconds 1200
$solo = [string](Eval "(() => { const cards = [...document.querySelectorAll('.dd-note-card')]; const box = document.querySelector('.dd-note-canvas').getBoundingClientRect(); const sixes = cards.filter((x) => x.dataset.span === '6'); const c = sixes[sixes.length - 1] || cards[0]; return 'span=' + c.dataset.span + ' 宽=' + Math.round(c.getBoundingClientRect().width) + ' 画布=' + Math.round(box.width) + ' 块数=' + cards.length })()")
"  $solo"
$sw = [int](($solo -split ' ')[1] -replace '[^\d]', '')
$cw = [int](($solo -split ' ')[2] -replace '[^\d]', '')
Check '删掉邻居后：span 不变、显示铺满整行' ($solo -like '*span=6*' -and [Math]::Abs($sw - $cw) -le 30) "solo=$solo"
"⑤ 拖右边缘 → 改 span"
$geo2 = [string](Eval @'
(() => {
  const c = [...document.querySelectorAll('.dd-note-card')][0]
  const h = c.querySelector('.dd-note-resize').getBoundingClientRect()
  return Math.round(h.left + h.width / 2) + ',' + Math.round(h.top + h.height / 2)
})()
'@)
$g2 = $geo2.Split(',')
$spanBefore = [string](Eval "[...document.querySelectorAll('.dd-note-card')][0].dataset.span")
$resizeJs = @"
(() => {
  const c = [...document.querySelectorAll('.dd-note-card')][0]
  const h = c.querySelector('.dd-note-resize')
  const r = h.getBoundingClientRect()
  const x = r.left + r.width / 2, y = r.top + r.height / 2
  const opts = (cx) => ({ bubbles: true, cancelable: true, clientX: cx, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'mouse', buttons: 1 })
  h.dispatchEvent(new PointerEvent('pointerdown', opts(x)))
  window.dispatchEvent(new PointerEvent('pointermove', opts(x - 300)))
  window.dispatchEvent(new PointerEvent('pointerup', opts(x - 300)))
  return 'ok'
})()
"@
[void](Eval $resizeJs)
Start-Sleep -Milliseconds 900
$spanAfter = [string](Eval "[...document.querySelectorAll('.dd-note-card')][0].dataset.span")
"  span：$spanBefore → $spanAfter"
Check '拖右边缘把 span 拖小了' ([int]$spanAfter -lt [int]$spanBefore) "before=$spanBefore after=$spanAfter"

"  错误：" + [string](Eval "JSON.stringify((window.__errs || []).slice(0, 5))")
""
if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
