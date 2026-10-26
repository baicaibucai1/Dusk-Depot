# 验标准链接：插入 → 写成 [标题](路径) → 读模式双击跳转 → 反链认它。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddlink-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800

Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400

$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1200,900', 'http://localhost:5183/?vault=memory'
)
for ($i = 0; $i -lt 40; $i++) {
  try {
    $list = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2
    $page = $list | Where-Object { $_.type -eq 'page' -and $_.url -like '*localhost:5183*' } | Select-Object -First 1
    if ($page) { break }
  } catch { }
  Start-Sleep -Milliseconds 400
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
    $buf = [byte[]]::new(524288)
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
  if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.text }
  return $r.result.result.value
}
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png' }
  if ($r.result.data) {
    $out = Join-Path (Get-Location) "assets\shots\$name"
    [IO.File]::WriteAllBytes($out, [Convert]::FromBase64String($r.result.data))
    "截图：$out"
  }
}
$fails = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "  ✓ $name" } else { "  ✗ $name  $detail"; $script:fails += $name }
}

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

$CLICK_FILE = "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if (!b) return 'no'; b.click(); return 'ok' })"
$CLICK_ARIA = "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === n); if (!b) return 'no'; b.click(); return 'ok' })"

[void](Eval "($CLICK_FILE)('开始这里.md')")
Start-Sleep -Milliseconds 1200

"插入链接"
$open = [string](Eval "($CLICK_ARIA)('插入链接')")
Start-Sleep -Milliseconds 500
$rows = Eval 'document.querySelectorAll("[aria-label=''搜索要链接的笔记''] ~ div button").length'
Check '点「插入链接」弹出笔记清单' ($open -eq 'ok' -and [int]$rows -ge 1) "open=$open rows=$rows"
Shot 'link-picker.png'

$pick = [string](Eval @'
(() => {
  const panel = document.querySelector("[aria-label='搜索要链接的笔记']")
  if (!panel) return "no-panel"
  const btns = [...panel.parentElement.querySelectorAll("button")]
  const hit = btns.find((b) => (b.textContent || "").indexOf("开始这里") >= 0)
  if (!hit) return "no-item"
  hit.click()
  return "ok"
})()
'@)
Start-Sleep -Milliseconds 600

$doc = [string](Eval '(() => window.__dd_view.state.doc.toString())()')
"  正文片段：" + $doc.Substring(0, [Math]::Min(90, $doc.Length)).Replace("`n", "⏎")
Check '插入的是标准 markdown 链接' ($pick -eq 'ok' -and $doc -match '\[开始这里\]\(开始这里\.md\)') "pick=$pick"

[void](Eval "($CLICK_ARIA)('阅读')")
Start-Sleep -Milliseconds 1200

$before = [string](Eval '(() => { const m = document.querySelector("main"); return m ? m.dataset.activePath : "none" })()')
$dbl = [string](Eval @'
(() => {
  const a = [...document.querySelectorAll("[data-dd-doc] a[role=link]")].find((x) => (x.textContent || "").indexOf("开始这里") >= 0)
  if (!a) return "no-link"
  a.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))
  return "ok"
})()
'@)
Start-Sleep -Milliseconds 1200
$after = [string](Eval '(() => { const m = document.querySelector("main"); return m ? m.dataset.activePath : "none" })()')
"  跳转：$before → $after"
Check '双击标准链接跳到那一篇' ($dbl -eq 'ok' -and $after -like '*开始这里.md') "dbl=$dbl after=$after"
Shot 'link-jump.png'

"块笔记链接"
[void](Eval "($CLICK_FILE)('示例-链接.md')")
Start-Sleep -Milliseconds 900
[void](Eval "($CLICK_ARIA)('阅读')")
Start-Sleep -Milliseconds 1000
$noteDbl = [string](Eval @'
(() => {
  const a = [...document.querySelectorAll("[data-dd-doc] a[role=link]")].find((x) => (x.textContent || "").indexOf("块笔记") >= 0)
  if (!a) return "no-link"
  a.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))
  return "ok"
})()
'@)
Start-Sleep -Milliseconds 1200
$noteAfter = [string](Eval '(() => { const m = document.querySelector("main"); return m ? m.dataset.activePath : "none" })()')
"  双击后：$noteAfter"
Check '双击标准链接能打开 .note 块笔记' ($noteDbl -eq 'ok' -and $noteAfter -like '*示例-块笔记.note') "dbl=$noteDbl after=$noteAfter"

""
if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
