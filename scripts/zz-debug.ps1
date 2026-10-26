$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('dddbg-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1400,900', 'http://localhost:5183/?vault=memory'
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

Start-Sleep -Milliseconds 3500
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })
Write-Host "cm-line count: $(Eval 'document.querySelectorAll(".cm-line").length')"
Write-Host "first line: $(Eval 'document.querySelector(".cm-line") ? document.querySelector(".cm-line").textContent : "none"')"
Write-Host "tabs: $(Eval '[...document.querySelectorAll("header button")].map((b) => b.textContent.trim()).join(" | ")')"
Write-Host "body head: $(Eval 'document.body.innerText.slice(0, 120).replace(/\n/g, " / ")')"

[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = 400; y = 400; button = 'left'; clickCount = 1 })
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = 400; y = 400; button = 'left'; clickCount = 1 })
Start-Sleep -Milliseconds 300
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; key = 'a'; code = 'KeyA'; windowsVirtualKeyCode = 65; nativeVirtualKeyCode = 65; modifiers = 2 })
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'a'; code = 'KeyA'; windowsVirtualKeyCode = 65; nativeVirtualKeyCode = 65; modifiers = 2 })
[void](Send-Cdp 'Input.insertText' @{ text = '1. 甲' + "`n" + '2. 乙' })
Start-Sleep -Milliseconds 800
Write-Host "after type, lines: $(Eval '[...document.querySelectorAll(".cm-line")].map((l) => l.textContent).join(" / ")')"
Write-Host "dd-num: $(Eval 'document.querySelectorAll(".dd-num").length')"
