# 验"从零到手能写"：打开首页 → 点示例库 → 有编辑器 → 打字进得去 → 切文件 → 新建笔记
# 用法：cdp-smoke.ps1 [-Url http://localhost:5184/]   （5183 = dev，5184 = 生产构建）
param([string]$Url = 'http://localhost:5183/')
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddsmoke-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1440,900', 'about:blank'
)
for ($i = 0; $i -lt 40; $i++) {
  try {
    $list = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2
    $page = $list | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
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
    $sb = [System.Text.StringBuilder]::new()
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
function Click([int]$x, [int]$y) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = 1 })
}
$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}

Start-Sleep -Milliseconds 1000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })
$PROBE = @'
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)));
'@
[void](Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = $PROBE })
[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 4000
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error)))')

Write-Host '── 首页（不带参数）──'
Check '首页有「打开示例库」按钮' ([bool](Eval '[...document.querySelectorAll("button")].some((b) => b.textContent.includes("打开示例库"))')) ''
Check '首页不是空屏' ([bool](Eval 'document.body.innerText.includes("选一个文件夹当仓库") || document.body.innerText.includes("上次用的仓库")')) ''

Write-Host '── 点进示例库 ──'
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("打开示例库")).click()')
Start-Sleep -Milliseconds 2500
Check '进库后有编辑器（CodeMirror 挂载）' ([int](Eval 'document.querySelectorAll(".cm-editor").length') -eq 1) "n=$(Eval 'document.querySelectorAll(".cm-editor").length')"
Check '编辑器已有内容' ([int](Eval 'document.querySelectorAll(".cm-line").length') -gt 5) "lines=$(Eval 'document.querySelectorAll(".cm-line").length')"
Check '示例库有 4 篇' ((Eval 'document.querySelector("[data-dd-files] .font-mono").textContent.trim()') -eq '4 篇') "got=$(Eval 'document.querySelector("[data-dd-files] .font-mono").textContent.trim()')"

Write-Host '── 真的打字 ──'
$before = [int](Eval 'document.querySelector(".cm-content").textContent.length')
Click 700 400
Start-Sleep -Milliseconds 200
[void](Send-Cdp 'Input.insertText' @{ text = '可编辑' })
Start-Sleep -Milliseconds 500
$after = [int](Eval 'document.querySelector(".cm-content").textContent.length')
Check '打字进得去' ($after -gt $before) "before=$before after=$after"
Start-Sleep -Milliseconds 1000
Check '改动能落盘（状态回到「已保存」）' ((Eval 'document.body.innerText.match(/已保存|待写入|写入中…|写盘失败/)?.[0]') -eq '已保存') "state=$(Eval 'document.body.innerText.match(/已保存|待写入|写入中…|写盘失败/)?.[0] ?? "?"')"

Write-Host '── 切文件 ──'
$clicked = Eval '(() => { const b = [...document.querySelectorAll("[data-dd-files] button")].find((x) => x.textContent.trim().includes("语法示例")); if (!b) return "no"; b.click(); return "ok" })()'
Start-Sleep -Milliseconds 700
Check '点树切到「语法示例.md」' ($clicked -eq 'ok' -and (Eval 'document.querySelector("[data-active-path]").getAttribute("data-active-path")') -eq '语法示例.md') "clicked=$clicked path=$(Eval 'document.querySelector("[data-active-path]")?.getAttribute("data-active-path")')"

Write-Host '── 新建笔记 ──'
$newOk = Eval '(() => { const b = document.querySelector("button[aria-label=新建笔记]"); if (!b) return "no"; b.click(); return "ok" })()'
Start-Sleep -Milliseconds 600
Check '新建笔记出现输入框' ($newOk -eq 'ok') "click=$newOk"
[void](Send-Cdp 'Input.insertText' @{ text = '临时测试' })
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; key = 'Enter'; code = 'Enter'; windowsVirtualKeyCode = 13; nativeVirtualKeyCode = 13 })
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'Enter'; code = 'Enter'; windowsVirtualKeyCode = 13; nativeVirtualKeyCode = 13 })
Start-Sleep -Milliseconds 700
Check '篇数变成 5 篇' ((Eval 'document.querySelector("[data-dd-files] .font-mono").textContent.trim()') -eq '5 篇') "got=$(Eval 'document.querySelector("[data-dd-files] .font-mono").textContent.trim()')"

$errs = Eval 'window.__errs.length'
Check '全程没有 JS 报错' ("$errs" -eq '0') "errs=$errs $(Eval 'window.__errs.join(" | ")')"

Write-Host ''
if ($script:fail -eq 0) { Write-Host 'smoke: 全部通过' } else { Write-Host "smoke: $script:fail 条没过"; exit 1 }
