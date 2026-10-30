$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddrel-' + [guid]::NewGuid().ToString('N'))
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

Write-Host '-- 切到「关系」 --'
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "关系"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 400
Check '关系面板出现' ([bool](Eval 'document.querySelector("[data-dd-relations]") !== null')) ''

Write-Host '-- 这篇指向的（出链） --'
$outN = [int](Eval 'document.querySelector("[data-dd-outgoing] h3 span").textContent.trim()')
Check '出链数 = 3' ($outN -eq 3) "n=$outN"
$outTargets = Eval '[...document.querySelectorAll("[data-dd-outgoing] button")].map((b) => b.textContent.trim()).join("|")'
Check '出链三条都对上了（含子目录）' ($outTargets -eq '语法示例.md|项目/周计划.md|素材/说明.md') "got=$outTargets"

Write-Host '-- 引用这篇的（反链） --'
$heads = Eval '[...document.querySelectorAll("[data-dd-relations] h3")].map((h) => h.textContent.replace(/\s+/g, " ").trim()).join(" || ")'
$backN = [int](Eval '(() => { const h = [...document.querySelectorAll("[data-dd-relations] h3")].find((x) => x.textContent.includes("引用这篇的")); return h.querySelector("span").textContent.trim() })()')
Check '反链数 = 2（原来只有 1，../ 那条被漏掉）' ($backN -eq 2) "n=$backN heads=$heads"
$backPaths = Eval '(() => { const s = [...document.querySelectorAll("[data-dd-relations] section")].find((x) => x.textContent.includes("引用这篇的")); return [...s.querySelectorAll("button")].map((b) => b.querySelector("span span") ? b.querySelectorAll("span")[1].textContent.trim() : b.textContent.trim()).join("|") })()'
Check '两条反链是 项目周计划 + 素材说明（都写的 ../）' ($backPaths -eq '素材/说明.md|项目/周计划.md') "got=$backPaths"

Write-Host '-- 点击能跳 --'
[void](Eval '(() => { const b = [...document.querySelectorAll("[data-dd-outgoing] button")].find((x) => x.textContent.includes("日记") || x.textContent.includes("周计划")); b.click(); return 1 })()')
Start-Sleep -Milliseconds 700
$doc = Eval 'document.querySelector(".cm-content") ? document.querySelector(".cm-content").textContent.slice(0, 60) : ""'
Check '点出链 → 正文换成那一篇' ([bool]($doc -match '周计划')) "doc=$doc"

Write-Host '-- 布局与报错 --'
$errs = [int](Eval 'window.__errs.length')
Check '零 JS 报错' ($errs -eq 0) (Eval 'window.__errs.join(" | ")')

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "$fail FAILED" }
$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
