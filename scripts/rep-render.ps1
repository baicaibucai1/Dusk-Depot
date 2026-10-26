$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddrep-' + [guid]::NewGuid().ToString('N'))
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
$CLICK = "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if (!b) return 'no'; b.click(); return 'ok' })"
$ARIA = "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === n); if (!b) return 'no'; b.click(); return 'ok' })"

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Eval "($CLICK)('开始这里.md')")
Start-Sleep -Milliseconds 1500

"=== 编写模式 ==="
"斜体行文字：" + [string](Eval "(() => { const ls = [...document.querySelectorAll('.cm-line')]; const hit = ls.find((l) => (l.textContent || '').includes('斜体')); return hit ? hit.textContent : 'none' })()")
"斜体行 DOM：" + [string](Eval "(() => { const ls = [...document.querySelectorAll('.cm-line')]; const hit = ls.find((l) => (l.textContent || '').includes('斜体')); return hit ? hit.innerHTML.slice(0, 400) : 'none' })()")
"图片行 DOM：" + [string](Eval "(() => { const imgs = [...document.querySelectorAll('img.dd-img')]; return imgs.length ? 'widget=' + imgs.length + ' src=' + (imgs[0].getAttribute('src') || '').slice(0, 40) : 'no-widget' })()")
"图片行残留 ! ：" + [string](Eval "(() => { const ls = [...document.querySelectorAll('.cm-line')]; const hit = ls.find((l) => (l.textContent || '').includes('![')); return hit ? hit.textContent.slice(0, 60) : 'none' })()")
$scroll = [string](Eval "(() => { const hit = [...document.querySelectorAll('.cm-line')].find((l) => (l.textContent || '').includes('示例图')); if (!hit) return 'none'; hit.scrollIntoView({ block: 'center' }); return 'ok' })()")
Start-Sleep -Milliseconds 400
Shot 'rep-write.png'

[void](Eval "($ARIA)('阅读')")
Start-Sleep -Milliseconds 1500
"=== 阅读模式 ==="
"图片处 DOM：" + [string](Eval "(() => { const doc = document.querySelector('[data-dd-doc]'); if (!doc) return 'no doc'; const hit = [...doc.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').includes('示例图')); return hit ? hit.parentElement.outerHTML.slice(0, 300) : 'none' })()")
"列表处 DOM：" + [string](Eval "(() => { const doc = document.querySelector('[data-dd-doc]'); if (!doc) return 'no doc'; const hit = [...doc.querySelectorAll('strong')].find((el) => (el.textContent || '').includes('开始这里.md')); return hit ? hit.outerHTML.slice(0, 200) : 'none' })()")
"图片数：" + [string](Eval "document.querySelectorAll('[data-dd-doc] img').length")
Shot 'rep-read.png'

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
