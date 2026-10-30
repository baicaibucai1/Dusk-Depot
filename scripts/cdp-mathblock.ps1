$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddmb-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$url = 'http://localhost:5183/?vault=memory'

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
function Type-Text([string]$text) { [void](Send-Cdp 'Input.insertText' @{ text = $text }) }
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

Write-Host 'A. 手打 $$（原来是这里抛 RangeError，第二个 $ 直接吞掉）'
[void](Eval '(() => { const v = window.__dd_view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "线\n" }, selection: { anchor: 2 } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 250
Type-Text '$'
Start-Sleep -Milliseconds 200
Type-Text '$'
Start-Sleep -Milliseconds 500
$doc = Eval 'window.__dd_view.state.doc.toString()'
Check '两个 $ 都进去了' ($doc -eq "线`n`$`$") "doc=[$($doc -replace "`n", '\n')]"
Check '没有 RangeError' ([bool]((Eval 'window.__errs.join("|")') -notmatch 'RangeError')) "errs=$(Eval 'window.__errs.join("|")')"
Check '块公式面板浮出来了' ([bool](Eval 'document.querySelector("[data-dd-math-panel]") !== null')) ''

Write-Host 'B. 点「块级公式」按钮'
[void](Eval '(() => { const v = window.__dd_view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "线\n" }, selection: { anchor: 2 } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 250
[void](Eval 'document.querySelector("button[aria-label=块级公式]").click()')
Start-Sleep -Milliseconds 600
$doc2 = Eval 'window.__dd_view.state.doc.toString()'
$pos = [int](Eval 'window.__dd_view.state.selection.main.head')
$mid = $doc2.IndexOf("`$`$`n`n`$`$")
Check '插进去的是 $$\n\n$$ 这一块' ($mid -ge 0) "doc=[$($doc2 -replace "`n", '\n')]"
# 块起点 + 3 就是中间那行的行首（`$` `$` `\n` 三个字符）
Check '光标停在两个 $$ 中间（不是收尾之后）' ($pos -eq ($mid + 3)) "pos=$pos 期望=$($mid + 3)"
$panelOn = [bool](Eval 'document.querySelector("[data-dd-math-panel]") !== null')
$katexN = [int](Eval 'document.querySelectorAll(".katex").length')
Check '光标在块里 → 面板在、块还没被渲染成 widget' ($panelOn -and ($katexN -eq 0)) "katex=$katexN panel=$panelOn"

Write-Host 'C. 在块里打字'
Type-Text 'E = mc^2'
Start-Sleep -Milliseconds 500
$doc3 = Eval 'window.__dd_view.state.doc.toString()'
Check '公式文本落在中间那行' ($doc3.Contains("`$`$`nE = mc^2`n`$`$")) "doc=[$($doc3 -replace "`n", '\n')]"
Check '没写收尾也一直有面板' ([bool](Eval 'document.querySelector("[data-dd-math-panel]") !== null')) ''

Write-Host 'D. 光标移出 → 渲染成真公式'
[void](Eval '(() => { const v = window.__dd_view; v.dispatch({ selection: { anchor: 0 } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 700
Check '渲染出 KaTeX' ([int](Eval 'document.querySelectorAll(".katex").length') -ge 1) "n=$(Eval 'document.querySelectorAll(".katex").length')"
Check '源码里的 $$ 被藏起来（不是一堆符号杵在那）' ([bool]((Eval 'document.querySelector(".cm-content").textContent.includes("$$")') -eq $false)) ''
Check '面板收起' ([bool](Eval 'document.querySelector("[data-dd-math-panel]") === null')) ''

Write-Host 'E. 收尾'
Check '全程零 JS 报错' ([int](Eval 'window.__errs.length') -eq 0) (Eval 'window.__errs.join(" | ")')
Check '无横向溢出' ([bool](([int](Eval 'document.documentElement.scrollWidth') -le [int](Eval 'window.innerWidth')))) ''

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "$fail FAILED" }
$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
