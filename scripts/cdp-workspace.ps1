param([string]$Url = 'http://localhost:5183/?vault=memory')
# 桌面工作区布局 · 交互验收
#
# 覆盖用户给的验收流程：多标签切换与关闭、左右分栏与拖动、折叠左右栏、
# 编辑内容跨标签保持、窄窗口不收溢出。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddws-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--user-data-dir=$profile", "--remote-debugging-port=$port", '--window-size=1440,900', 'about:blank'
)
for ($i = 0; $i -lt 40; $i++) {
  try { $list = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2; $page = $list | Where-Object { $_.type -eq 'page' } | Select-Object -First 1; if ($page) { break } } catch { }
  Start-Sleep -Milliseconds 400
}
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
$id = 0
function Send-Cdp([string]$method, [hashtable]$params) {
  $script:id++; $myId = $script:id
  $msg = @{ id = $myId; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, [Threading.CancellationToken]::None).Wait()
  while ($true) {
    $buf = [byte[]]::new(1048576); $sb = [System.Text.StringBuilder]::new()
    do { $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None).Result; [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)) } while (-not $res.EndOfMessage)
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
function Click([double]$x, [double]$y, [string]$button = 'left', [int]$count = 1) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = $button; clickCount = $count })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = $button; clickCount = $count })
  Start-Sleep -Milliseconds 380
}
function ClickSel([string]$sel) {
  $r = Rect $sel
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  Click ([double]$p[0] + [double]$p[2] / 2) ([double]$p[1] + [double]$p[3] / 2)
  return $true
}
function Drag([string]$sel, [int]$dx) {
  $r = Rect $sel
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  $x = [double]$p[0] + [double]$p[2] / 2
  $y = [double]$p[1] + [double]$p[3] / 2
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  Start-Sleep -Milliseconds 120
  foreach ($step in 1..6) {
    [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x + $dx * $step / 6; y = $y; button = 'left' })
    Start-Sleep -Milliseconds 40
  }
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x + $dx; y = $y; button = 'left'; clickCount = 1 })
  Start-Sleep -Milliseconds 350
  return $true
}
$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}
function CenterW() {
  return [int](Eval '[...document.querySelectorAll("main[data-active-path]")].reduce((a, m) => a + m.getBoundingClientRect().width, 0)')
}
function W([string]$sel) {
  $r = Rect $sel
  if ($r -eq '') { return 0 }
  return [int][double]($r.Split(',')[2])
}

Start-Sleep -Milliseconds 400
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 1200
# 进示例库（首页有按钮）
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("打开示例库")); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 2200
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error))); "ok"')

Write-Host 'A. 四区结构'
Check '左侧导航条宽 48' ((W 'nav[aria-label="功能导航"]') -eq 48) "w=$(W 'nav[aria-label=\"功能导航\"]')"
Check '导航条 2 个入口（文件/设置），工具页已去掉' ((Eval '[...document.querySelectorAll("nav[aria-label=\"功能导航\"] button")].map((b) => b.getAttribute("aria-label")).join("/")') -eq '文件/设置') "got=$(Eval '[...document.querySelectorAll("nav[aria-label=\"功能导航\"] button")].map((b) => b.getAttribute("aria-label")).join("/")')"
Check '默认选中「文件」' ((Eval 'document.querySelector("nav[aria-label=\"功能导航\"] button[aria-pressed=true]").getAttribute("aria-label")') -eq '文件') "got=$(Eval 'document.querySelector("nav[aria-label=\"功能导航\"] button[aria-pressed=true]") ? document.querySelector("nav[aria-label=\"功能导航\"] button[aria-pressed=true]").getAttribute("aria-label") : "none"')"
$treeW = W 'section[aria-label="文件与工具"]'
Check '目录栏在 240–320 之间' ($treeW -ge 240 -and $treeW -le 320) "w=$treeW"
$asideW = W 'aside[aria-label="大纲与关系"]'
Check '右栏在 260–340 之间' ($asideW -ge 260 -and $asideW -le 340) "w=$asideW"
Check '无横向溢出' ([int](Eval 'document.documentElement.scrollWidth <= window.innerWidth + 1') -eq 1) "scrollW=$(Eval 'document.documentElement.scrollWidth') inner=$(Eval 'window.innerWidth')"

Write-Host 'B. 多标签：新开 / 切换 / 关闭'
# 右键第二个文件 → 在新标签页打开
$rows = Eval '[...document.querySelectorAll("[data-dd-files] button")].map((b) => b.textContent.trim()).join("|")'
$r2 = Eval '(() => { const all = [...document.querySelectorAll("[data-dd-files] button")].filter((b) => b.textContent.trim() && !b.getAttribute("aria-label")); const b = all[1]; if (!b) return ""; const r = b.getBoundingClientRect(); return r.left + "," + r.top + "," + r.width + "," + r.height })()'
if ($r2 -ne '') {
  $p = $r2.Split(',')
  Click ([double]$p[0] + 20) ([double]$p[1] + [double]$p[3] / 2) 'right'
  Start-Sleep -Milliseconds 300
  [void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "在新标签页打开"); if (b) b.click(); return 1 })()')
  Start-Sleep -Milliseconds 500
}
$tabs1 = [int](Eval 'document.querySelectorAll("[data-active-path] [title]").length')
$tabCount = [int](Eval '(() => { const p = document.querySelector("main"); if (!p) return 0; return p.querySelectorAll("header div.overflow-x-auto > div").length })()')
Check '打开第二个标签后标签数 ≥ 2' ($tabCount -ge 2) "n=$tabCount rows=$rows"

$activeBefore = Eval 'document.querySelector("main[data-pane-active=true]")?.getAttribute("data-active-path")'
[void](Eval '(() => { const d = document.querySelector("main header div.overflow-x-auto > div"); const b = d ? d.querySelector("button") : null; if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 500
$activeAfter = Eval 'document.querySelector("main[data-pane-active=true]")?.getAttribute("data-active-path")'
Check '点第一个标签 → 活动文件切回它' ($activeAfter -ne $activeBefore -and $activeAfter -ne '') "before=$activeBefore after=$activeAfter"

$tabCount2 = [int](Eval '(() => { const p = document.querySelector("main"); return p ? p.querySelectorAll("header div.overflow-x-auto > div").length : 0 })()')
[void](Eval '(() => { const p = document.querySelector("main"); const d = p.querySelector("header div.overflow-x-auto > div"); if (!d) return 0; const btn = d.querySelector("button[aria-label^=关闭]"); if (btn) btn.click(); return 1 })()')
Start-Sleep -Milliseconds 500
$tabCount3 = [int](Eval '(() => { const p = document.querySelector("main"); return p ? p.querySelectorAll("header div.overflow-x-auto > div").length : 0 })()')
Check '关闭一个标签 → 标签数减 1' ($tabCount3 -eq ($tabCount2 - 1)) "$tabCount2 → $tabCount3"

Write-Host 'C. 分栏：拆 / 各自切文件 / 拖分割线'
[void](ClickSel 'button[aria-label="向右拆分这一栏"]')
Start-Sleep -Milliseconds 600
$panes = [int](Eval 'document.querySelectorAll("main[data-active-path]").length')
Check '拆出两栏' ($panes -eq 2) "n=$panes"
$w1 = W 'div[role="separator"][aria-label="调整分栏宽度"]'
Check '分栏之间有可拖的分隔条' ($w1 -ge 4) "w=$w1"
$before = Eval '[...document.querySelectorAll("main[data-active-path]")].map((m) => m.getAttribute("data-active-path")).join("|")'
# 先把焦点给第二栏（点它的标签条），再点树里一个和当前不同的文件
[void](Eval '(() => { const ms = [...document.querySelectorAll("main[data-active-path]")]; const m = ms[ms.length - 1]; if (!m) return 0; m.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return 1 })()')
Start-Sleep -Milliseconds 250
$r3 = Eval '(() => { const cur = [...document.querySelectorAll("main[data-active-path]")].pop()?.getAttribute("data-active-path") || ""; const all = [...document.querySelectorAll("[data-dd-files] button")].filter((b) => { const t = b.textContent.trim(); return t && !b.getAttribute("aria-label") && t !== cur.replace(/\.md$/, "").split("/").pop(); }); const b = all[all.length - 1]; if (!b) return ""; const r = b.getBoundingClientRect(); return r.left + "," + r.top + "," + r.width + "," + r.height })()'
if ($r3 -ne '') {
  $p = $r3.Split(',')
  Click ([double]$p[0] + 20) ([double]$p[1] + [double]$p[3] / 2)
  Start-Sleep -Milliseconds 500
}
$after = Eval '[...document.querySelectorAll("main[data-active-path]")].map((m) => m.getAttribute("data-active-path")).join("|")'
Check '两栏各有自己的活动文件（点树只改焦点栏）' ($after -ne $before -and (($after -split '\|')[0] -eq ($before -split '\|')[0])) "before=$before after=$after"

$pw1 = Eval '[...document.querySelectorAll("main[data-active-path]")].map((m) => Math.round(m.getBoundingClientRect().width)).join("|")'
[void](Drag 'div[role="separator"][aria-label="调整分栏宽度"]' 80)
$pw2 = Eval '[...document.querySelectorAll("main[data-active-path]")].map((m) => Math.round(m.getBoundingClientRect().width)).join("|")'
Check '拖分割线改变了栏宽' ($pw1 -ne $pw2) "before=$pw1 after=$pw2"

Write-Host 'D. 折叠：目录栏 / 右栏'
[void](ClickSel 'nav[aria-label="功能导航"] button[aria-label="文件"]')
Start-Sleep -Milliseconds 400
Check '点导航「文件」→ 目录栏收起' ((W 'section[aria-label="文件与工具"]') -eq 0) "w=$(W 'section[aria-label=\"文件与工具\"]')"
[void](ClickSel 'nav[aria-label="功能导航"] button[aria-label="文件"]')
Start-Sleep -Milliseconds 400
Check '再点一次 → 目录栏回来' ((W 'section[aria-label="文件与工具"]') -gt 200) "w=$(W 'section[aria-label=\"文件与工具\"]')"

$asideOpenW = W 'aside[aria-label="大纲与关系"]'
$centerOpen = CenterW
[void](ClickSel 'button[aria-label="收起右栏"]')
Start-Sleep -Milliseconds 500
$asideClosedW = W 'aside[aria-label="大纲与关系"]'
$centerClosed = CenterW
Check '收起右栏 → 右栏宽度归零' ($asideClosedW -eq 0) "w=$asideClosedW"
Check '右栏收起后中央区变宽（不是被盖住）' ($centerClosed -gt $centerOpen) "open=$centerOpen closed=$centerClosed"
[void](ClickSel 'button[aria-label="展开右栏"]')
Start-Sleep -Milliseconds 500
Check '再展开 → 宽度恢复' ((W 'aside[aria-label="大纲与关系"]') -eq $asideOpenW) "w=$(W 'aside[aria-label=\"大纲与关系\"]') want=$asideOpenW"

Write-Host 'E. 编辑内容跨标签保持'
[void](Eval '(() => { const v = window.__dd_view; if (!v) return 0; v.focus(); return 1 })()')
Start-Sleep -Milliseconds 200
[void](Send-Cdp 'Input.insertText' @{ text = 'ZXCVB' })
Start-Sleep -Milliseconds 500
$editedPath = Eval 'document.querySelector("main[data-pane-active=true]")?.getAttribute("data-active-path")'
$hasText = Eval '(() => { const v = window.__dd_view; return v ? v.state.doc.toString().includes("ZXCVB") : false })()'
Check '编辑进得去' ([bool]$hasText) "path=$editedPath"
# 切到另一个标签再切回
[void](Eval '(() => { const p = document.querySelector("main"); const ds = p.querySelectorAll("header div.overflow-x-auto > div"); const other = [...ds].find((d) => !d.querySelector("button")?.closest("[data-active]") && d !== ds[0]); const b = (ds[1] ?? ds[0])?.querySelector("button"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 500
[void](Eval '(() => { const p = document.querySelector("main"); const d = p.querySelector("header div.overflow-x-auto > div"); const b = d ? d.querySelector("button") : null; if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 600
$still = Eval '(() => { const v = window.__dd_view; return v ? v.state.doc.toString().includes("ZXCVB") : false })()'
Check '切走再切回，改动还在' ([bool]$still) "still=$still"

Write-Host 'F. 窄窗口：先收右栏再收目录，且不横向溢出'
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1100; height = 900; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 700
Check '1100 宽：右栏自动收起' ((W 'aside[aria-label="大纲与关系"]') -eq 0) "w=$(W 'aside[aria-label=\"大纲与关系\"]')"
Check '1100 宽：目录栏仍在' ((W 'section[aria-label="文件与工具"]') -gt 200) "w=$(W 'section[aria-label=\"文件与工具\"]')"
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 880; height = 900; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 700
Check '880 宽：目录栏也收起' ((W 'section[aria-label="文件与工具"]') -eq 0) "w=$(W 'section[aria-label=\"文件与工具\"]')"
Check '880 宽：导航条还在' ((W 'nav[aria-label="功能导航"]') -eq 48) "w=$(W 'nav[aria-label=\"功能导航\"]')"
Check '880 宽：编辑器仍在且无横向溢出' ([int](Eval '(() => { const m = document.querySelector("main[data-active-path]"); return m && m.getBoundingClientRect().width > 200 && document.documentElement.scrollWidth <= window.innerWidth + 1 })()') -eq 1) "pane=$(Eval 'document.querySelector("main[data-active-path]")?.getBoundingClientRect().width') scroll=$(Eval 'document.documentElement.scrollWidth')"
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1440; height = 900; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 700
Check '回到 1440：右栏和目录栏都恢复' ([bool]((W 'aside[aria-label="大纲与关系"]') -gt 200) -and ((W 'section[aria-label="文件与工具"]') -gt 200)) "aside=$(W 'aside[aria-label=\"大纲与关系\"]') tree=$(W 'section[aria-label=\"文件与工具\"]')"

Check '零 JS 报错' ([int](Eval 'window.__errs ? window.__errs.length : 0') -eq 0) (Eval 'window.__errs ? window.__errs.join(" | ") : ""')

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "FAILED: $fail" }

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
