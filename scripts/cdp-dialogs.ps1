$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('dddlg-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$url = 'http://localhost:5183/?vault=memory'
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @('--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',"--user-data-dir=$profile","--remote-debugging-port=$port",'--window-size=1440,900','about:blank')
for ($i = 0; $i -lt 40; $i++) { try { $list = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2; $page = $list | Where-Object { $_.type -eq 'page' } | Select-Object -First 1; if ($page) { break } } catch { }; Start-Sleep -Milliseconds 400 }
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
$id = 0
function Send-Cdp([string]$method, [hashtable]$params) {
  $script:id++; $myId = $script:id
  $msg = @{ id = $myId; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, [Threading.CancellationToken]::None).Wait()
  while ($true) { $buf = [byte[]]::new(1048576); $sb = [System.Text.StringBuilder]::new(); do { $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None).Result; [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)) } while (-not $res.EndOfMessage); $obj = $sb.ToString() | ConvertFrom-Json; if ($obj.id -eq $myId) { return $obj } }
}
function Eval([string]$expr) { $r = Send-Cdp 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true; awaitPromise = $true }; if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.text }; return $r.result.result.value }
function Click-El([string]$sel) {
  $r = Eval "(() => { const b = document.querySelector('$sel'); if (!b) return ''; const r = b.getBoundingClientRect(); return (r.left + r.width/2) + ',' + (r.top + r.height/2) })()"
  if ($r -eq '') { return $false }
  $p = $r.Split(','); $x = [double]$p[0]; $y = [double]$p[1]
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  Start-Sleep -Milliseconds 400
  return $true
}
$fail = 0
function Check([string]$n, $ok, [string]$d) { if ($ok) { Write-Host "  ok  $n" } else { Write-Host "FAIL  $n  $d"; $script:fail++ } }

Start-Sleep -Milliseconds 400
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Page.navigate' @{ url = $url })
Start-Sleep -Milliseconds 2800
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error))); "ok"')

Write-Host 'A. 公式弹窗（点工具条 → 写 → 应用）'
[void](Eval '(() => { const v = window.__dd_view; const t = "线\n"; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: t.length } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 300
Check '点「块级公式」按钮' (Click-El 'button[aria-label=块级公式]') ''
Check '弹窗出现' ([int](Eval 'document.querySelectorAll("[data-dd-math-dialog]").length') -eq 1) ''
[void](Eval '(() => { const a = document.querySelector("[data-dd-math-input]"); const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set; s.call(a, "E = mc^2"); a.dispatchEvent(new Event("input", { bubbles: true })); return 1 })()')
Start-Sleep -Milliseconds 500
Check '预览里有 KaTeX' ([int](Eval 'document.querySelectorAll("[data-dd-math-dialog] .katex").length') -ge 1) ''
Check '点「应用」' (Click-El 'button[aria-label=关闭]') ''  # 先关掉，验取消
Check '关闭后弹窗消失' ([int](Eval 'document.querySelectorAll("[data-dd-math-dialog]").length') -eq 0) ''
Check '取消不写进文档' ([bool]((Eval 'window.__dd_view.state.doc.toString()') -notmatch '\$\$')) ''
Click-El 'button[aria-label=块级公式]' | Out-Null
[void](Eval '(() => { const a = document.querySelector("[data-dd-math-input]"); const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set; s.call(a, "E = mc^2"); a.dispatchEvent(new Event("input", { bubbles: true })); return 1 })()')
Start-Sleep -Milliseconds 300
$ap = Eval '(() => { const b = [...document.querySelectorAll("[data-dd-math-dialog] button")].find((x) => x.textContent.trim() === "应用"); if (!b) return ""; const r = b.getBoundingClientRect(); return (r.left + r.width/2) + "," + (r.top + r.height/2) })()'
if ($ap -ne '') {
  $p = $ap.Split(',')
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = [double]$p[0]; y = [double]$p[1]; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = [double]$p[0]; y = [double]$p[1]; button = 'left'; clickCount = 1 })
  Start-Sleep -Milliseconds 700
}
Check '应用后文档里是块公式' ([bool]((Eval 'window.__dd_view.state.doc.toString()') -match '\$\$')) "doc=$(Eval 'window.__dd_view.state.doc.toString().replace(/\n/g, "|")')"
Check '渲染成 KaTeX' ([int](Eval 'document.querySelectorAll(".katex").length') -ge 1) ''

Write-Host 'B. 引用弹窗（选篇 + 选小节）'
Check '点「引用一篇」' (Click-El 'button[aria-label=引用一篇]') ''
Check '弹窗出现' ([int](Eval 'document.querySelectorAll("[data-dd-link-dialog]").length') -eq 1) ''
Check '左边列出可引用的篇' ([int](Eval 'document.querySelectorAll("[data-dd-link-doc]").length') -ge 3) "n=$(Eval 'document.querySelectorAll("[data-dd-link-doc]").length')"
[void](Eval '(() => { const b = [...document.querySelectorAll("[data-dd-link-doc]")].find((x) => (x.getAttribute("data-dd-link-doc") || "").indexOf("周计划") >= 0); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 400
Check '选一篇后右边列出小节' ([int](Eval 'document.querySelectorAll("[data-dd-link-head]").length') -ge 2) "n=$(Eval 'document.querySelectorAll("[data-dd-link-head]").length')"
[void](Eval '(() => { const b = document.querySelector("[data-dd-link-head]"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 600
Check '插入了带小节的双链' ([bool]((Eval 'window.__dd_view.state.doc.toString()') -match '\[\[.*#.*\]\]')) "doc=$(Eval 'window.__dd_view.state.doc.toString().replace(/\n/g, "|")')"

Check '零 JS 报错' ([int](Eval 'window.__errs.length') -eq 0) (Eval 'window.__errs.join(" | ")')
Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "$fail FAILED" }
$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
