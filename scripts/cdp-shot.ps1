param([string]$Url = 'http://localhost:5183/?vault=memory', [string]$Out = 'assets/workspace-shot.png')
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddshot-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--user-data-dir=$profile", "--remote-debugging-port=$port", '--window-size=1440,900', 'about:blank'
)
for ($i = 0; $i -lt 40; $i++) {
  try { $list = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2; $page = $list | Where-Object { $_.type -eq 'page' } | Select-Object -First 1; if ($page) { break } } catch { }
  Start-Sleep -Milliseconds 400
}
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
$id = 0
function Send-Cdp([string]$method, [hashtable]$params) {
  $script:id++; $myId = $script:id
  $msg = @{ id = $myId; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, [Threading.CancellationToken]::None).Wait()
  while ($true) {
    $buf = [byte[]]::new(1048576); $sb = [System.Text.StringBuilder]::new()
    do { $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None).Result; [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)) } while (-not $res.EndOfMessage)
    $obj = $sb.ToString() | ConvertFrom-Json
    if ($obj.id -eq $myId) { return $obj }
  }
}
function Eval([string]$expr) {
  $r = Send-Cdp 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true; awaitPromise = $true }
  if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.text }
  return $r.result.result.value
}
Start-Sleep -Milliseconds 400
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 1400
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("打开示例库")); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 2200

# 开两个额外标签
[void](Eval '(() => {
  const rows = [...document.querySelectorAll("[data-dd-files] button")].filter((b) => b.textContent.trim() && !b.getAttribute("aria-label"));
  for (const i of [1, 2]) {
    const b = rows[i];
    if (!b) continue;
    b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 260 }));
  }
  return rows.length;
})()')
Start-Sleep -Milliseconds 400
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "在新标签页打开"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 500
[void](Eval '(() => {
  const rows = [...document.querySelectorAll("[data-dd-files] button")].filter((b) => b.textContent.trim() && !b.getAttribute("aria-label"));
  const b = rows[2];
  if (b) b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 }));
  return 1;
})()')
Start-Sleep -Milliseconds 400
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "在新标签页打开"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 500

# 拆一栏，并在右栏打开另一篇
[void](Eval '(() => { const b = document.querySelector("button[aria-label=\"向右拆分这一栏\"]"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 700
[void](Eval '(() => {
  const rows = [...document.querySelectorAll("[data-dd-files] button")].filter((b) => b.textContent.trim() && !b.getAttribute("aria-label"));
  const b = rows[3] || rows[0];
  if (b) b.click();
  return 1;
})()')
Start-Sleep -Milliseconds 900
# 让右栏显示关系页签，展示"辅助栏"的真实能力
[void](Eval '(() => { const b = [...document.querySelectorAll("aside button")].find((x) => (x.textContent || "").trim() === "关系"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 600

# 关掉可能残留的右键菜单，并把焦点放到编辑区（截图里不该有菜单）
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; key = 'Escape'; code = 'Escape'; windowsVirtualKeyCode = 27 })
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'Escape'; code = 'Escape'; windowsVirtualKeyCode = 27 })
Start-Sleep -Milliseconds 300
[void](Eval '(() => { const v = window.__dd_view; if (v) { v.focus(); } return 1 })()')
Start-Sleep -Milliseconds 400

$shot = Send-Cdp 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
$bytes = [Convert]::FromBase64String($shot.result.data)
$path = Join-Path (Get-Location) $Out
$dir = Split-Path $path -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
[IO.File]::WriteAllBytes($path, $bytes)
Write-Host "saved: $path  ($([math]::Round($bytes.Length / 1kb)) KB)"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
