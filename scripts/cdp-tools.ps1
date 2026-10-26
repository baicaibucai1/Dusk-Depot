# 验工具条：悬停出现 → 鼠标移到按钮上不消失 → 点击有效。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddhov2-' + [guid]::NewGuid().ToString('N'))
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
function MoveMouse([int]$x, [int]$y) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y })
}
$fails = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "  ✓ $name" } else { "  ✗ $name  $detail"; $script:fails += $name }
}

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Eval "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if(!b) return 'no'; b.click(); return 'ok' })('开始这里.md')")
Start-Sleep -Milliseconds 2000
# 打开块笔记
[void](Eval "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if(!b) return 'no'; b.click(); return 'ok' })('示例-块笔记.note')")
Start-Sleep -Milliseconds 2500

$cards = [int](Eval "document.querySelectorAll('.dd-note-card').length")
"块数：$cards"

$pt = [string](Eval "(() => { const c = document.querySelectorAll('.dd-note-card')[1]; const r = c.getBoundingClientRect(); return Math.round(r.left + 80) + ',' + Math.round(r.top + r.height / 2) })()")
$p = $pt.Split(',')
MoveMouse ([int]$p[0]) ([int]$p[1])
Start-Sleep -Milliseconds 500
$shown = [string](Eval "(() => { const c = document.querySelectorAll('.dd-note-card')[1]; return getComputedStyle(c.querySelector('.dd-note-tools')).opacity })()")
Check '悬停块上时工具条出现' ($shown -eq '1') "opacity=$shown"

# 把鼠标移到工具条按钮上
$tp = [string](Eval "(() => { const c = document.querySelectorAll('.dd-note-card')[1]; const btn = c.querySelector('.dd-note-tools .dd-note-btn'); const r = btn.getBoundingClientRect(); return Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2) })()")
$t = $tp.Split(',')
MoveMouse ([int]$t[0]) ([int]$t[1])
Start-Sleep -Milliseconds 400
$still = [string](Eval "(() => { const c = document.querySelectorAll('.dd-note-card')[1]; return getComputedStyle(c.querySelector('.dd-note-tools')).opacity })()")

Check '鼠标移到按钮上后不消失' ($still -eq '1') "opacity=$still"

# 点「＋」应该新增一块
$before = [int](Eval "document.querySelectorAll('.dd-note-card').length")
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = [int]$t[0]; y = [int]$t[1]; button = 'left'; clickCount = 1 })
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = [int]$t[0]; y = [int]$t[1]; button = 'left'; clickCount = 1 })
Start-Sleep -Milliseconds 800
$after = [int](Eval "document.querySelectorAll('.dd-note-card').length")
Check "悬停时能点中按钮（拖动块加了一块：$before → $after）" ($after -eq $before) "before=$before after=$after"

$r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png' }
if ($r.result.data) {
  [IO.File]::WriteAllBytes((Join-Path (Get-Location) 'assets\shots\note-tools.png'), [Convert]::FromBase64String($r.result.data))
  "截图：assets\shots\note-tools.png"
}

if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
