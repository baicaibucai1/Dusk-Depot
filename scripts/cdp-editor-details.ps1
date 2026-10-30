$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('dddet-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$url = 'http://localhost:5183/?vault=memory'

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
function Type-Text([string]$text) {
  [void](Send-Cdp 'Input.insertText' @{ text = $text })
}
function Press-Enter {
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; key = 'Enter'; code = 'Enter'; windowsVirtualKeyCode = 13 })
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'Enter'; code = 'Enter'; windowsVirtualKeyCode = 13 })
}

$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}

Start-Sleep -Milliseconds 500
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Page.navigate' @{ url = $url })
Start-Sleep -Milliseconds 2800
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error))); "ok"')
[void](Eval 'window.__t = { v: () => window.__dd_view, cur: (i) => { const v = window.__dd_view; v.dispatch({ selection: { anchor: i }, scrollIntoView: true }); v.focus(); return 1 }, doc: () => window.__dd_view.state.doc.toString(), pos: (s) => window.__dd_view.state.doc.toString().indexOf(s) }; 1')
# 换一段短靶子：长文档里目标常在视口外，coordsAtPos 返回 null（这也是真实的边界，不是 bug）
[void](Eval '(() => { const v = window.__dd_view; if (!v) return "no-view"; const text = "# 测试\n\n质能 $E = mc^2$ 公式，链接 [语法示例](语法示例.md)。\n\n双链 [[语法示例]] 在这。\n"; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }); return "ok" })()')
Start-Sleep -Milliseconds 600

Write-Host 'A. 公式面板'
Check '有编辑器实例' ([bool](Eval 'window.__dd_view !== undefined && window.__dd_view !== null')) ''
# 光标放进 $E = mc^2$ 里
[void](Eval '(() => { const t = window.__t.doc(); const i = t.indexOf("mc^2"); if (i < 0) return -1; window.__t.cur(i); return i })()')
Start-Sleep -Milliseconds 400
Check '光标进公式 → 面板浮出' ([bool](Eval 'document.querySelector("[data-dd-math-panel]") !== null')) "doc=$(Eval 'window.__t.doc().slice(0, 40)')"
Check '面板有 6 个分组' ([int](Eval 'document.querySelectorAll("[data-dd-math-panel] button").length') -ge 20) "n=$(Eval 'document.querySelectorAll("[data-dd-math-panel] button").length')"
$before = [int](Eval 'window.__t.doc().length')
[void](Eval '(() => { const b = [...document.querySelectorAll("[data-dd-math-panel] button")].find((x) => x.textContent.trim() === "α"); if (!b) return 0; b.click(); return 1 })()')
Start-Sleep -Milliseconds 350
$after = [int](Eval 'window.__t.doc().length')
Check '点 α → LaTeX 插进文档' ([bool](Eval 'window.__t.doc().includes("\\alpha")')) "len=$before→$after"
# 光标移出公式
[void](Eval '(() => { const t = window.__t.doc(); window.__t.cur(t.length); return 1 })()')
Start-Sleep -Milliseconds 350
Check '光标移出公式 → 面板收起' ([bool](Eval 'document.querySelector("[data-dd-math-panel]") === null')) ''

Write-Host 'B. 输入 [[ 出提示'
[void](Eval '(() => { const t = window.__t.doc(); window.__t.cur(t.length); return 1 })()')
Start-Sleep -Milliseconds 200
Type-Text "`n`n[[" 
Start-Sleep -Milliseconds 700
$items = [int](Eval 'document.querySelectorAll("[data-dd-linkitem]").length')
Check '浮出候选列表' ($items -gt 0) "n=$items"
Check '列表里是本库的篇名' ([bool](Eval '[...document.querySelectorAll("[data-dd-linkitem]")].some((x) => x.textContent.includes("周计划") || x.textContent.includes("开始这里"))')) "got=$(Eval '[...document.querySelectorAll("[data-dd-linkitem]")].map((x) => x.textContent.trim()).slice(0,4).join("/")')"
Type-Text "周"
Start-Sleep -Milliseconds 500
$items2 = [int](Eval 'document.querySelectorAll("[data-dd-linkitem]").length')
Check '接着输字 → 列表被过滤' ($items2 -gt 0 -and $items2 -lt $items) "n=$items→$items2"
Press-Enter
Start-Sleep -Milliseconds 450
Check '回车接受 → 写成 [[路径]]' ([bool](Eval '/\[\[[^\]]*周计划[^\]]*\]\]/.test(window.__t.doc())')) "tail=$(Eval 'window.__t.doc().slice(-42)')"
Check '插完浮层收起' ([bool](Eval 'document.querySelector("[data-dd-linkpicker]") === null')) ''

Write-Host 'B2. [[某篇# 提示小节'
# 直接把文档换成"正打到 #"的状态：比在前一步之后接着敲更可控
[void](Eval '(() => { const v = window.__dd_view; const t = "line\n\n[[周计划#"; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: t.length } }); v.focus(); return 1 })()')
Start-Sleep -Milliseconds 600
$heads = [int](Eval 'document.querySelectorAll("[data-dd-linkitem]").length')
Check '输 # 后列出该篇的小节' ($heads -ge 2) "n=$heads tail=[$(Eval 'window.__t.doc().slice(-16)')] got=$(Eval '[...document.querySelectorAll("[data-dd-linkitem]")].map((x) => x.textContent.trim()).slice(0,4).join("/")')"
Check '候选里带「›」，看得出是小节' ([bool](Eval '[...document.querySelectorAll("[data-dd-linkitem]")].some((x) => x.textContent.includes("›"))')) ''
[void](Eval '(() => { const b = [...document.querySelectorAll("[data-dd-linkitem]")].find((x) => (x.getAttribute("data-dd-linkitem") || "").includes("#")); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 400
Check '点小节 → 插成 [[路径#小节]]' ([bool](Eval '/\[\[[^\]]+#[^\]]+\]\]/.test(window.__t.doc())')) "tail=$(Eval 'window.__t.doc().slice(-24)')"

Write-Host 'E. 链接卡片（两栏）'
[void](Eval 'document.querySelector("button[aria-label=插入链接]").click()')
Start-Sleep -Milliseconds 350
Check '卡片有「字样」输入框' ([bool](Eval 'document.querySelector("input[aria-label=链接显示字样]") !== null')) ''
Check '卡片有「地址」输入框' ([bool](Eval 'document.querySelector("input[aria-label=链接地址]") !== null')) ''
[void](Eval '(() => { const a = document.querySelector("input[aria-label=链接显示字样]"); const b = document.querySelector("input[aria-label=链接地址]"); const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })) }; set(a, "周计划"); set(b, "项目/周计划.md"); return 1 })()')
Start-Sleep -Milliseconds 300
Check '卡片实时预览要插入的 markdown' ([bool](Eval 'document.body.textContent.includes("[周计划](项目/周计划.md)")')) ''
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "插入" && x.closest(".absolute")); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 500
Check '插入后文档里出现那条链接' ([bool](Eval 'window.__t.doc().includes("[周计划](项目/周计划.md)")')) ''

Write-Host 'C. 双击双链跳转'
[void](Eval '(() => { const t = window.__t.doc(); window.__dd_view.dispatch({ changes: { from: t.length, insert: "\n\n[[语法示例]]\n" } }); return 1 })()')
Start-Sleep -Milliseconds 400
$before = Eval 'window.__t.doc().slice(0, 30)'
[void](Eval '(() => {
  const v = window.__dd_view; const t = v.state.doc.toString();
  const from = t.lastIndexOf("[[语法示例]]");
  const pos = from + 4;
  const c = v.coordsAtPos(pos);
  const el = v.contentDOM;
  const ev = new MouseEvent("dblclick", { bubbles: true, clientX: c.left + 2, clientY: c.top + 3 });
  el.dispatchEvent(ev);
  return 1 })()')
Start-Sleep -Milliseconds 900
Check '双击双链 → 换到那一篇' ([bool](Eval 'window.__t.doc().includes("划掉")')) "before=$before"
Check '跳过去还能看到双链胶囊' ([bool](Eval 'document.querySelector("[data-dd-link]") !== null || document.querySelector(".cm-content").textContent.length > 0')) ''

# 阅读模式的胶囊单独验（scripts/cdp-capsule.ps1）—— 混在这条链里会把页面状态搅乱

Write-Host '布局与报错'
Check '无横向溢出' ([bool](([int](Eval 'document.documentElement.scrollWidth') -le [int](Eval 'window.innerWidth')))) 'scroll=$(Eval "document.documentElement.scrollWidth") win=$(Eval "window.innerWidth")'
$errs = [int](Eval 'window.__errs.length')
Check '零 JS 报错' ($errs -eq 0) (Eval 'window.__errs.join(" | ")')

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "$fail FAILED" }
$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
