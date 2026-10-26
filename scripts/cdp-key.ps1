# 复现"光标不能移动"：插一段样式文字，光标放进去，按方向键看位置变不变。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddkey-' + [guid]::NewGuid().ToString('N'))
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
function Key([string]$key, [int]$vk) {
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; key = $key; code = $key; windowsVirtualKeyCode = $vk; nativeVirtualKeyCode = $vk })
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $key; code = $key; windowsVirtualKeyCode = $vk; nativeVirtualKeyCode = $vk })
}
function Press([int]$x, [int]$y) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = 1 })
}

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

$PROBE = @'
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || String(e.error))));
const _ce = console.error;
console.error = (...a) => { window.__errs.push('console: ' + a.map((x) => String(x && x.stack ? x.stack : x)).join(' ')); _ce(...a); };
'@
[void](Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = $PROBE })
[void](Send-Cdp 'Page.navigate' @{ url = 'http://localhost:5183/?vault=memory' })
Start-Sleep -Milliseconds 3500

[void](Eval "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if (!b) return 'no'; b.click(); return 'ok' })('示例-链接.md')")
Start-Sleep -Milliseconds 1200

# 插一段带样式的文字
[void](Eval '(() => { const v = window.__dd_view; v.dispatch({ changes: { from: 0, to: 0, insert: "<span style=\"font-size:1.5em\">测试样式</span>普通文字ABC" } }); return "ok" })()')
Start-Sleep -Milliseconds 800

$HEAD = '(() => window.__dd_view.state.selection.main.head)()'
"文档前 40 字：" + [string](Eval '(() => window.__dd_view.state.doc.toString().slice(0, 40))()')

# 光标放到样式文字里
$pt = [string](Eval '(() => { const v = window.__dd_view; const i = v.state.doc.toString().indexOf("测试样式"); const c = v.coordsAtPos(i + 2); return c ? [Math.round(c.left), Math.round((c.top + c.bottom) / 2)].join(",") : "none" })()')
"样式文字坐标：$pt"
$xy = $pt.Split(',')
Press ([int]$xy[0]) ([int]$xy[1])
Start-Sleep -Milliseconds 400
$h0 = Eval $HEAD
"点完 head=$h0"

"--- 按右方向键 3 次 ---"
foreach ($i in 1..3) {
  Key 'ArrowRight' 39
  Start-Sleep -Milliseconds 250
  "  head=" + [string](Eval $HEAD)
}

"--- 按左方向键 3 次 ---"
foreach ($i in 1..3) {
  Key 'ArrowLeft' 37
  Start-Sleep -Milliseconds 250
  "  head=" + [string](Eval $HEAD)
}

"--- 打字（用 insertText，免疫键盘事件差异） ---"
[void](Send-Cdp 'Input.insertText' @{ text = 'X' })
Start-Sleep -Milliseconds 300
"head=" + [string](Eval $HEAD)
"文档前 40 字：" + [string](Eval '(() => window.__dd_view.state.doc.toString().slice(0, 40))()')

"--- 错误 ---"
Eval '(() => (window.__errs || []).slice(0, 6).join("\n"))()'

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
