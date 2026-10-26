# 验分栏：md + 块笔记 各占一栏，两边都能用；拖分隔条改宽度。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddsplit2-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1400,900', 'http://localhost:5183/?vault=memory'
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
$CLICK = "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if (!b) return 'no'; b.click(); return 'ok' })"
$ARIA = "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === n); if (!b) return 'no'; b.click(); return 'ok' })"
$fails = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "  ✓ $name" } else { "  ✗ $name  $detail"; $script:fails += $name }
}

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Eval "(() => { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(e.message)); return 1 })()")

"① 打开块笔记，再向右分一栏"
[void](Eval "($CLICK)('示例-块笔记.note')")
Start-Sleep -Milliseconds 2200
$split1 = [string](Eval "($ARIA)('向右拆分这一栏')")
Start-Sleep -Milliseconds 2200
$paths = [string](Eval "[...document.querySelectorAll('[data-active-path]')].map((p) => p.dataset.activePath || '?').join(' | ')")
$editors = [int](Eval "document.querySelectorAll('.dd-note-canvas').length")
"  栏：$paths   块编辑器：$editors"
Check '分成两栏' (($paths -split '\|').Count -eq 2) "paths=$paths"
Check '两栏都渲染出块编辑器' ($editors -eq 2) "editors=$editors"

"② 右栏切到 markdown，左栏仍是块笔记"
[void](Eval "($CLICK)('开始这里.md')")
Start-Sleep -Milliseconds 1600
$paths2 = [string](Eval "[...document.querySelectorAll('[data-active-path]')].map((p) => p.dataset.activePath || '?').join(' | ')")
$editors2 = [int](Eval "document.querySelectorAll('.dd-note-canvas').length")
$cm = [int](Eval "[...document.querySelectorAll('*.cm-editor')].filter((el) => el.offsetParent !== null).length")
"  栏：$paths2   块编辑器：$editors2   markdown 编辑器：$cm"
Check '一栏块笔记 + 一栏 markdown，各自都在' (($paths2 -like '*示例-块笔记.note*开始这里.md*' -or $paths2 -like '*开始这里.md*示例-块笔记.note*') -and $editors2 -eq 1 -and $cm -eq 1) "paths=$paths2 note=$editors2 md=$cm"
Shot 'split-ok.png'

"③ 拖分隔条"
$bars = [string](Eval '(() => [...document.querySelectorAll("div[role=separator]")].map((e) => Math.round(e.getBoundingClientRect().left)).join(","))()')
"  所有分隔条 x：$bars"
$bar = [string](Eval '(() => { const el = [...document.querySelectorAll("div[role=separator]")].find((e) => e.getBoundingClientRect().left > 400); if (!el) return "none"; const r = el.getBoundingClientRect(); return Math.round(r.left + r.width / 2) + "," + Math.round(r.top + 300) })()')
"  分隔条：$bar"
if ($bar -ne 'none') {
  $xy = $bar.Split(',')
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = [int]$xy[0]; y = [int]$xy[1]; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = ([int]$xy[0] - 120); y = [int]$xy[1]; button = 'left'; buttons = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = ([int]$xy[0] - 120); y = [int]$xy[1]; button = 'left'; clickCount = 1 })
  Start-Sleep -Milliseconds 500
  $widths = [string](Eval "[...document.querySelectorAll('[data-active-path]')].map((p) => Math.round(p.getBoundingClientRect().width)).join(',')")
  "  两栏宽度：$widths"
  Check '拖分隔条改变了栏宽（两栏不再等宽）' (($widths -split ',') -join ',' -ne ('413,413')) "widths=$widths"
}

"④ 切换焦点不能改变分栏宽度"
$w0 = [string](Eval "[...document.querySelectorAll('[data-active-path]')].map((p) => Math.round(p.getBoundingClientRect().width)).join(',')")
"  初始：$w0"
$pts = [string](Eval '(() => [...document.querySelectorAll("[data-active-path]")].map((p) => { const r = p.getBoundingClientRect(); return Math.round(r.left + 60) + "," + Math.round(r.top + 200) }).join(";"))()')
foreach ($pt in ($pts -split ';')) {
  $xy = $pt.Split(',')
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = [int]$xy[0]; y = [int]$xy[1]; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = [int]$xy[0]; y = [int]$xy[1]; button = 'left'; clickCount = 1 })
  Start-Sleep -Milliseconds 500
}
$w1 = [string](Eval "[...document.querySelectorAll('[data-active-path]')].map((p) => Math.round(p.getBoundingClientRect().width)).join(',')")
"  切换焦点后：$w1"
Check '左右切换焦点后三栏宽度不变' ($w0 -eq $w1) "before=$w0 after=$w1"
Shot 'split-stable.png'

"  错误：" + [string](Eval "JSON.stringify((window.__errs || []).slice(0, 5))")
""
if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
