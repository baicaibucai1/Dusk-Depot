# 悬停到某一块上，截一张真实工具条位置图。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddhov-' + [guid]::NewGuid().ToString('N'))
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
Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Eval "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if(!b) return 'no'; b.click(); return 'ok' })('演示.note')")
Start-Sleep -Milliseconds 2500

$pt = [string](Eval "(() => { const c = document.querySelectorAll('.dd-note-card')[1]; const r = c.getBoundingClientRect(); return Math.round(r.left + 60) + ',' + Math.round(r.top + r.height / 2) })()")
$p = $pt.Split(',')
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = [int]$p[0]; y = [int]$p[1] })
Start-Sleep -Milliseconds 600
"工具条位置：" + [string](Eval "(() => { const cards = [...document.querySelectorAll('.dd-note-card')]; const c = cards[1]; const t = c.querySelector('.dd-note-tools').getBoundingClientRect(); const r = c.getBoundingClientRect(); let overlap = 'none'; cards.forEach((card) => { if (card === c) return; const b = card.getBoundingClientRect(); const ix = Math.max(0, Math.min(t.right, b.right) - Math.max(t.left, b.left)); const iy = Math.max(0, Math.min(t.bottom, b.bottom) - Math.max(t.top, b.top)); if (ix > 0 && iy > 0) overlap = '和 ' + card.dataset.type + ' 重叠 ' + Math.round(ix) + 'x' + Math.round(iy) }) ; return '块顶=' + Math.round(r.top) + ' 工具条底=' + Math.round(t.bottom) + ' 空隙=' + Math.round(r.top - t.bottom) + ' 与其它块=' + overlap })()")
$r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png' }
if ($r.result.data) {
  [IO.File]::WriteAllBytes((Join-Path (Get-Location) 'assets\shots\note-hover.png'), [Convert]::FromBase64String($r.result.data))
  "截图：assets\shots\note-hover.png"
}
$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
