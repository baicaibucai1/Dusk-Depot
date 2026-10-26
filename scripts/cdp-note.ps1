# .note 块编辑器验收：三种块 / 并排 / 回车换行 / 输入法 / 打字延迟 / 拖动+动画 / 增量保存
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddacc-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1200,900', 'http://localhost:5183/?vault=memory'
)
for ($i = 0; $i -lt 40; $i++) {
  try {
    $list = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2
    $page = $list | Where-Object { $_.type -eq 'page' -and $_.url -like '*localhost:5183*' } | Select-Object -First 1
    if ($page) { break }
  } catch { }
  Start-Sleep -Milliseconds 400
}
if (-not $page) { throw 'CDP 目标没出现' }
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
    $out = Join-Path (Get-Location) "assets\shots\$name"
    [IO.File]::WriteAllBytes($out, [Convert]::FromBase64String($r.result.data))
    "截图：$out"
  }
}
function Key([string]$type, [int]$vk, [string]$key, [int]$mods = 0) {
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = $type; windowsVirtualKeyCode = $vk; nativeVirtualKeyCode = $vk; key = $key; modifiers = $mods })
}
$fails = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "  ✓ $name" } else { "  ✗ $name  $detail"; $script:fails += $name }
}

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Eval "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if(!b) return 'no'; b.click(); return 'ok' })('示例-块笔记.note')")
Start-Sleep -Milliseconds 2500

"① 三种块"
$types = [string](Eval "[...document.querySelectorAll('.dd-note-card')].map((c) => c.dataset.type).join(',')")
Check '块类型：标题 / 正文 / 图片' ($types -like 'heading,paragraph,paragraph,paragraph,image*') "types=$types"
$h = [string](Eval "(() => { const c = document.querySelector('.dd-note-card[data-type=heading]'); if (!c) return 'none'; const s = getComputedStyle(c); return s.borderTopWidth + '|' + getComputedStyle(c.querySelector('.dd-note-content')).fontWeight })()")
Check '标题块没有边框 + 粗体' ($h -eq '0px|700') "style=$h"
$img = [int](Eval "document.querySelectorAll('.dd-note-image img').length")
Check '图片块显示了图库里的图片' ($img -ge 1) "img=$img"

"①b 卡片默认没有边框，选中才有淡边"
$plain = [string](Eval "(() => { const c = document.querySelectorAll('.dd-note-card')[1]; const s = getComputedStyle(c); return s.borderTopWidth + '|' + (c.hasAttribute('data-selected') ? '选中' : '未选') })()")
Check '未选中时卡片无边框' ($plain -eq '0px|未选') "border=$plain"
$pt = [string](Eval "(() => { const c = document.querySelectorAll('.dd-note-card')[1]; const r = c.getBoundingClientRect(); return Math.round(r.left + 30) + ',' + Math.round(r.top + r.height / 2) })()")
$pp = $pt.Split(',')
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = [int]$pp[0]; y = [int]$pp[1]; button = 'left'; clickCount = 1 })
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = [int]$pp[0]; y = [int]$pp[1]; button = 'left'; clickCount = 1 })
Start-Sleep -Milliseconds 500
$focused = [string](Eval "(() => { const c = document.querySelectorAll('.dd-note-card')[1]; return (c.hasAttribute('data-selected') ? '选中' : '未选') + '|' + (getComputedStyle(c).boxShadow !== 'none' ? '有淡边' : '无边') })()")
Check '选中后出现淡边框' ($focused -eq '选中|有淡边') "border=$focused"

"①c 自由排版：每块都有自己的位置（x / y / w）"
$align = [string](Eval "(() => { const raw = localStorage.getItem('dusk.memory.repo.v2'); const f = JSON.parse(raw).files; const keys = Object.keys(f).filter((k) => k.indexOf('示例-块笔记.note/blocks/') === 0); const blocks = keys.map((k) => JSON.parse(f[k])).filter((b) => b.type !== 'columns' && b.layout); const xs = new Set(blocks.map((b) => b.layout.x)); const ws = new Set(blocks.map((b) => b.layout.w)); return 'n=' + blocks.length + ' 不同x=' + xs.size + ' 不同w=' + ws.size })()")
"  $align"
Check '每块都有自己的 x/y/w（不是一刀切）' ($align -like 'n=*' -and $align -match '不同w=([2-9]|\d\d)') "align=$align"

"② 正文块内 md 已渲染"
$md = [string](Eval "(() => { const c = document.querySelectorAll('.dd-note-card')[1]; return 'strong=' + c.querySelectorAll('strong').length + ' code=' + c.querySelectorAll('code').length + ' a=' + c.querySelectorAll('a').length })()")
Check '正文块里 strong / code / a 都在' ($md -eq 'strong=1 code=1 a=1') "md=$md"

"③ 左右并排"
$geo = [string](Eval "(() => { const c = [...document.querySelectorAll('.dd-note-card')].filter((x) => x.dataset.type === 'paragraph'); const a = c[1].getBoundingClientRect(); const b = c[2].getBoundingClientRect(); return Math.round(a.top) + ',' + Math.round(b.top) + ',' + Math.round(a.right) + ',' + Math.round(b.left) })()")
$g = $geo.Split(',')
"  第三条 top=$($g[0]) 第四条 top=$($g[1]) right=$($g[2]) left=$($g[3])"
Check '两个半宽块并排（同一行、左右挨着）' ([Math]::Abs([int]$g[0] - [int]$g[1]) -le 2 -and [int]$g[2] -le [int]$g[3]) "geo=$geo"
Shot 'note-final.png'

"④ 打字 + 回车换行（真实鼠标键盘）"
$box = [string](Eval "(() => { const el = document.querySelectorAll('.dd-note-card')[1].querySelector('.dd-note-content'); const r = el.getBoundingClientRect(); return Math.round(r.right - 20) + ',' + Math.round(r.top + r.height / 2) })()")
$b = $box.Split(',')
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = [int]$b[0]; y = [int]$b[1]; button = 'left'; clickCount = 1 })
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = [int]$b[0]; y = [int]$b[1]; button = 'left'; clickCount = 1 })
Start-Sleep -Milliseconds 300
Key 'rawKeyDown' 35 'End'
Key 'keyUp' 35 'End'
$cntBefore = [int](Eval "document.querySelectorAll('.dd-note-card').length")
$t0 = [DateTime]::Now
for ($i = 0; $i -lt 20; $i++) { [void](Send-Cdp 'Input.insertText' @{ text = "字$i" }) }
$typeMs = [Math]::Round(([DateTime]::Now - $t0).TotalMilliseconds)
Key 'rawKeyDown' 13 'Enter'
Key 'keyUp' 13 'Enter'
[void](Send-Cdp 'Input.insertText' @{ text = '第二行' })
Start-Sleep -Milliseconds 1200
"  20 字耗时：${typeMs}ms"
$dom = [string](Eval "document.querySelectorAll('.dd-note-card')[1].querySelector('.dd-note-content').innerHTML")
$cnt = [int](Eval "document.querySelectorAll('.dd-note-card').length")
Check '回车没有新建块（块数不变）' ($cnt -eq $cntBefore) "before=$cntBefore after=$cnt"
Check '块内出现换行且文字都在' ($dom -match '<br>' -and $dom -match '第二行' -and $dom -match '字19') "dom-len=$($dom.Length)"
Check "打字不卡（20 字 < 1500ms）" ($typeMs -lt 1500) "$typeMs ms"
$saved = [string](Eval "(() => { const raw = localStorage.getItem('dusk.memory.repo.v2'); const f = JSON.parse(raw).files; const id = document.querySelectorAll('.dd-note-card')[1].dataset.blockId; const b = JSON.parse(f['示例-块笔记.note/blocks/' + id + '.json'] || '{}'); return String(b.text || '') })()")
"  存盘 text：" + $saved.Substring(0, [Math]::Min(120, $saved.Length)).Replace("`n", "⏎")
Check '换行写进了块文件（text 里有换行）' ($saved.Contains("`n") -and $saved.Contains('第二行')) "saved-len=$($saved.Length)"

"⑤ 输入法合成"
[void](Send-Cdp 'Input.imeSetComposition' @{ text = 'nihao'; selectionStart = 5; selectionEnd = 5 })
Start-Sleep -Milliseconds 150
[void](Send-Cdp 'Input.insertText' @{ text = '你好' })
Start-Sleep -Milliseconds 500
$has = [string](Eval "document.querySelectorAll('.dd-note-card')[1].querySelector('.dd-note-content').textContent.includes('你好')")
Check '输入法合成后文字正常落地' ($has -eq 'True') "has=$has"

"⑥ 拖动排序 + 让位动画"
$before = [string](Eval "(() => { const raw = localStorage.getItem('dusk.memory.repo.v2'); const f = JSON.parse(raw).files; return (f['示例-块笔记.note/order.json'] || '').replace(/\s+/g, '') })()")
$drag = [string](Eval @'
(() => {
  const cards = [...document.querySelectorAll('.dd-note-card')]
  const handle = cards[1].querySelector('[aria-label="拖动这一块"]')
  const dt = new DataTransfer()
  handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
  const target = cards[0]
  const r = target.getBoundingClientRect()
  const y = r.top + 4
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }))
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }))
  handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
  return 'ok'
})()
'@)
Start-Sleep -Milliseconds 120
$anims = [int](Eval "[...document.querySelectorAll('.dd-note-card')].reduce((n, c) => n + c.getAnimations().length, 0)")
Start-Sleep -Milliseconds 1000
$after = [string](Eval "(() => { const raw = localStorage.getItem('dusk.memory.repo.v2'); const f = JSON.parse(raw).files; return (f['示例-块笔记.note/order.json'] || '').replace(/\s+/g, '') })()")
"  拖动前：$before"
"  拖动后：$after"
"  正在播放的让位动画：$anims 个"
Check '拖动改变了块顺序' ($drag -eq 'ok' -and $before -ne $after) "before=$before after=$after"
Check '重排后有 FLIP 让位动画' ($anims -ge 1) "anims=$anims"

"⑥b 拖到右侧 → 两块并排（自由排版：各摆到左右半边）"
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
Check '拖到侧边后两块都写入了 layout' ($split -match 'wA=\d+' -and $split -match 'wB=\d+') "split=$split"
Shot 'note-split.png'

"⑥c 每块都有自由位置（x / y / w）"
$allHaveLayout = [string](Eval "(() => { const raw = localStorage.getItem('dusk.memory.repo.v2'); const f = JSON.parse(raw).files; const keys = Object.keys(f).filter((k) => k.indexOf('示例-块笔记.note/blocks/') === 0); const blocks = keys.map((k) => JSON.parse(f[k])).filter((b) => b.type !== 'columns'); const ok = blocks.every((b) => b.layout && typeof b.layout.x === 'number' && typeof b.layout.y === 'number' && typeof b.layout.w === 'number'); return ok + ' n=' + blocks.length })()")
"  $allHaveLayout"
Check '每个块都存了 layout(x/y/w)' ($allHaveLayout -like 'true*') "check=$allHaveLayout"


""
if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
