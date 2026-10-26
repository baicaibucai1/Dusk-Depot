$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddleft2-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1440,900', 'http://localhost:5184/'
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
function Click([int]$x, [int]$y) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = 1 })
}
Start-Sleep -Milliseconds 1200
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error)))')

Write-Host "首页: $((Eval 'document.body.innerText.slice(0, 40).replace(/\n/g," / ")'))"
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("打开示例库")).click()')
Start-Sleep -Milliseconds 2200
Write-Host "进库后 footer: $((Eval 'document.querySelector("footer") ? document.querySelector("footer").innerText.replace(/\n/g," | ") : "no-footer"'))"

# footer 里那个仓库按钮的坐标与点击
$rect = Eval '(() => { const b = document.querySelector("footer button"); if (!b) return "none"; const r = b.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(",") })()'
Write-Host "仓库按钮 rect(x,y,w,h): $rect"
if ($rect -ne "none") {
  $parts = $rect.Split(',')
  $cx = [int]$parts[0] + [int]$parts[2] / 2
  $cy = [int]$parts[1] + [int]$parts[3] / 2
  Click ([int]$cx) ([int]$cy)
  Start-Sleep -Milliseconds 400
  Write-Host "点后是否出现菜单（含「选择其他文件夹」）: $((Eval 'document.body.innerText.includes("选择其他文件夹")'))"
  Write-Host "菜单文本: $((Eval '(() => { const t = document.body.innerText; const i = t.indexOf("切换仓库"); return i >= 0 ? t.slice(i, i + 60).replace(/\n/g, " | ") : "无" })()'))"
}
$errs = Eval 'window.__errs.length'
Write-Host "errs: $errs $(Eval 'window.__errs.join(" | ")')"
