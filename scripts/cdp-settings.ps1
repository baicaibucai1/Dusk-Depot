$JS_CUSTOM = @'
(() => {
  const el = document.querySelector("[role=dialog] input[type=text]")
  if (!el) return "no-input"
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set
  setter.call(el, "'KaiTi', serif")
  el.dispatchEvent(new Event("input", { bubbles: true }))
  return "ok"
})()
'@

# 验设置面板：打开、拖字号、看正文真的变、恢复默认。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddset-' + [guid]::NewGuid().ToString('N'))
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
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png' }
  if ($r.result.data) {
    $out = Join-Path (Get-Location) "assets\shots\$name"
    [IO.File]::WriteAllBytes($out, [Convert]::FromBase64String($r.result.data))
    "截图：$out"
  }
}
$fails = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "  ✓ $name" } else { "  ✗ $name  $detail"; $script:fails += $name }
}

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

[void](Eval "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if (!b) return 'no'; b.click(); return 'ok' })('开始这里.md')")
Start-Sleep -Milliseconds 1000

"打开设置"
$open = [string](Eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '设置'); if (!b) return 'no'; b.click(); return 'ok' })()")
Start-Sleep -Milliseconds 600
$dialog = Eval 'document.querySelectorAll("[role=dialog][aria-label=设置]").length'
Check '点左栏「设置」能打开面板' ($open -eq 'ok' -and [int]$dialog -eq 1) "open=$open dialog=$dialog"
Shot 'settings.png'

"拖字号到 19px"
$before = [string](Eval 'getComputedStyle(document.documentElement).getPropertyValue("--dd-fs").trim()')
$set = [string](Eval @'
(() => {
  const el = document.querySelector('[role=dialog] input[type=range]')
  if (!el) return 'no-slider'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, '19')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()
'@)
Start-Sleep -Milliseconds 600
$after = [string](Eval 'getComputedStyle(document.documentElement).getPropertyValue("--dd-fs").trim()')
$cm = [string](Eval '(() => { const c = document.querySelector(".cm-content"); return c ? getComputedStyle(c).fontSize : "none" })()')
"  字号变量：$before → $after（编辑器实际：$cm）"
Check '拖字号，变量和正文都跟着变' ($set -eq 'ok' -and $after -eq '19px' -and $cm -eq '19px') "set=$set after=$after cm=$cm"
Shot 'settings-large.png'

"自定义字体"
[void](Eval "((t) => { const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => (x.textContent || '').trim() === t); if (!b) return 'no'; b.click(); return 'ok' })('自定义')")
Start-Sleep -Milliseconds 500
$typed = [string](Eval $JS_CUSTOM)
Start-Sleep -Milliseconds 500
$fontVar = [string](Eval 'getComputedStyle(document.documentElement).getPropertyValue("--dd-font").trim()')
"  字体变量：$fontVar"
Check '自定义字体写进了 CSS 变量' ($typed -eq 'ok' -and $fontVar -like '*KaiTi*') "typed=$typed font=$fontVar"
Shot 'settings-font.png'

"恢复默认"
[void](Eval "((t) => { const b = [...document.querySelectorAll('[role=dialog] button')].find((x) => (x.textContent || '').trim() === t); if (!b) return 'no'; b.click(); return 'ok' })('恢复默认')")
Start-Sleep -Milliseconds 600
$reset = [string](Eval 'getComputedStyle(document.documentElement).getPropertyValue("--dd-fs").trim()')
Check '恢复默认把字号退回 15px' ($reset -eq '15px') "after-reset=$reset"

"关掉面板"
[void](Eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '关闭设置'); if (!b) return 'no'; b.click(); return 'ok' })()")
Start-Sleep -Milliseconds 400
Check '点 × 能关掉' ([int](Eval 'document.querySelectorAll("[role=dialog][aria-label=设置]").length') -eq 0) ''

""
if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
