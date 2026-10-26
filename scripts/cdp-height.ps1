# 量一下：光标进入样式文字时，编辑器高度会不会变（会变就说明点选会错位）。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddh-' + [guid]::NewGuid().ToString('N'))
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
  if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.text }
  return $r.result.result.value
}

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

[void](Eval "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if (!b) return 'no'; b.click(); return 'ok' })('示例-链接.md')")
Start-Sleep -Milliseconds 1200

# 插一段样式文字在第 2 行
[void](Eval '(() => { const v = window.__dd_view; const l = v.state.doc.line(2); v.dispatch({ changes: { from: l.from, to: l.from, insert: "<span style=\"font-size:1.5em\">测试样式</span>普通\n" } }); return "ok" })()')
Start-Sleep -Milliseconds 700

$MEASURE = '(() => { const ed = document.querySelector(".cm-editor"); const content = document.querySelector(".cm-content"); const insp = document.querySelector("[data-inspector]"); return JSON.stringify({ editorH: Math.round(ed.getBoundingClientRect().height), scrollerH: Math.round(document.querySelector(".cm-scroller").getBoundingClientRect().height), inspector: !!insp }) })()'

# 光标放在样式外
$i = [int](Eval '(() => { const v = window.__dd_view; return v.state.doc.toString().indexOf("普通") + 1 })()')
[void](Eval "(() => { const v = window.__dd_view; v.dispatch({ selection: { anchor: $i } }); return 'ok' })()")
Start-Sleep -Milliseconds 500
"样式外：" + [string](Eval $MEASURE)

# 光标放进样式里
$j = [int](Eval '(() => { const v = window.__dd_view; return v.state.doc.toString().indexOf("测试样式") + 2 })()')
[void](Eval "(() => { const v = window.__dd_view; v.dispatch({ selection: { anchor: $j } }); return 'ok' })()")
Start-Sleep -Milliseconds 600
"样式里：" + [string](Eval $MEASURE)

# 再出来
[void](Eval "(() => { const v = window.__dd_view; v.dispatch({ selection: { anchor: $i } }); return 'ok' })()")
Start-Sleep -Milliseconds 500
"再出来：" + [string](Eval $MEASURE)

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
