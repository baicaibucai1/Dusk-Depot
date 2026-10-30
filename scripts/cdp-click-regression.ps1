param([string]$Url = 'http://localhost:5183/?vault=memory')
# 点哪选哪 · 回归检查
#
# 覆盖四件事（用户 2026-10-30 定的验收口径）：
#   1. 编写 / 原代码 两种模式都验，点块前、块后、块后几行
#   2. 滚动之后再点一遍
#   3. 偏差不随块数量累积（1 个块 vs 4 个块，看最后一行）
#   4. 渲染出来的块：单击不编辑，双击才编辑（单独的交互规则，不按文字落点验）
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddreg-' + [guid]::NewGuid().ToString('N'))
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
function Click([double]$x, [double]$y, [int]$count = 1) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = $count })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = $count })
  Start-Sleep -Milliseconds 320
}
$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}
function SetMode([string]$label) {
  [void](Eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '$label'); if (!b) return 'no'; b.click(); return 'ok' })()")
  Start-Sleep -Milliseconds 700
}

Start-Sleep -Milliseconds 400
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 2800

# 固定靶子：段落 / 表格 / 块公式 / 分割线，每块后面都有普通文字，够长（40+ 行）
$doc = @'
# 点选回归

## 块前文字

这一段在表格前面，点它应该落这一行。

| 列一 | 列二 | 列三 |
| :-- | :-: | --: |
| 甲 | 乙 | 1 |
| 丙 | 丁 | 2 |
| 戊 | 己 | 3 |

表格后面这一行，点它应该落这一行。

## 公式前

$$\int_0^1 x^2\,dx = \frac{1}{3}$$

公式后面这一行，点它应该落这一行。

---

分割线后面这一行，点它应该落这一行。

## 再来一段

- [x] 一个已完成的任务
- [ ] 一个没完成的任务

任务清单后面这一行，点它应该落这一行。

## 第二组

| 名称 | 数量 |
| --- | --- |
| 苹果 | 3 |
| 香蕉 | 5 |

第二个表格后面这一行。

$$
f'(x) = \lim_{h \to 0} \frac{f(x+h) - f(x)}{h}
$$

第二个公式后面这一行。

---

再一条分割线，下面这行也要对。

最后一段：点这里应该落在这里。收尾。
'@
$json = $doc | ConvertTo-Json -Compress
[void](Eval "(() => { const v = window.__dd_view; const t = $json; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } }); v.focus(); return 1 })()")
Start-Sleep -Milliseconds 1000
$lines = [int](Eval 'window.__dd_view.state.doc.lines')
Write-Host "靶子文档 $lines 行"

function Test-Clicks([string]$tag) {
  $bad = 0; $n = 0; $skip = 0
  $docLines = [int](Eval 'window.__dd_view.state.doc.lines')
  for ($ln = 1; $ln -le $docLines; $ln++) {
    $spot = Eval @"
(() => {
  const v = window.__dd_view;
  const line = v.state.doc.line($ln);
  if (!line.text.trim()) return 'EMPTY';
  v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  return 'SET';
})()
"@
    if ($spot -eq 'EMPTY') { continue }
    Start-Sleep -Milliseconds 150
    $info = Eval @"
(() => {
  const v = window.__dd_view;
  const line = v.state.doc.line($ln);
  const pos = line.from + Math.floor(line.length / 2);
  const c = v.coordsAtPos(pos);
  if (!c) return 'NOCOORD';
  const x = Math.round(c.left + 1);
  const y = Math.round((c.top + c.bottom) / 2);
  const el = document.elementFromPoint(x, y);
  // 被块组件盖住的位置不按文字规则验（块有单独的单击/双击规则）
  if (el && (el.closest('.dd-block') || el.closest('.dd-math') || el.closest('[data-dd-checked]'))) return 'COVERED';
  return pos + ',' + x + ',' + y;
})()
"@
    if ($info -eq 'NOCOORD' -or $info -eq 'COVERED') { $skip++; continue }
    $p = $info.Split(',')
    Click ([double]$p[1]) ([double]$p[2])
    $head = [int](Eval 'window.__dd_view.state.selection.main.head')
    $got = [int](Eval "window.__dd_view.state.doc.lineAt($head).number")
    $n++
    if ($got -ne $ln) {
      $bad++
      $t = Eval "window.__dd_view.state.doc.line($ln).text"
      Write-Host "    FAIL[$tag] 点第 $ln 行 → 落在第 $got 行  [$($t -replace "`n", ' ')]"
    }
  }
  return @($n, $bad, $skip)
}

Write-Host 'A. 编写模式：从顶部开始逐行点'
SetMode '编写'
$r1 = Test-Clicks '编写'
Check "编写模式：$($r1[0]) 个点全部落在本行" ($r1[1] -eq 0) "错位 $($r1[1]) 个"

Write-Host 'B. 编写模式：滚到底部后再点一遍（滚动静止后重新算坐标）'
[void](Eval '(() => { const sc = document.querySelector(".cm-scroller"); sc.scrollTop = sc.scrollHeight; return sc.scrollTop })()')
Start-Sleep -Milliseconds 600
$r2 = Test-Clicks '编写/滚动后'
Check "滚动后：$($r2[0]) 个点全部落在本行" ($r2[1] -eq 0) "错位 $($r2[1]) 个"

Write-Host 'C. 原代码模式：记号全露，同样逐行点'
SetMode '原代码'
$r3 = Test-Clicks '原代码'
Check "原代码模式：$($r3[0]) 个点全部落在本行" ($r3[1] -eq 0) "错位 $($r3[1]) 个"

Write-Host 'D. 偏差不随块数量累积（末尾那行在不同块数下的落点）'
SetMode '编写'
$counts = @{}
foreach ($case in @(
  @{ n = 1; text = "前文`n`n---`n`n末尾文字" },
  @{ n = 4; text = "前文`n`n---`n`n---`n`n---`n`n---`n`n末尾文字" }
)) {
  $c = $case.text | ConvertTo-Json -Compress
  [void](Eval "(() => { const v = window.__dd_view; const t = $c; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } }); v.focus(); return 1 })()")
  Start-Sleep -Milliseconds 700
  $last = [int](Eval 'window.__dd_view.state.doc.lines')
  $info = Eval @"
(() => {
  const v = window.__dd_view;
  const line = v.state.doc.line($last);
  const pos = line.from + 1;
  const c = v.coordsAtPos(pos);
  if (!c) return 'NOCOORD';
  const x = Math.round(c.left + 1), y = Math.round((c.top + c.bottom) / 2);
  return x + ',' + y;
})()
"@
  $p = $info.Split(',')
  Click ([double]$p[0]) ([double]$p[1])
  $got = [int](Eval "window.__dd_view.state.doc.lineAt(window.__dd_view.state.selection.main.head).number")
  $counts[$case.n] = ($got -eq $last)
  Check "$($case.n) 个分割线时，点末尾那行仍落在第 $last 行" ($got -eq $last) "落在第 $got 行"
}

Write-Host 'E. 渲染出来的块：单击不编辑，双击才编辑'
[void](Eval '(() => { const v = window.__dd_view; const t = "前文\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n后文"; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 800
$rect = Eval '(() => { const b = document.querySelector(".dd-block"); if (!b) return ""; const r = b.getBoundingClientRect(); return (r.left + r.width / 2) + "," + (r.top + r.height / 2) })()'
if ($rect -ne '') {
  $p = $rect.Split(',')
  $dialogs0 = [int](Eval 'document.querySelectorAll(".fixed.inset-0").length')
  Click ([double]$p[0]) ([double]$p[1]) 1
  $dialogs1 = [int](Eval 'document.querySelectorAll(".fixed.inset-0").length')
  Check '单击表格：不弹编辑框' ($dialogs1 -eq $dialogs0) "before=$dialogs0 after=$dialogs1"
  Click ([double]$p[0]) ([double]$p[1]) 2
  $dialogs2 = [int](Eval 'document.querySelectorAll(".fixed.inset-0").length')
  Check '双击表格：弹出编辑框' ($dialogs2 -gt $dialogs1) "after=$dialogs2"
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; key = 'Escape'; code = 'Escape'; windowsVirtualKeyCode = 27 })
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'Escape'; code = 'Escape'; windowsVirtualKeyCode = 27 })
  Start-Sleep -Milliseconds 300
} else {
  Check '找到渲染出来的表格' $false 'no block'
}

Write-Host 'F. 改视口宽度（触发行重排 + 公式重新排版）后再点'
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1080; height = 900; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 900
# D 段换过文档，这里换回长靶子再来
[void](Eval "(() => { const v = window.__dd_view; const t = $json; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } }); v.focus(); return 1 })()")
Start-Sleep -Milliseconds 700
[void](Eval '(() => { const v = window.__dd_view; v.dispatch({ selection: { anchor: 0 }, scrollIntoView: true }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 500
$r4 = Test-Clicks '窄视口'
Check "窄视口：$($r4[0]) 个点全部落在本行（跳过 $($r4[2]) 处）" ($r4[1] -eq 0) "错位 $($r4[1]) 个"
[void](Send-Cdp 'Emulation.clearDeviceMetricsOverride' @{})

Check '零 JS 报错' ([int](Eval 'window.__errs ? window.__errs.length : 0') -eq 0) (Eval 'window.__errs ? window.__errs.join(" | ") : ""')

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "FAILED: $fail" }

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
