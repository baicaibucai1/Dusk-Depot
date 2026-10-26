# 把真实笔记原样灌进演示库，逐段测"能不能移动光标"。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddkey2-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$notePath = 'C:\AI_Production\测试\素材\语法速查.md'

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
[void](Send-Cdp 'Page.navigate' @{ url = 'http://localhost:5183/?vault=memory' })
Start-Sleep -Milliseconds 3500

[void](Eval "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if (!b) return 'no'; b.click(); return 'ok' })('示例-链接.md')")
Start-Sleep -Milliseconds 1000

$raw = Get-Content $notePath -Raw
$json = $raw | ConvertTo-Json -Compress
[void](Eval "(() => { const v = window.__dd_view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: $json } }); return 'ok' })()")
Start-Sleep -Milliseconds 1200

$HEAD = '(() => window.__dd_view.state.selection.main.head)()'
$len = Eval '(() => window.__dd_view.state.doc.length)()'
"灌入长度：$len"

# 逐个"标记点"试：点一下，再按右方向键，看光标动不动
$TARGETS = @('语法速查', '粗体', '划掉', '红字', '蓝字', '像荧光笔', '小字', '这一行居中', '这些都不是纯 markdown', '代码', 'hello', '| 写法 |', 'E=mc^2')
foreach ($t in $TARGETS) {
  $pt = [string](Eval "(() => { const v = window.__dd_view; const i = v.state.doc.toString().indexOf('$t'); if (i < 0) return 'none'; const c = v.coordsAtPos(i + 1); return c ? [Math.round(c.left), Math.round((c.top + c.bottom) / 2)].join(',') : 'offscreen' })()")
  if ($pt -eq 'none' -or $pt -eq 'offscreen') { "  $t → 找不到/在视口外（$pt）"; continue }
  $xy = $pt.Split(',')
  Press ([int]$xy[0]) ([int]$xy[1])
  Start-Sleep -Milliseconds 250
  $h1 = Eval $HEAD
  Key 'ArrowRight' 39
  Start-Sleep -Milliseconds 250
  $h2 = Eval $HEAD
  $moved = ([int]$h2 - [int]$h1)
  "  $t → 点后 head=$h1，右键后 head=$h2（移动 $moved）"
}

"--- 错误 ---"
Eval '(() => (window.__errs || []).slice(0, 5).join("\n"))()'

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
