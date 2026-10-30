param([string]$Url = 'http://localhost:5183/?vault=memory')
$ErrorActionPreference = 'Stop'
$url = $Url
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddinl2-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800

$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--user-data-dir=$profile", "--remote-debugging-port=$port", '--window-size=1440,900', 'about:blank'
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
function Rect([string]$sel, [int]$nth = 0) {
  return (Eval "(() => { const b = document.querySelectorAll('$sel')[$nth]; if (!b) return ''; const r = b.getBoundingClientRect(); return r.left + ',' + r.top + ',' + r.width + ',' + r.height })()")
}
function ClickRect([string]$rect, [int]$count = 1) {
  $p = $rect.Split(',')
  $x = [double]$p[0] + [double]$p[2] / 2
  $y = [double]$p[1] + [double]$p[3] / 2
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = $count })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = $count })
  Start-Sleep -Milliseconds 500
}
function ClickAt([string]$rect, [double]$fx) {
  $p = $rect.Split(',')
  $x = [double]$p[0] + [double]$p[2] * $fx
  $y = [double]$p[1] + [double]$p[3] / 2
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  Start-Sleep -Milliseconds 500
}
function Press([string]$key, [string]$code, [int]$vk) {
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; key = $key; code = $code; windowsVirtualKeyCode = $vk })
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $key; code = $code; windowsVirtualKeyCode = $vk })
  Start-Sleep -Milliseconds 250
}

$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}

Start-Sleep -Milliseconds 400
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Page.navigate' @{ url = $url })
Start-Sleep -Milliseconds 2800
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error))); "ok"')

Write-Host 'A. 行内 $…$ 点一下就能改'
[void](Eval '(() => { const v = window.__dd_view; const t = "线\n\n值 $E = mc^2$ 在这\n"; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 700
Check '先渲染成公式（源码被藏起来）' ([int](Eval 'document.querySelectorAll(".cm-editor .dd-math").length') -eq 1) "n=$(Eval 'document.querySelectorAll(".cm-editor .dd-math").length')"
Check '公式上写着「点一下编辑公式」' ((Eval 'document.querySelector(".cm-editor .dd-math").title') -eq '点一下编辑公式') "t=$(Eval 'document.querySelector(".cm-editor .dd-math").title')"

$r = Rect '.cm-editor .dd-math'
Check '找到公式的位置' ($r -ne '') "rect=$r"

# 点左半 → 光标落在公式开头（$ 之后）
ClickAt $r 0.25
$headL = [int](Eval 'window.__dd_view.state.selection.main.head')
Check '点左半 → 光标在公式开头' ($headL -eq 6) "head=$headL"
Check '点完源码露出来了' ([bool]((Eval 'document.querySelector(".cm-content").textContent') -match '\$E = mc\^2\$')) "text=$(Eval 'document.querySelector(".cm-content").textContent')"
Check '点完就不再是渲染态（可编辑）' ([int](Eval 'document.querySelectorAll(".cm-editor .dd-math").length') -eq 0) "n=$(Eval 'document.querySelectorAll(".cm-editor .dd-math").length')"

Write-Host 'B. 点右半 → 接着写；打完字仍然成立'
[void](Eval '(() => { const v = window.__dd_view; v.dispatch({ selection: { anchor: 0 } }); return 1 })()')
Start-Sleep -Milliseconds 500
$r0 = Rect '.cm-editor .dd-math'
ClickAt $r0 0.78
$headR = [int](Eval 'window.__dd_view.state.selection.main.head')
Check '点右半 → 光标在公式末尾' ($headR -eq 14) "head=$headR"
$before = Eval 'window.__dd_view.state.doc.toString()'
[void](Send-Cdp 'Input.insertText' @{ text = ' 42' })
Start-Sleep -Milliseconds 400
$after = Eval 'window.__dd_view.state.doc.toString()'
Check '打字进得去（文档真的变了）' ($after -ne $before) "before=[$before] after=[$after]"
Check '打进去的字接着公式末尾' ([bool]($after -match '\$E = mc\^2 42\$')) "doc=[$after]"

Write-Host 'C. 行内 $$…$$ 也能点'
[void](Eval '(() => { const v = window.__dd_view; const t = "线\n\n值 $$a+b$$ 在这\n"; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 700
Check '$$…$$ 也渲染成公式' ([int](Eval 'document.querySelectorAll(".cm-editor .dd-math").length') -eq 1) "n=$(Eval 'document.querySelectorAll(".cm-editor .dd-math").length')"
$r2 = Rect '.cm-editor .dd-math'
ClickRect $r2
Check '$$ 点完光标在公式里' ([int](Eval 'window.__dd_view.state.selection.main.head') -ge 7) "head=$(Eval 'window.__dd_view.state.selection.main.head')"
Check '$$ 点完源码露出来' ([bool]((Eval 'document.querySelector(".cm-content").textContent') -match '\$\$a\+b\$\$')) "text=$(Eval 'document.querySelector(".cm-content").textContent')"

Write-Host 'D. 光标在公式里时浮出符号条，点了能插'
[void](Eval '(() => { const v = window.__dd_view; const t = "线\n\n值 $E = mc^2$ 在这\n"; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: t.indexOf("mc") } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 600
Check '符号条出现' ([int](Eval 'document.querySelectorAll("[data-dd-math-hint]").length') -eq 1) "n=$(Eval 'document.querySelectorAll("[data-dd-math-hint]").length')"
Check '符号条上有 11 个按钮（10 个符号 + 更多）' ([int](Eval 'document.querySelectorAll("[data-dd-math-hint] button").length') -eq 11) "n=$(Eval 'document.querySelectorAll("[data-dd-math-hint] button").length')"
$rb = Rect '[data-dd-math-hint] button'
ClickRect $rb
Check '点 ± 真的插进文档' ([bool]((Eval 'window.__dd_view.state.doc.toString()').Contains('\pm'))) "doc=$(Eval 'window.__dd_view.state.doc.toString()')"

Write-Host 'E. 光标移出公式 → 又渲染回公式'
[void](Eval '(() => { const v = window.__dd_view; v.dispatch({ selection: { anchor: 0 } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 600
Check '移出后重新渲染成公式' ([int](Eval 'document.querySelectorAll(".cm-editor .dd-math").length') -eq 1) "n=$(Eval 'document.querySelectorAll(".cm-editor .dd-math").length')"
Check '移出后符号条收起' ([int](Eval 'document.querySelectorAll("[data-dd-math-hint]").length') -eq 0) "n=$(Eval 'document.querySelectorAll("[data-dd-math-hint]").length')"

Check '全程零 JS 报错' ([int](Eval 'window.__errs.length') -eq 0) (Eval 'window.__errs.join(" | ")')

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "FAILED: $fail" }

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
