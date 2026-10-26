# 对比"编写"和"阅读"两种模式的渲染：各拍一张，同一篇、同一窗口尺寸。
param([string]$Note = '开始这里.md')

$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddcmp-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800

Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400

$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1200,1000', 'http://localhost:5183/?vault=memory'
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
  return $r.result.result.value
}
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png' }
  if ($r.result.data) {
    $out = Join-Path (Get-Location) "assets\shots\$name"
    [IO.File]::WriteAllBytes($out, [Convert]::FromBase64String($r.result.data))
    "截图：$out"
  } else {
    "截图失败：$name → " + ($r | ConvertTo-Json -Depth 5 -Compress).Substring(0, 200)
  }
}

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Page.enable' @{})

$CLICK_FILE = "((name) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === name); if (!b) return 'no'; b.click(); return 'ok' })"
$CLICK_MODE = "((name) => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === name); if (!b) return 'no'; b.click(); return 'ok' })"

$MEASURE = '(() => { const m = (el) => { if (!el) return "-"; const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(",") }; const blocks = [...document.querySelectorAll(".dd-block")].map((d) => Math.round(d.getBoundingClientRect().height)).join("/"); const lines = [...document.querySelectorAll(".cm-line")].map((d) => Math.round(d.getBoundingClientRect().height)).slice(0, 8).join("/"); return "h1=" + m(document.querySelector("h1")) + " table=" + m(document.querySelector("table")) + " math=" + m(document.querySelector(".katex-display")) + " | dd-block=" + blocks + " cm-line=" + lines })()'

[void](Eval "($CLICK_FILE)('$Note')")
Start-Sleep -Milliseconds 1200
# 点一下正文右边留白，让编辑器失焦 —— 这样"没有光标在任何块里"
[void](Eval 'document.activeElement && document.activeElement.blur && document.activeElement.blur()')
Start-Sleep -Milliseconds 700
"编写：" + [string](Eval $MEASURE)
Shot 'mode-write.png'

[void](Eval "($CLICK_MODE)('阅读')")
Start-Sleep -Milliseconds 1500
"阅读：" + [string](Eval $MEASURE)
Shot 'mode-read.png'

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
