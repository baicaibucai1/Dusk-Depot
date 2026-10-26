# 复现"选不中"：真实鼠标点按+拖动，同时抓 window 错误。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddprobe-' + [guid]::NewGuid().ToString('N'))
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
    $buf = [byte[]]::new(524288)
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
  if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.text }
  return $r.result.result.value
}
function Drag([int]$x1, [int]$y1, [int]$x2, [int]$y2) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x1; y = $y1; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = [int](($x1 + $x2) / 2); y = $y1; button = 'left' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x2; y = $y2; button = 'left' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x2; y = $y2; button = 'left'; clickCount = 1 })
}

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Page.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

$PROBE = @'
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || String(e.error))));
window.addEventListener('unhandledrejection', (e) => window.__errs.push('reject: ' + String(e.reason)));
const _ce = console.error;
console.error = (...a) => { window.__errs.push('console: ' + a.map((x) => String(x && x.stack ? x.stack : x)).join(' ')); _ce(...a); };
'@
[void](Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = $PROBE })
[void](Send-Cdp 'Page.navigate' @{ url = 'http://localhost:5183/?vault=memory' })
Start-Sleep -Milliseconds 3500

# 打开第一篇
[void](Eval "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if (!b) return 'no'; b.click(); return 'ok' })('示例-链接.md')")
Start-Sleep -Milliseconds 1200

"--- 初始错误 ---"
Eval '(() => (window.__errs || []).slice(0, 3).join(" | "))()'

# 找第一段文字的坐标
$RECT = '(() => { const l = [...document.querySelectorAll(".cm-line")].find((x) => (x.textContent || "").length > 8); if (!l) return "none"; const r = l.getBoundingClientRect(); return [Math.round(r.x + 20), Math.round(r.y + r.height / 2)].join(",") })()'
$pt = [string](Eval $RECT)
"段落坐标：$pt"

if ($pt -ne 'none') {
  $xy = $pt.Split(',')
  $x = [int]$xy[0]; $y = [int]$xy[1]

  "--- 单击 ---"
  Drag $x $y $x $y
  Start-Sleep -Milliseconds 300
  "selection=" + [string](Eval '(() => { const s = window.__dd_view.state.selection.main; return s.from + "~" + s.to })()')
  "聚焦=" + [string](Eval 'String(window.__dd_view.hasFocus)')

  "--- 拖选 ---"
  Drag $x $y ($x + 160) $y
  Start-Sleep -Milliseconds 400
  "selection=" + [string](Eval '(() => { const s = window.__dd_view.state.selection.main; return s.from + "~" + s.to + " len=" + (s.to - s.from) })()')
  "浏览器原生选中=" + [string](Eval 'String(window.getSelection ? window.getSelection().toString().length : -1)')

  "--- 双击选词 ---"
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 2 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = 2 })
  Start-Sleep -Milliseconds 400
  "selection=" + [string](Eval '(() => { const s = window.__dd_view.state.selection.main; return (s.to - s.from) })()')
}

"--- 插入一个内嵌样式，再试选中 ---"
[void](Eval '(() => { const v = window.__dd_view; v.dispatch({ changes: { from: 0, to: 0, insert: "<span style=\"color:#c0392b\">红字测试</span> 后面这段普通文字" } }); return "ok" })()')
Start-Sleep -Milliseconds 700

$pl = [string](Eval '(() => { const v = window.__dd_view; const i = v.state.doc.toString().indexOf("红字测试"); const c = v.coordsAtPos(i + 2); return c ? [Math.round(c.left), Math.round((c.top + c.bottom) / 2)].join(",") : "none" })()')
"样式文字坐标：$pl"

if ($pl -ne 'none') {
  $p2 = $pl.Split(',')
  $x2 = [int]$p2[0]; $y2 = [int]$p2[1]

  Drag $x2 $y2 $x2 $y2
  Start-Sleep -Milliseconds 300
  "点进样式里 selection=" + [string](Eval '(() => { const s = window.__dd_view.state.selection.main; return s.from + "~" + s.to })()')
  "面板出现=" + [string](Eval 'String(document.querySelectorAll("[data-inspector]").length)')

  "从样式里往外拖："
  Drag $x2 $y2 ($x2 + 180) $y2
  Start-Sleep -Milliseconds 400
  "selection len=" + [string](Eval '(() => { const s = window.__dd_view.state.selection.main; return (s.to - s.from) })()')

  "从普通文字往回拖（跨过样式）："
  Drag ($x2 + 150) $y2 $x2 $y2
  Start-Sleep -Milliseconds 400
  "selection len=" + [string](Eval '(() => { const s = window.__dd_view.state.selection.main; return (s.to - s.from) })()')
}

"--- 累计错误 ---"
Eval '(() => (window.__errs || []).slice(0, 8).join("\n"))()'
Eval '(() => (window.__errs || []).slice(0, 6).join("\n"))()'

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
