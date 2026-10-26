# 验分栏：新建一篇块笔记 → 加"分栏" → 加一列 → 列里加块 → 拖列宽 → 存盘
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddcols-' + [guid]::NewGuid().ToString('N'))
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

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Eval "(() => { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(e.message)); return 1 })()")

"① 新建一篇块笔记，加一个分栏块"
$newNote = [string](Eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === '新建块笔记'); if (!b) return 'no'; b.click(); return 'ok' })()")
Start-Sleep -Milliseconds 2500
$dir = [string](Eval '(() => { const m = document.querySelector("main"); return m ? m.dataset.activePath : "none" })()')
"  新笔记：$dir"
$addBtn = [string](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim().indexOf("分栏") >= 0); if (!b) return "no"; b.click(); return "ok" })()')
Start-Sleep -Milliseconds 1200
$cols = [int](Eval 'document.querySelectorAll(".dd-note-column").length')
Check '点「分栏」插入了多列块' ($newNote -eq 'ok' -and $addBtn -eq 'ok' -and $cols -eq 2) "new=$newNote add=$addBtn cols=$cols"

"② 加第三列"
[void](Eval '(() => { const b = document.querySelector("[aria-label=''加一列'']"); if (!b) return "no"; b.click(); return "ok" })()')
Start-Sleep -Milliseconds 900
$cols3 = [int](Eval 'document.querySelectorAll(".dd-note-column").length')
Check '「加一列」变成三列' ($cols3 -eq 3) "cols=$cols3"

"③ 往第一列里再加一块（左栏两块叠着）"
[void](Eval '(() => { const cols = [...document.querySelectorAll(".dd-note-column")]; const b = cols[0] && cols[0].querySelector(".dd-note-col-add"); if (!b) return "no"; b.click(); return "ok" })()')
Start-Sleep -Milliseconds 900
$leftBlocks = [int](Eval '(() => { const c = document.querySelectorAll(".dd-note-column")[0]; return c ? c.querySelectorAll(".dd-note-card").length : 0 })()')
Check '第一列里堆了两块' ($leftBlocks -eq 2) "left=$leftBlocks"
Shot 'columns-3.png'

"④ 拖列宽"
$geo = [string](Eval '(() => { const c = document.querySelectorAll(".dd-note-column")[0]; const h = c.querySelector(".dd-note-col-resize").getBoundingClientRect(); const p = c.getBoundingClientRect(); return Math.round(p.width) + "," + Math.round(h.left + h.width / 2) + "," + Math.round(h.top + 80) })()')
"  第一列宽/把手：$geo"
$g = $geo.Split(',')
$dragJs = @"
(() => {
  const c = document.querySelectorAll('.dd-note-column')[0]
  const h = c.querySelector('.dd-note-col-resize')
  const r = h.getBoundingClientRect()
  const x = r.left + r.width / 2, y = r.top + 80
  const opts = (cx) => ({ bubbles: true, cancelable: true, clientX: cx, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'mouse', buttons: 1 })
  h.dispatchEvent(new PointerEvent('pointerdown', opts(x)))
  window.dispatchEvent(new PointerEvent('pointermove', opts(x - 120)))
  window.dispatchEvent(new PointerEvent('pointerup', opts(x - 120)))
  return 'ok'
})()
"@
[void](Eval $dragJs)
Start-Sleep -Milliseconds 900
$after = [string](Eval '(() => { const c = document.querySelectorAll(".dd-note-column")[0]; return Math.round(c.getBoundingClientRect().width) })()')
"  拖后第一列宽：$after（原来 $($g[0])）"
Check '拖动列边缘改变了列宽' ([int]$after -lt [int]$g[0] - 40) "before=$($g[0]) after=$after"

"⑤ 存盘：columns 块里带三列"
Start-Sleep -Milliseconds 900
$json = [string](Eval "(() => { const dir = document.querySelector('main').dataset.activePath; const raw = localStorage.getItem('dusk.memory.repo.v2'); const f = JSON.parse(raw).files; const keys = Object.keys(f).filter((k) => k.indexOf(dir + '/blocks/') === 0); for (const k of keys) { try { const b = JSON.parse(f[k]); if (b.type === 'columns') return 'cols=' + b.columns.length + ' widths=' + b.columns.map((c) => c.width).join('/') } catch {} } return 'no-columns' })()")
"  $json"
Check '分栏写进了块 JSON（三列 + 宽度）' ($json -like 'cols=3 widths=*') "json=$json"
Shot 'columns-final.png'

"  错误：" + [string](Eval 'JSON.stringify((window.__errs || []).slice(0, 5))')
""
if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
