# 验三件事：插表能选行列、表格能直接编辑、标题能选级别。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddtab-' + [guid]::NewGuid().ToString('N'))
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
[void](Send-Cdp 'Page.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

$CLICK_FILE = "((name) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === name); if (!b) return 'no'; b.click(); return 'ok' })"
$CLICK_ARIA = "((name) => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === name); if (!b) return 'no'; b.click(); return 'ok' })"

[void](Eval "($CLICK_FILE)('开始这里.md')")
Start-Sleep -Milliseconds 1200

"编写模式下的表格"
$rendered = Eval 'document.querySelectorAll(".dd-block-table").length'
Check '表格在编写模式里渲染成了 DOM' ([int]$rendered -ge 1) "tables=$rendered"
Shot 'table-write.png'

"插入表格：选 3 行 × 4 列"
[void](Eval "($CLICK_ARIA)('插入表格')")
Start-Sleep -Milliseconds 400
$cells = Eval 'document.querySelectorAll("[aria-label$=''列'']").length'
$cols = Eval '(() => { const g = [...document.querySelectorAll("div")].find((d) => ((d.getAttribute("style") || "")).indexOf("repeat(6") >= 0); return g ? getComputedStyle(g).gridTemplateColumns : "none" })()'
"  尺寸格子数：$cells   列宽：$cols"
Check '点插入表格弹出 6×6 的尺寸选择' ([int]$cells -ge 36) "cells=$cells"
Check '尺寸选择器排成 6 列' (-not "$cols".StartsWith('none')) "template=$cols"
Shot 'table-picker.png'

$pick = [string](Eval "($CLICK_ARIA)('3 行 4 列')")
Start-Sleep -Milliseconds 700
$doc = [string](Eval '(() => window.__dd_view.state.doc.toString())()')
$hasFour = [bool]($doc -split "`n" | Where-Object { $_ -match '^\|.*\|.*\|.*\|' }).Count
"  插入后竖线条数变化，pick=$pick"
Check '按选的行列插入了表格' ($pick -eq 'ok' -and $doc.Contains('列 4')) "pick=$pick"

"编辑表格"
# 把光标放进第一张表
$MOVE = '(() => { const v = window.__dd_view; const lines = v.state.doc.toString().split("\n"); const idx = lines.findIndex((l) => l.trim().startsWith("|")); if (idx < 0) return "no-table"; v.dispatch({ selection: { anchor: v.state.doc.line(idx + 1).from + 2 } }); return "ok" })()'
$moved = [string](Eval $MOVE)
Start-Sleep -Milliseconds 500
$enabled = [bool](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "编辑表格"); return b ? !b.disabled : false })()')
Check '光标在表格里时「编辑表格」可用' ($moved -eq 'ok' -and $enabled) "moved=$moved enabled=$enabled"

[void](Eval "($CLICK_ARIA)('编辑表格')")
Start-Sleep -Milliseconds 600
$dialog = Eval 'document.querySelectorAll("[role=dialog]").length'
Check '打开网格编辑器' ([int]$dialog -eq 1) "dialog=$dialog"
Shot 'table-editor.png'

# 改第一个输入框，再点应用
$TYPE = @'
(() => {
  const input = document.querySelector('[role=dialog] input')
  if (!input) return 'no-input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '改过啦')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'ok'
})()
'@
[void](Eval $TYPE)
Start-Sleep -Milliseconds 300
[void](Eval "((t) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t); if (!b) return 'no'; b.click(); return 'ok' })('应用')")
Start-Sleep -Milliseconds 600
$doc2 = [string](Eval '(() => window.__dd_view.state.doc.toString())()')
Check '改的单元格写回了正文' ($doc2.Contains('改过啦')) ''

"标题级别"
$LINE3 = '(() => { const v = window.__dd_view; const l = v.state.doc.line(2); v.dispatch({ selection: { anchor: l.from } }); return "ok" })()'
[void](Eval $LINE3)
Start-Sleep -Milliseconds 400
[void](Eval "($CLICK_ARIA)('标题级别')")
Start-Sleep -Milliseconds 400
$levels = Eval 'document.querySelectorAll("[aria-expanded]").length'
$pickH = [string](Eval "((t) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').indexOf(t) === 0); if (!b) return 'no'; b.click(); return 'ok' })('三级标题')")
Start-Sleep -Milliseconds 500
$line2 = [string](Eval '(() => window.__dd_view.state.doc.line(2).text.slice(0, 8))()')
"  第 2 行：$line2  pick=$pickH"
Check '选三级标题后行首是 ###' ($line2.StartsWith('### ')) "line2=$line2"

""
if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
