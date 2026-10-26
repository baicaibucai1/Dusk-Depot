# 验"直接勾选"：编写模式里点复选框 → 文档里的 [ ]/[x] 真的被改掉
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddtask-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$url = 'http://localhost:5183/'
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
  if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.exception.description }
  return $r.result.result.value
}
$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}

Start-Sleep -Milliseconds 1000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })
[void](Send-Cdp 'Page.navigate' @{ url = $url })
Start-Sleep -Milliseconds 3500
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error)))')

[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("打开示例库")).click()')
Start-Sleep -Milliseconds 2500

Check '默认在编写模式（有 CodeMirror）' ([int](Eval 'document.querySelectorAll(".cm-editor").length') -eq 1) ''
Check '任务框渲染出来（至少 2 个）' ([int](Eval 'document.querySelectorAll(".dd-check").length') -ge 2) "n=$(Eval 'document.querySelectorAll(".dd-check").length')"

# 先把光标移到第一行之外（保证任务行不是"源码行"）
[void](Eval '(() => { const v = document.querySelector(".cm-content"); v.focus(); return 1 })()')
$offBefore = [int](Eval 'document.querySelectorAll(".dd-check:not(.dd-check-on)").length')
$onBefore = [int](Eval 'document.querySelectorAll(".dd-check-on").length')
Write-Host "点击前：未勾 $offBefore / 已勾 $onBefore"

$clicked = Eval '(() => { const el = document.querySelector(".dd-check:not(.dd-check-on)"); if (!el) return "none"; el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return "ok" })()'
Start-Sleep -Milliseconds 500
$offAfter = [int](Eval 'document.querySelectorAll(".dd-check:not(.dd-check-on)").length')
$onAfter = [int](Eval 'document.querySelectorAll(".dd-check-on").length')
Write-Host "点击后：未勾 $offAfter / 已勾 $onAfter（click=$clicked）"
Check '点未勾的框 → 变成已勾' ($onAfter -eq $onBefore + 1) "before=$onBefore after=$onAfter"

# 再点一次同一个位置（现在是已勾的），应回到未勾
$clicked2 = Eval '(() => { const els = [...document.querySelectorAll(".dd-check-on")]; const el = els[els.length - 1]; if (!el) return "none"; el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return "ok" })()'
Start-Sleep -Milliseconds 500
$onBack = [int](Eval 'document.querySelectorAll(".dd-check-on").length')
Write-Host "再点一次后：已勾 $onBack（click=$clicked2）"
Check '再点已勾的框 → 取消勾选' ($onBack -eq $onAfter - 1) "after=$onAfter back=$onBack"

# 切「原代码」确认磁盘源码真的变了
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "原代码"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 500
$hasX = Eval '[...document.querySelectorAll(".cm-line")].some((l) => (l.textContent || "").includes("[x]"))'
Check '源码里出现 [x]（真的改了文档）' ([bool]$hasX) ''

$errs = Eval 'window.__errs.length'
Check '没有 JS 报错' ("$errs" -eq '0') "errs=$errs $(Eval 'window.__errs.join(" | ")')"

# ── 阅读模式：点任务框也要能勾（之前挂住的那条在这里顺便查）──
Write-Host '── 阅读模式 ──'
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "阅读"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 900
Check '阅读模式渲染出任务行' ([int](Eval 'document.querySelectorAll("[data-dd-li=task]").length') -ge 2) "n=$(Eval 'document.querySelectorAll("[data-dd-li=task]").length')"
$rBefore = [int](Eval 'document.querySelectorAll("[data-dd-checked=true]").length')
[void](Eval '(() => { const b = document.querySelector("[data-dd-checked=false] [role=checkbox]"); if (!b) return "none"; b.click(); return "ok" })()')
Start-Sleep -Milliseconds 600
$rAfter = [int](Eval 'document.querySelectorAll("[data-dd-checked=true]").length')
Check '阅读模式点框 → 勾态变化' ($rAfter -eq $rBefore + 1) "before=$rBefore after=$rAfter"

$errs2 = Eval 'window.__errs.length'
Check '阅读模式也没有报错' ("$errs2" -eq '0') "errs=$errs2 $(Eval 'window.__errs.join(" | ")')"

Write-Host ''
if ($script:fail -eq 0) { Write-Host 'task-check: 全部通过' } else { Write-Host "task-check: $script:fail 条没过"; exit 1 }
