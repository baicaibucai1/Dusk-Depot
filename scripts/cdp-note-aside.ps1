# 验 .note 的右栏 + 块宽拖动
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddnb2-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1500,950', 'http://localhost:5183/?vault=memory'
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
    $buf = [byte[]]::new(1048576)
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
  if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.exception.description }
  return $r.result.result.value
}
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png' }
  if ($r.result.data) {
    [IO.File]::WriteAllBytes((Join-Path (Get-Location) "assets\shots\$name"), [Convert]::FromBase64String($r.result.data))
    "截图：assets\shots\$name"
  }
}
$fails = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "  ✓ $name" } else { "  ✗ $name  $detail"; $script:fails += $name }
}

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Eval "(() => { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(e.message)); return 1 })()")

"① 块笔记也要有右栏"
[void](Eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '示例-块笔记.note'); if (b) b.click(); return 1 })()")
Start-Sleep -Milliseconds 2600
$aside = [int](Eval 'document.querySelectorAll("aside").length')
Check '打开 .note 时右栏在' ($aside -eq 1) "aside=$aside"

"② 右栏大纲是块的标题"
$outline = [string](Eval '(() => { const a = document.querySelector("aside"); if (!a) return "none"; return [...a.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean).join("/") })()')
"  右栏按钮文字：$outline"
Check '.note 大纲列出了块标题' ($outline -like '*块笔记*') "outline=$outline"

"③ 关系面板"
[void](Eval '(() => { const a = document.querySelector("aside"); if (!a) return "none"; const bs = [...a.querySelectorAll("button")]; if (bs[1]) bs[1].click(); return "ok" })()')
Start-Sleep -Milliseconds 700
$rel = [string](Eval '(() => { const a = document.querySelector("aside"); return a ? a.innerText.replace(/\s+/g, " ").slice(0, 200) : "none" })()')
"  关系面板：$rel"
Check '关系面板有内容' ($rel.Length -gt 20 -and $rel -notlike '*none*') "rel=$rel"
Shot 'note-aside.png'

"④ 拖块的右边缘改宽度（自由排版：改 layout.w）"
[void](Eval '(() => { const a = document.querySelector("aside"); if (!a) return "none"; const bs = [...a.querySelectorAll("button")]; if (bs[0]) bs[0].click(); return "ok" })()')
Start-Sleep -Milliseconds 400
$before = [string](Eval "(() => { const raw = localStorage.getItem('dusk.memory.repo.v2'); const f = JSON.parse(raw).files; const c = document.querySelectorAll('.dd-note-card')[1]; const b = JSON.parse(f['示例-块笔记.note/blocks/' + c.dataset.blockId + '.json'] || '{}'); return String(b.layout ? b.layout.w : 'none') })()")
"  拖前 layout.w = $before"
$dragJs = @'
(() => {
  const c = document.querySelectorAll('.dd-note-card')[1]
  const h = c.querySelector('.dd-note-resize')
  if (!h) return 'no-handle'
  const r = h.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  const opts = (cx) => ({ bubbles: true, cancelable: true, clientX: cx, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'mouse', buttons: 1 })
  h.dispatchEvent(new PointerEvent('pointerdown', opts(x)))
  window.dispatchEvent(new PointerEvent('pointermove', opts(x - 150)))
  window.dispatchEvent(new PointerEvent('pointerup', opts(x - 150)))
  return 'ok'
})()
'@
$drag = [string](Eval $dragJs)
Start-Sleep -Milliseconds 1200
$after = [string](Eval "(() => { const raw = localStorage.getItem('dusk.memory.repo.v2'); const f = JSON.parse(raw).files; const c = document.querySelectorAll('.dd-note-card')[1]; const b = JSON.parse(f['示例-块笔记.note/blocks/' + c.dataset.blockId + '.json'] || '{}'); return String(b.layout ? b.layout.w : 'none') })()")
"  拖后 layout.w = $after（drag=$drag）"
Check '拖右边缘把 layout.w 改小了' ($drag -eq 'ok' -and [double]$after -lt [double]$before) "before=$before after=$after"
Shot 'note-width.png'

"  错误：" + [string](Eval 'JSON.stringify((window.__errs || []).slice(0, 5))')
""
if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
