$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddmouse-' + [guid]::NewGuid().ToString('N'))
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
function Rect([string]$sel) { return (Eval "(() => { const b = document.querySelector('$sel'); if (!b) return ''; const r = b.getBoundingClientRect(); return r.left + ',' + r.top + ',' + r.width + ',' + r.height })()") }
function Move([double]$x, [double]$y) { [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none' }) }
function Click([double]$x, [double]$y, [int]$count = 1, [int]$mods = 0) {
  Move $x $y
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = $count; modifiers = $mods })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = $count; modifiers = $mods })
  Start-Sleep -Milliseconds 400
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

Write-Host 'A. 阅读模式：单击链接就跳'
[void](Eval '(() => { const v = window.__dd_view; const t = "# 标题\n\n看 [语法示例](语法示例.md) 这篇\n"; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 400
[void](Eval '(() => { const b = document.querySelector("button[aria-label=阅读]"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 900
$before = Eval 'document.querySelector("[data-dd-doc]").textContent.slice(0, 16)'
$r = Rect '[data-dd-doc] [data-dd-link]'
Check '找到链接胶囊' ($r -ne '') "rect=$r"
if ($r -ne '') {
  $p = $r.Split(',')
  Click ([double]$p[0] + [double]$p[2] / 2) ([double]$p[1] + [double]$p[3] / 2)
  Start-Sleep -Milliseconds 500
  $after = Eval 'document.querySelector("[data-dd-doc]").textContent.slice(0, 16)'
  Check '单击之后换了一篇' ($after -ne $before) "before=$before after=$after"
}

Write-Host 'B. 编辑模式：Ctrl + 单击也跳'
[void](Eval '(() => { const b = document.querySelector("button[aria-label=编写]"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 700
[void](Eval '(() => { const v = window.__dd_view; const t = "# 标题\n\n看 [语法示例](语法示例.md) 这篇\n"; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 700
# 编辑模式里链接是胶囊样式的 mark，取它的坐标
$r2 = Eval '(() => { const v = window.__dd_view; const t = v.state.doc.toString(); const i = t.indexOf("语法示例"); const c = v.coordsAtPos(i + 1); return c ? (c.left + 2) + "," + (c.top + 6) : "" })()'
Check '拿到链接坐标' ($r2 -ne '') "xy=$r2"
if ($r2 -ne '') {
  $p = $r2.Split(',')
  $before2 = Eval 'window.__dd_view.state.doc.toString().slice(0, 12)'
  Click ([double]$p[0]) ([double]$p[1]) 1 2   # modifiers=2 是 Ctrl
  Start-Sleep -Milliseconds 600
  $after2 = Eval 'window.__dd_view.state.doc.toString().slice(0, 12)'
  Check 'Ctrl+单击换了篇' ($after2 -ne $before2) "before=$before2 after=$after2"
}

Write-Host 'C. 公式面板：真实鼠标点符号（重做样式后复查）'
[void](Eval '(() => { const v = window.__dd_view; const t = "线\n\n公式 $E = mc^2$\n"; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: t.indexOf("mc") } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 800
Check '面板浮出' ([int](Eval 'document.querySelectorAll("[data-dd-math-panel]").length') -eq 1) ''
$rb = Eval '(() => { const b = [...document.querySelectorAll("[data-dd-math-panel] button")].find((x) => x.textContent.trim() === "α"); if (!b) return ""; const r = b.getBoundingClientRect(); return (r.left + r.width/2) + "," + (r.top + r.height/2) + "," + Math.round(r.width) + "x" + Math.round(r.height) })()'
$bw = 0
try { $bw = [int](($rb.Split(','))[2].Split('x')[0]) } catch { $bw = 0 }
Check '符号按钮够大（≥ 30px）' ($bw -ge 30) "size=$rb"
if ($rb -ne '') {
  $p = $rb.Split(',')
  Click ([double]$p[0]) ([double]$p[1])
  Check '点 α 真的插进去了' ([bool](Eval 'window.__dd_view.state.doc.toString().includes("\\alpha")')) ''
}

Write-Host 'D. 表格尺寸选择器：hover + 点击'
[void](Eval '(() => { const v = window.__dd_view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "线\n" }, selection: { anchor: 2 } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 300
$rbt = Rect 'button[aria-label=表格]'
Check '找到表格按钮' ($rbt -ne '') "rect=$rbt"
if ($rbt -ne '') {
  $p = $rbt.Split(',')
  Click ([double]$p[0] + [double]$p[2] / 2) ([double]$p[1] + [double]$p[3] / 2)
  Start-Sleep -Milliseconds 400
  $cells = [int](Eval '[...document.querySelectorAll("button")].filter((b) => (b.getAttribute("aria-label") || "").indexOf(" 行 ") >= 0).length')
  Check '选择器打开，36 个格子' ($cells -eq 36) "cells=$cells"
  $cell = Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "3 行 4 列"); if (!b) return ""; const r = b.getBoundingClientRect(); return (r.left + r.width / 2) + "," + (r.top + r.height / 2) + "," + Math.round(r.width) })()'
  if ($cell -ne '') {
    $w = [int](($cell.Split(','))[2])
    Check '每格够大（≥ 24px，好点）' ($w -ge 24) "w=$w"
    $p2 = $cell.Split(',')
    Move ([double]$p2[0]) ([double]$p2[1])
    Start-Sleep -Milliseconds 300
    $label = Eval '[...document.querySelectorAll("span")].map((s) => s.textContent).filter((t) => t && t.indexOf("×") >= 0).join("/")'
    Check 'hover 显示 3 × 4' ([bool]($label -match '3 × 4')) "label=$label"
    Click ([double]$p2[0]) ([double]$p2[1])
    Start-Sleep -Milliseconds 600
    Check '点一下插入 3×4 表格' ([bool](Eval 'window.__dd_view.state.doc.toString().includes("| ---")')) "doc=$(Eval 'window.__dd_view.state.doc.toString().slice(-50)')"
  } else {
    Check '找到 3 行 4 列那格' $false 'no cell'
  }
}

Write-Host 'E. 收尾'
Check '零 JS 报错' ([int](Eval 'window.__errs.length') -eq 0) (Eval 'window.__errs.join(" | ")')

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "$fail FAILED" }
$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
