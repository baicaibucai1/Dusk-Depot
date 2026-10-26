$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('dddiag-' + [guid]::NewGuid().ToString('N'))
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
  if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.text }
  return $r.result.result.value
}
function Click([int]$x, [int]$y) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = 1 })
}

Start-Sleep -Milliseconds 1000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

Write-Host '=== A. 不带参数打开（默认入口）==='
[void](Send-Cdp 'Page.navigate' @{ url = 'http://localhost:5183/' })
Start-Sleep -Milliseconds 3500
Write-Host "body: $(Eval 'document.body.innerText.slice(0, 260).replace(/\n/g, " / ")')"
Write-Host "buttons: $(Eval '[...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 12).join(" | ")')"
Write-Host "cm-editor: $(Eval 'document.querySelectorAll(".cm-editor").length')"

Write-Host ''
Write-Host '=== B. ?vault=memory（我给的地址）==='
[void](Send-Cdp 'Page.navigate' @{ url = 'http://localhost:5183/?vault=memory' })
Start-Sleep -Milliseconds 4000
Write-Host "cm-editor: $(Eval 'document.querySelectorAll(".cm-editor").length')  cm-line: $(Eval 'document.querySelectorAll(".cm-line").length')"
Write-Host "first line: $(Eval 'document.querySelector(".cm-line") ? document.querySelector(".cm-line").textContent : "none"')"
Write-Host "tree rows: $(Eval 'document.querySelectorAll("[data-dd-files] button").length')"
Write-Host "editor rect: $(Eval '(() => { const e = document.querySelector(".cm-editor"); if (!e) return "none"; const r = e.getBoundingClientRect(); return Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width) + "x" + Math.round(r.height) })()')"
Write-Host "contenteditable: $(Eval 'document.querySelector(".cm-content") ? document.querySelector(".cm-content").getAttribute("contenteditable") : "none"')"

# 真的在编辑器里打字
$before = [int](Eval 'document.querySelector(".cm-content").textContent.length')
Click 700 400
Start-Sleep -Milliseconds 200
[void](Send-Cdp 'Input.insertText' @{ text = 'X测试X' })
Start-Sleep -Milliseconds 500
$after = [int](Eval 'document.querySelector(".cm-content").textContent.length')
Write-Host "typing: before=$before after=$after  -> $(if ($after -gt $before) { '可编辑' } else { '打不进字' })"

Write-Host ''
Write-Host '=== C. 点树里另一篇 ==='
[void](Eval '(() => { const rows = [...document.querySelectorAll("[data-dd-files] button")].filter((b) => b.textContent.trim().endsWith(".md")); const t = rows.find((b) => !b.textContent.includes("开始这里")) || rows[0]; if (!t) return "no-row"; t.click(); return t.textContent.trim() })()' | ForEach-Object { Write-Host "clicked: $_" })
Start-Sleep -Milliseconds 600
Write-Host "active tab: $(Eval '(() => { const t = document.querySelector("[data-active-path]"); return t ? t.getAttribute("data-active-path") : "none" })()')"
Write-Host "cm-line: $(Eval 'document.querySelectorAll(".cm-line").length')  first: $(Eval 'document.querySelector(".cm-line") ? document.querySelector(".cm-line").textContent : "none"')"
Write-Host "errs: $(Eval 'window.__errs ? window.__errs.length : "no-probe"')"
