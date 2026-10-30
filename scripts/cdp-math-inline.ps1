$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddmi-' + [guid]::NewGuid().ToString('N'))
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

# 用 String.fromCharCode(36) 拼美元符号，省得在脚本里到处转义
$noDollar = 'document.querySelector(".cm-content").textContent.indexOf(String.fromCharCode(36)) < 0'

Write-Host 'A. 编写模式：句子中间写 $$…$$（截图里的那种）'
[void](Eval '(() => {
  const D = String.fromCharCode(36, 36)
  const v = window.__dd_view
  const t = "# 标题\n\n公式：" + D + "E = mc^2 + a_1" + D + " 就这样\n"
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } })
  v.focus()
  return 1
})()')
Start-Sleep -Milliseconds 900
Check '渲染出 KaTeX' ([int](Eval 'document.querySelectorAll(".katex").length') -ge 1) "n=$(Eval 'document.querySelectorAll(".katex").length')"
Check '正文里不再有裸的美元符号' ([bool](Eval $noDollar)) "text=[$(Eval 'document.querySelector(".cm-content").textContent')]"

Write-Host 'B. 阅读模式：同一篇'
[void](Eval '(() => { const b = document.querySelector("button[aria-label=阅读]"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 900
$noDollarDoc = 'document.querySelector("[data-dd-doc]").textContent.indexOf(String.fromCharCode(36)) < 0'
Check '阅读模式也没有裸美元符号' ([bool](Eval $noDollarDoc)) "text=[$(Eval 'document.querySelector("[data-dd-doc]").textContent.slice(0,50)')]"
Check '阅读模式里有 KaTeX' ([int](Eval 'document.querySelectorAll("[data-dd-doc] .katex").length') -ge 1) ''

Write-Host 'C. 整行只有 $$…$$ → 块公式，且间距收紧'
[void](Eval '(() => { const b = document.querySelector("button[aria-label=编写]"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 700
[void](Eval '(() => {
  const D = String.fromCharCode(36, 36)
  const v = window.__dd_view
  const t = "# 标题\n\n" + D + "E = mc^2" + D + "\n\n后文\n"
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } })
  v.focus()
  return 1
})()')
Start-Sleep -Milliseconds 900
Check '整行的那种渲染成块（有底色的块）' ([bool](Eval '(() => { const w = document.querySelector(".dd-block"); if (!w) return false; const inner = w.querySelector("div"); return !!inner && getComputedStyle(inner).backgroundColor !== "rgba(0, 0, 0, 0)" })()')) ''
$m = Eval '(() => { const w = document.querySelector(".dd-block > div"); return w ? getComputedStyle(w).marginTop : "none" })()'
$mx = 0.0
try { $mx = [double](($m -replace 'px', '')) } catch { $mx = 99 }
Check '编辑器里的块间距收紧了（上边距 ≤ 12px，原来是 24px）' ($mx -le 12) "marginTop=$m"

Write-Host 'D. 收尾'
Check '零 JS 报错' ([int](Eval 'window.__errs.length') -eq 0) (Eval 'window.__errs.join(" | ")')
Check '无横向溢出' ([bool](([int](Eval 'document.documentElement.scrollWidth') -le [int](Eval 'window.innerWidth')))) ''

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "$fail FAILED" }
$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
