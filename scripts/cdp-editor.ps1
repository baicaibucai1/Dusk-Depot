# 验"按元素露记号"：光标在 **粗体** 里时露出 `**`，光标挪到同一行外面就立刻渲染。
# 这条只有真跑才能验 —— 截图看不出来。

$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddedit-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800

Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1400,900', 'http://localhost:5183/?vault=memory'
)

for ($i = 0; $i -lt 40; $i++) {
  try {
    $list = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2
    $page = $list | Where-Object { $_.type -eq 'page' -and $_.url -like '*localhost:5183*' } | Select-Object -First 1
    if ($page) { break }
  } catch { }
  Start-Sleep -Milliseconds 400
}
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png' }
  if ($r.result.data) {
    $out = Join-Path (Get-Location) "assets\shots\$name"
    [IO.File]::WriteAllBytes($out, [Convert]::FromBase64String($r.result.data))
    "截图：$out"
  }
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
    $buf = [byte[]]::new(262144)
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
  return $r.result.result.value
}

$fails = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "  ✓ $name" } else { "  ✗ $name  $detail"; $script:fails += $name }
}

Start-Sleep -Milliseconds 2500
[void](Send-Cdp 'Runtime.enable' @{})
# 无头窗口默认"没有焦点"，编辑器就不会进入源码态。让页面以为自己被聚焦。
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

# 打开一篇带 **粗体** 的笔记
$CLICK = @'
((name) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === name)
  if (!b) return 'no'
  b.click()
  return 'ok'
})
'@
[void](Eval "($CLICK)('开始这里.md')")
Start-Sleep -Milliseconds 900

$HAS_VIEW = 'typeof window.__dd_view === "object" && !!window.__dd_view'
Check '编辑器实例可被验收脚本拿到（DEV）' ([bool](Eval $HAS_VIEW)) ''

$SETUP = @'
(() => {
  const v = window.__dd_view
  if (!v) return 'no-view'
  v.focus()
  const src = v.state.doc.toString()
  const i = src.indexOf('**粗体**')
  if (i < 0) return 'no-target'
  window.__probe = { v, i, len: '**粗体**'.length }
  return 'ok'
})()
'@
$setup = Eval $SETUP
Check '找到 **粗体** 这个元素' ($setup -eq 'ok') "setup=$setup"
"  hasFocus=$([string](Eval 'String(window.__dd_view.hasFocus)'))  activeElement=$([string](Eval 'document.activeElement ? document.activeElement.className : "none"'))"

$DIAG = '(() => { const l = document.querySelectorAll(".cm-line"); return l.length + " 行 / 首行: " + (l[0] ? l[0].textContent : "none") })()'
"  诊断：" + [string](Eval $DIAG)

# 现在只有"光标所在那个块"是 .cm-line 元素，其余块都渲染成 widget 了 ——
# 所以直接把所有 .cm-line 的文字拼起来看
$LINE_TEXT = '(() => [...document.querySelectorAll(".cm-line")].map((l) => l.textContent || "").join(""))()'

$IN = '(() => { const p = window.__probe; p.v.dispatch({ selection: { anchor: p.i + 3 } }); return "ok" })()'
[void](Eval $IN)
Start-Sleep -Milliseconds 400
$t1 = [string](Eval $LINE_TEXT)
Check '光标在粗体里 → 露出 **' ($t1.Contains('**')) "line=$t1"

$OUT = '(() => { const p = window.__probe; p.v.dispatch({ selection: { anchor: p.i + p.len + 2 } }); return "ok" })()'
[void](Eval $OUT)
Start-Sleep -Milliseconds 400
# 只看"粗体"所在那一行 —— 整篇里别的行也有 **，全局判断会误报
$t2 = [string](Eval '(() => { const ls = [...document.querySelectorAll(".cm-line")].map((l) => l.textContent || ""); return ls.find((t) => t.includes("粗体")) || "none" })()')
Check '光标离开那一处 → 立刻渲染（没有 **）' ($t2 -ne 'none' -and -not $t2.Contains('**')) "line=$t2"

""
"选中与拖选"
# 用真实的鼠标事件拖一段：mousedown → move → mouseup，然后看选区长度
$RECT = '(() => { const l = document.querySelector(".cm-line"); if (!l) return "none"; const r = l.getBoundingClientRect(); return [Math.round(r.x + 30), Math.round(r.y + r.height / 2)].join(",") })()'
$pt = [string](Eval $RECT)
if ($pt -ne 'none') {
  $xy = $pt.Split(',')
  $x0 = [int]$xy[0]
  $y0 = [int]$xy[1]
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x0; y = $y0; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x0 + 40; y = $y0; button = 'left' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x0 + 180; y = $y0; button = 'left' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x0 + 180; y = $y0; button = 'left'; clickCount = 1 })
  Start-Sleep -Milliseconds 500
  $selLen = Eval '(() => { const s = window.__dd_view.state.selection.main; return s.to - s.from })()'
  Check '能拖选出一段文字' ([int]$selLen -gt 0) "选中字符数=$selLen"
  Check '正文是真实可编辑的文本（不是原子块）' ([int](Eval 'document.querySelectorAll(".cm-line").length') -gt 1) "行数=$(Eval 'document.querySelectorAll(".cm-line").length')"
} else {
  Check '能拖选出一段文字' $false '拿不到行坐标'
}

""
$CLICK_MODE = "((name) => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === name); if (!b) return 'no'; b.click(); return 'ok' })"
"格式化工具条"
$HAS_BOLD = '(() => { const v = window.__dd_view; return v ? v.state.doc.toString().indexOf("**粗体**") >= 0 : false })()'
# 先把选区收成一个光标（上一步的拖选还在），否则加粗会去包住那段选中的字
[void](Eval '(() => { const v = window.__dd_view; const l = v.state.doc.line(2); v.dispatch({ selection: { anchor: l.from + 2 } }); return "ok" })()')
Start-Sleep -Milliseconds 300
$BOLD = "(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').indexOf('加粗') === 0); if (!b) return 'no'; b.click(); return 'ok' })()"
$bold = Eval $BOLD
Start-Sleep -Milliseconds 600
Check '点「加粗」插入了 **粗体**' ($bold -eq 'ok' -and [bool](Eval $HAS_BOLD)) "bold=$bold"

# 只看"光标这一行"的开头，别去比整篇（整篇里本来就有 ## 判据）
$LINE_HEAD = '(() => { const v = window.__dd_view; if (!v) return "no-view"; const n = v.state.doc.lineAt(v.state.selection.main.head).number; return v.state.doc.line(n).text.slice(0, 4) })()'
# 找个非空、非标题的行，点「标题级别」→ 选「一级标题」
$SET_LINE = '(() => { const v = window.__dd_view; const lines = v.state.doc.toString().split("\n"); const idx = lines.findIndex((l, i) => i > 0 && l.trim() && !l.startsWith("#") && !l.startsWith("|")); if (idx < 0) return "none"; v.dispatch({ selection: { anchor: v.state.doc.line(idx + 1).from } }); return String(idx + 1) })()'
$lineNo = [string](Eval $SET_LINE)
Start-Sleep -Milliseconds 400
[void](Eval "($CLICK_MODE)('标题级别')")
Start-Sleep -Milliseconds 400
$pickLevel = [string](Eval "((t) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').indexOf(t) === 0); if (!b) return 'no'; b.click(); return 'ok' })('一级标题')")
Start-Sleep -Milliseconds 500

$AFTER = '(() => { const v = window.__dd_view; const p = v.state.selection.main.head; const l = v.state.doc.lineAt(p); return JSON.stringify({ off: p - l.from, text: l.text.slice(0, 4) }) })()'
$after = [string](Eval $AFTER)
"  行 $lineNo → $after  pick=$pickLevel"
Check '选「一级标题」后行首是 # 且光标在其后' ($pickLevel -eq 'ok' -and $after.Contains('"off":2') -and $after.Contains('# ')) "after=$after"

# 已是该级别再点一次：应当去掉标题
[void](Eval "($CLICK_MODE)('标题级别')")
Start-Sleep -Milliseconds 300
[void](Eval "((t) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').indexOf(t) === 0); if (!b) return 'no'; b.click(); return 'ok' })('正文')")
Start-Sleep -Milliseconds 500
$plain = [string](Eval '(() => { const v = window.__dd_view; const p = v.state.selection.main.head; return v.state.doc.lineAt(p).text.slice(0, 4) })()')
"  选正文后：$plain"
Check '选「正文」后标题被去掉' (-not $plain.StartsWith('# ')) "text=$plain"
"工具条居中与收起"
$CENTER = '(() => { const c = document.querySelector("[data-bar=card]"); if (!c) return "no-card"; const pane = c.closest("main") || c.parentElement; const a = c.getBoundingClientRect(); const b = pane.getBoundingClientRect(); return Math.round((a.left + a.width / 2) - (b.left + b.width / 2)) })()'
$off = Eval $CENTER
Check '工具条水平居中（偏差 ≤2px）' ([Math]::Abs([int]$off) -le 2) "偏差=$off"
Shot 'bar-open.png'

$collapse = [string](Eval "($CLICK_MODE)('收起格式工具条')")
Start-Sleep -Milliseconds 500
$pill = Eval 'document.querySelectorAll("[data-bar=pill]").length'
Check '点收起后只剩小胶囊' ($collapse -eq 'ok' -and [int]$pill -eq 1) "collapse=$collapse pill=$pill"
Shot 'bar-collapsed.png'

$expand = [string](Eval "($CLICK_MODE)('展开格式工具条')")
Start-Sleep -Milliseconds 500
$card = Eval 'document.querySelectorAll("[data-bar=card]").length'
Check '点胶囊能再展开' ($expand -eq 'ok' -and [int]$card -eq 1) "expand=$expand card=$card"
"划掉"
[void](Eval '(() => { const v = window.__dd_view; v.dispatch({ selection: { anchor: v.state.doc.line(2).from } }); return "ok" })()')
Start-Sleep -Milliseconds 300
$STRIKE = [string](Eval "($CLICK_MODE)('划掉')")
Start-Sleep -Milliseconds 500
$hasStrike = [bool](Eval '(() => window.__dd_view.state.doc.toString().indexOf("~~删除~~") >= 0)()')
Check '点「划掉」插入了 ~~删除~~' ($STRIKE -eq 'ok' -and $hasStrike) "strike=$STRIKE"

[void](Eval "($CLICK_MODE)('阅读')")
Start-Sleep -Milliseconds 800
$del = Eval 'document.querySelectorAll("del").length'
Check '阅读模式里划掉渲染成 <del>' ([int]$del -ge 1) "del=$del"
[void](Eval "($CLICK_MODE)('编写')")
Start-Sleep -Milliseconds 600
"表格与数学"
$TB = "(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === '插入表格'); if (!b) return 'no'; b.click(); return 'ok' })()"
$tb = Eval $TB
Start-Sleep -Milliseconds 500
$pickSize = [string](Eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === '2 行 3 列'); if (!b) return 'no'; b.click(); return 'ok' })()")
Start-Sleep -Milliseconds 600
$HAS_TABLE_SRC = '(() => { const v = window.__dd_view; return v ? v.state.doc.toString().indexOf("| --- | --- |") >= 0 : false })()'
Check '插入表格：选 2 行 3 列后落进正文' ($tb -eq 'ok' -and $pickSize -eq 'ok' -and [bool](Eval $HAS_TABLE_SRC)) "tb=$tb pick=$pickSize"

[void](Eval "($CLICK_MODE)('阅读')")
Start-Sleep -Milliseconds 900
Check '阅读模式里表格渲染成 <table>' ([bool](Eval 'document.querySelectorAll("table").length > 0')) ''

[void](Eval "($CLICK_MODE)('编写')")
Start-Sleep -Milliseconds 800
$MATH = "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '行内公式'); if (!b) return 'no'; b.click(); return 'ok' })()"
[void](Eval $MATH)
Start-Sleep -Milliseconds 600
[void](Eval "($CLICK_MODE)('阅读')")
Start-Sleep -Milliseconds 1500
$katex = Eval 'document.querySelectorAll(".katex").length'
Check '阅读模式里公式渲染出 KaTeX' ([int]$katex -gt 0) "katex=$katex"

""
# 干净地拍一张：重新载入 → 打开那篇"表格与公式" → 切阅读 → 截图
[void](Send-Cdp 'Page.navigate' @{ url = 'http://localhost:5183/?vault=memory' })
Start-Sleep -Milliseconds 2800
[void](Eval "($CLICK)('开始这里.md')")
Start-Sleep -Milliseconds 900
[void](Eval "($CLICK_MODE)('阅读')")
Start-Sleep -Milliseconds 1800
[void](Send-Cdp 'Page.enable' @{})
$shot = Send-Cdp 'Page.captureScreenshot' @{ format = 'png' }
if ($shot.result.data) {
  $out = Join-Path (Get-Location) 'assets\shots\math.png'
  [IO.File]::WriteAllBytes($out, [Convert]::FromBase64String($shot.result.data))
  "截图：$out"
}

""
if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }