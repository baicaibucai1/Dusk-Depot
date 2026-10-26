# 验双击跳转：读模式里双击 [[双链]] → 切到那篇。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddjump-' + [guid]::NewGuid().ToString('N'))
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

[void](Eval "($CLICK_FILE)('示例-链接.md')")
Start-Sleep -Milliseconds 1000
[void](Eval "($CLICK_ARIA)('阅读')")
Start-Sleep -Milliseconds 1200

$before = [string](Eval '(() => { const m = document.querySelector("main"); return m ? m.dataset.activePath : "none" })()')
"当前：$before"

$links = Eval 'document.querySelectorAll("[data-dd-doc] [title*=''双击打开'']").length'
Check '读模式里双链带上了"双击打开"提示' ([int]$links -ge 1) "links=$links"

$dbl = [string](Eval @'
(() => {
  const nodes = [...document.querySelectorAll("[data-dd-doc] [title*='双击打开']")]
  const el = nodes.find((n) => (n.textContent || "").indexOf("开始这里") >= 0)
  if (!el) return "no-link"
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))
  return "ok"
})()
'@)
Start-Sleep -Milliseconds 1200
$after = [string](Eval '(() => { const m = document.querySelector("main"); return m ? m.dataset.activePath : "none" })()')
"跳转后：$after  dbl=$dbl"
Check '双击双链跳到了那一篇' ($dbl -eq 'ok' -and $after -like '*开始这里.md') "before=$before after=$after"
Shot 'jump.png'

# 悬空双链（[[草稿]]）：应该**建出来**再跳过去
[void](Eval "($CLICK_FILE)('示例-链接.md')")
Start-Sleep -Milliseconds 900
[void](Eval "($CLICK_ARIA)('阅读')")
Start-Sleep -Milliseconds 900
$doc1 = [string](Eval '(() => { const m = document.querySelector("main"); return m ? m.dataset.activePath : "none" })()')
"  跳转前：$doc1"

$dbl2 = [string](Eval @'
(() => {
  const nodes = [...document.querySelectorAll("[data-dd-doc] [title*='双击打开']")]
  const el = nodes.find((n) => (n.textContent || "").indexOf("草稿") >= 0)
  if (!el) return "no-link"
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }))
  return "ok"
})()
'@)
Start-Sleep -Milliseconds 1200

$doc2 = [string](Eval '(() => { const m = document.querySelector("main"); return m ? m.dataset.activePath : "none" })()')
$body = [string](Eval '(() => { const a = document.querySelector("[data-dd-doc]"); return a ? a.textContent.trim().slice(0, 10) : "none" })()')
$inTree = [bool](Eval '(() => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "草稿.md"))()')
"  跳转后：$doc2  正文开头：$body  树里有：$inTree"
Check '双击悬空双链会新建那篇并打开' ($dbl2 -eq 'ok' -and $doc2 -like '*草稿.md') "dbl=$dbl2 after=$doc2"
Check '新建的笔记正文带标题' ($body -like '*草稿*') "body=$body"
Check '新建的笔记出现在左栏树里' $inTree ''
Shot 'jump-create.png'

""
if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
