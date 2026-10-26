# 调试用：把页面当前状态吐出来（正文文字、根节点是否为空、Vite 报错浮层）
param([string]$Url = 'http://localhost:5183/?vault=memory')

$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('dddump-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800

Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400

$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--user-data-dir=$profile", "--remote-debugging-port=$port", '--window-size=1400,900', $Url
)

for ($i = 0; $i -lt 40; $i++) {
  try {
    $list = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2
    $page = $list | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
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
  if ($r.result.exceptionDetails) { return 'EXCEPTION: ' + $r.result.exceptionDetails.text }
  return $r.result.result.value
}

Start-Sleep -Milliseconds 1500
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Page.enable' @{})

# 先装探针，再重新载入 —— 这样才抓得到首屏渲染抛的错
$PROBE = @'
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || String(e.error))));
window.addEventListener('unhandledrejection', (e) => window.__errs.push('reject: ' + String(e.reason)));
const _ce = console.error;
console.error = (...a) => { window.__errs.push('console: ' + a.map((x) => String(x && x.stack ? x.stack : x)).join(' ')); _ce(...a); };
'@
[void](Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = $PROBE })
[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 4000

"--- 抓到的错误 ---"
Eval '(() => { try { return (window.__errs || []).join("\n").slice(0, 2500) } catch (e) { return "n/a" } })()'

"--- body 文本 ---"
Eval 'document.body.innerText.slice(0, 600)'
"--- 根节点 HTML 长度 ---"
Eval '(() => { const r = document.querySelector("#root"); return r ? r.innerHTML.length : "no-root" })()'
"--- Vite / 报错浮层 ---"
Eval '(() => { const o = document.querySelector("vite-error-overlay"); return o ? (o.shadowRoot ? o.shadowRoot.textContent.slice(0, 800) : "overlay") : "none" })()'
"--- 控制台里的错误（window.__err） ---"
Eval '(() => { try { return String(window.__err || "") } catch (e) { return "n/a" } })()'

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
