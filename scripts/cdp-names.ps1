# 验"文件不显示 .md 后缀、用 markdown 标记代替"
param([string]$Url = 'http://localhost:5184/')
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddname-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
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
  if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.exception.description }
  return $r.result.result.value
}
$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}

Start-Sleep -Milliseconds 1000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })
[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 3500
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error)))')
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("打开示例库")).click()')
Start-Sleep -Milliseconds 2500

$rows = Eval '(() => [...document.querySelectorAll("[data-dd-files] button")].map((b) => b.textContent.trim()).filter(Boolean).join(" | "))()'
Write-Host "树里的行: $rows"
Check '树里不出现 .md 后缀' ([bool](Eval '![...document.querySelectorAll("[data-dd-files] button")].some((b) => (b.textContent || "").includes(".md"))')) ''

$tabs = Eval '(() => [...document.querySelectorAll("header button")].map((b) => b.textContent.trim()).filter((t) => t && t !== "×").join(" | "))()'
Write-Host "标签页: $tabs"
Check '标签页也不带 .md' ([bool](Eval '![...document.querySelectorAll("header button")].some((b) => (b.textContent || "").includes(".md"))')) ''

Check 'md 文件前面有 markdown 标记（svg）' ([int](Eval 'document.querySelectorAll("[data-dd-files] svg").length') -ge 4) "svg=$(Eval 'document.querySelectorAll("[data-dd-files] svg").length')"
Check '根目录那一篇显示为「开始这里」' ([bool](Eval '[...document.querySelectorAll("[data-dd-files] button")].some((b) => b.textContent.trim() === "开始这里"))')) ""

$errs = Eval 'window.__errs.length'
Check '没有 JS 报错' ("$errs" -eq '0') "errs=$errs"

Write-Host ''
if ($script:fail -eq 0) { Write-Host 'names: 全部通过' } else { Write-Host "names: $script:fail 条没过"; exit 1 }
