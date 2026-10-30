$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddcap-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$url = 'http://localhost:5183/?vault=memory&mode=read'

$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--user-data-dir=$profile", "--remote-debugging-port=$port", '--window-size=1440,900', 'about:blank'
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
$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}

Start-Sleep -Milliseconds 400
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Page.navigate' @{ url = $url })
Start-Sleep -Milliseconds 2800
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error))); "ok"')

$n = [int](Eval 'document.querySelectorAll("[data-dd-doc] a, [data-dd-doc] [data-dd-link]").length')
Check '阅读模式里有链接胶囊' ($n -gt 0) "n=$n"

$style = Eval '(() => { const el = document.querySelector("[data-dd-link]"); if (!el) return "none"; const s = getComputedStyle(el); return s.borderRadius + "|" + s.backgroundColor + "|" + s.textDecorationLine })()'
Check '圆角 + 浅绿底 + 不再用下划线' ([bool](($style -split '\|')[1] -ne 'rgba(0, 0, 0, 0)')) "style=$style"
$r = 0.0
try { $r = [double]((($style -split '\|')[0]) -replace 'px', '') } catch { $r = 0 }
Check '圆角够大（≥ 20px，是胶囊不是方角）' ($r -ge 20) "r=$style"

$glyph = [int](Eval 'document.querySelectorAll("[data-dd-link] svg").length')
Check '胶囊里有链条小图标' ($glyph -gt 0) "svg=$glyph"

Check '没有 JS 报错' ([int](Eval 'window.__errs.length') -eq 0) (Eval 'window.__errs.join(" | ")')
Check '无横向溢出' ([bool](([int](Eval 'document.documentElement.scrollWidth') -le [int](Eval 'window.innerWidth')))) ''

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "$fail FAILED" }
$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
