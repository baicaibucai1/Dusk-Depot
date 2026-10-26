# 验 2026-10 补强的 markdown 语法：有序/任务列表、分割线、表格对齐、
# 自动链接、硬换行、转义、$数学$ 守卫 —— 阅读模式和编写模式都过一遍。
# 断言读的是渲染后的 DOM，不是源码字符串。

$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddmd-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800

Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1400,900', 'about:blank'
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
function Key([int]$vk, [string]$key, [int]$mods) {
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; key = $key; code = $key; windowsVirtualKeyCode = $vk; nativeVirtualKeyCode = $vk; modifiers = $mods })
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $key; code = $key; windowsVirtualKeyCode = $vk; nativeVirtualKeyCode = $vk; modifiers = $mods })
}

$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}

Start-Sleep -Milliseconds 1500
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

# 错误收集装在导航前：语法再怪也不能炸
$PROBE = @'
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || String(e.error))));
'@
[void](Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = $PROBE })
[void](Send-Cdp 'Page.navigate' @{ url = 'http://localhost:5183/?vault=memory' })
Start-Sleep -Milliseconds 4000
# 探针双保险：导航前装的管整页生命周期，这里再补一次，保证断言拿得到
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push("error: " + (e.message || String(e.error))))')

# ── 把一篇新语法大全写进编辑器 ─────────────────────────────
# 点进正文 → Ctrl+A 全选 → 整篇替换成测试文档（末尾留个空行，光标不落在列表行上）
$doc = @'
1. 有序一
2. 有序二

- [ ] 未做项
- [x] 已做项

---

| 甲 | 乙 | 丙 |
| :-- | :-: | --: |
| 1 | 2 | 3 |

见 https://example.com。好吧

省 $5 到 $10 块

硬换行甲\
硬换线乙

\*不是斜体\*


'@
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = 400; y = 400; button = 'left'; clickCount = 1 })
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = 400; y = 400; button = 'left'; clickCount = 1 })
Start-Sleep -Milliseconds 300
Key 65 'a' 2
[void](Send-Cdp 'Input.insertText' @{ text = $doc })
Start-Sleep -Milliseconds 1000

# ── 编写模式（实时预览）的断言 ─────────────────────────────
Write-Host '── 编写模式（实时预览）──'
Check '有序号换成 .dd-num widget' ([int](Eval 'document.querySelectorAll(".dd-num").length') -eq 2) "num=$(Eval 'document.querySelectorAll(".dd-num").length')"
Check '任务记号换成 .dd-check 方框' ([int](Eval 'document.querySelectorAll(".dd-check").length') -eq 2) "check=$(Eval 'document.querySelectorAll(".dd-check").length')"
Check '已做项是打勾的' ([int](Eval 'document.querySelectorAll(".dd-check-on").length') -eq 1) "on=$(Eval 'document.querySelectorAll(".dd-check-on").length')"
Check '分割行换成块 widget（不露 --- 原文）' ([int](Eval 'document.querySelectorAll(".dd-block-hr").length') -eq 1) "hr=$(Eval 'document.querySelectorAll(".dd-block-hr").length')"
Check '裸 URL 染成链接色' ([int](Eval '[...document.querySelectorAll(".dd-link")].filter((a) => a.textContent.indexOf("example.com") >= 0).length') -ge 1) ''
Check '$5 到 $10 没被渲染成公式' ([int](Eval 'document.querySelectorAll(".katex").length') -eq 0) "katex=$(Eval 'document.querySelectorAll(".katex").length')"
Check '转义的星号不渲染成斜体' ([bool](Eval 'document.querySelector("em") === null || document.querySelector("em").textContent.indexOf("不是斜体") < 0')) ''
$errs1 = Eval 'window.__errs.length'
Check '页面没有报错' ("$errs1" -eq '0') "errs=$errs1 $(Eval 'window.__errs.join(" | ")')"

# ── 切到阅读模式 ──────────────────────────────────────────
Write-Host '（切阅读模式）'
try {
  $switched = Eval "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === n); if (!b) return 'no-button'; b.click(); return 'ok' })('阅读')"
  Write-Host "切换结果: $switched"
} catch {
  Write-Host "切换炸了: $_"
}
Start-Sleep -Milliseconds 800

Write-Host '── 阅读模式 ──'
Check '有序列表渲染出序号' ([int](Eval 'document.querySelectorAll("[data-dd-li=ordered]").length') -eq 2) "n=$(Eval 'document.querySelectorAll("[data-dd-li=ordered]").length')"
Check '第二个序号是 2（不重新编号）' ((Eval '[...document.querySelectorAll("[data-dd-num]")].map((s) => s.textContent).join(",")') -eq '1.,2.') "got=$(Eval '[...document.querySelectorAll("[data-dd-num]")].map((s) => s.textContent).join(",")')"
Check '任务列表渲染出两个框' ([int](Eval 'document.querySelectorAll("[data-dd-li=task]").length') -eq 2) "n=$(Eval 'document.querySelectorAll("[data-dd-li=task]").length')"
Check '已做项 aria-checked=true' ((Eval 'document.querySelector("[data-dd-checked=true] [role=checkbox]").getAttribute("aria-checked")') -eq 'true') ''
Check '分割线渲染成 <hr>' ([int](Eval 'document.querySelectorAll("[data-dd-doc] hr").length') -eq 1) "n=$(Eval 'document.querySelectorAll("[data-dd-doc] hr").length')"
Check '表格列对齐生效（左/中/右）' ((Eval '[...document.querySelectorAll("[data-dd-doc] th")].map((t) => t.style.textAlign).join(",")') -eq 'left,center,right') "got=$(Eval '[...document.querySelectorAll("[data-dd-doc] th")].map((t) => t.style.textAlign).join(",")')"
Check '裸 URL 渲染成 <a>' ([int](Eval '[...document.querySelectorAll("[data-dd-doc] a")].filter((a) => a.getAttribute("href") === "https://example.com").length') -eq 1) ''
Check 'URL 尾巴的中文句号没进链接' ([bool](Eval '[...document.querySelectorAll("[data-dd-doc] a")].every((a) => a.textContent.indexOf(String.fromCharCode(12290)) < 0')) ''
Check '$5 到 $10 是纯文本' ([bool](Eval '[...document.querySelectorAll("[data-dd-doc] p")].some((p) => p.textContent.indexOf("省 $5 到 $10") >= 0')) ''
Check '硬换行渲染出 <br>' ([int](Eval 'document.querySelectorAll("[data-dd-doc] p br").length') -eq 1) "n=$(Eval 'document.querySelectorAll("[data-dd-doc] p br").length')"
Check '转义星号原样显示' ([bool](Eval '[...document.querySelectorAll("[data-dd-doc] p")].some((p) => p.textContent.indexOf("*" + String.fromCharCode(19981) + String.fromCharCode(26159) + "*") >= 0')) ''
$errs2 = Eval 'window.__errs.length'
Check '阅读模式没有页面错误' ("$errs2" -eq '0') "errs=$errs2 $(Eval 'window.__errs.join(" | ")')"

# ── 点任务框：勾态写回源文件 ─────────────────────────────
[void](Eval "document.querySelector('[data-dd-checked=false] [role=checkbox]').click()")
Start-Sleep -Milliseconds 500
Check '点未做项 → 变成已做' ((Eval 'document.querySelectorAll("[data-dd-checked=true]").length') -eq 2) "n=$(Eval 'document.querySelectorAll("[data-dd-checked=true]").length')"
[void](Eval "document.querySelector('[data-dd-checked=true] [role=checkbox]').click()")
Start-Sleep -Milliseconds 500
Check '再点一次 → 回到未做' ((Eval 'document.querySelectorAll("[data-dd-checked=true]").length') -eq 1) "n=$(Eval 'document.querySelectorAll("[data-dd-checked=true]").length')"

# 截图留底
$shot = Send-Cdp 'Page.captureScreenshot' @{ format = 'png' }
if ($shot.result.data) {
  $out = Join-Path $PSScriptRoot '..\assets\shots\cdp-md-gfm.png'
  $dir = Split-Path $out -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [IO.File]::WriteAllBytes($out, [Convert]::FromBase64String($shot.result.data))
}

Write-Host ''
if ($script:fail -eq 0) { Write-Host 'cdp-md-gfm: 全部通过' }
else { Write-Host "cdp-md-gfm: $script:fail 条没过"; exit 1 }
