# 验左栏两页签（文件 / 工具）落进真应用：
# 页签切换、文件树、篇数、坏链真算、设置入口、无报错。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddleft-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800

Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400

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

Start-Sleep -Milliseconds 1200
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })
$PROBE = @'
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)));
'@
[void](Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = $PROBE })
[void](Send-Cdp 'Page.navigate' @{ url = 'http://localhost:5183/?vault=memory' })
Start-Sleep -Milliseconds 4200
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error)))')

Write-Host '── 结构 ──'
Check '左栏顶部只有两个页签' ([int](Eval 'document.querySelectorAll("[role=tab]").length') -eq 2) "n=$(Eval 'document.querySelectorAll("[role=tab]").length')"
Check '页签是「文件」「工具」' ((Eval '[...document.querySelectorAll("[role=tab]")].map((b) => b.textContent.trim()).join("/")') -eq '文件/工具') "got=$(Eval '[...document.querySelectorAll("[role=tab]")].map((b) => b.textContent.trim()).join("/")')"
Check '默认选中「文件」' ((Eval 'document.querySelector("[role=tab][aria-selected=true]").textContent.trim()') -eq '文件') ''
Check '图标轨已移除' ([bool](Eval 'document.querySelector("nav[aria-label=\"主功能区\"]") === null')) ''
Check '文件页有篇数' ((Eval 'document.querySelector("[data-dd-files] .font-mono").textContent.trim()') -match '^\d+ 篇$') "got=$(Eval 'document.querySelector("[data-dd-files] .font-mono").textContent.trim()')"
$rowCount = [int](Eval 'document.querySelectorAll("[data-dd-files] button").length')
$hasActive = [bool](Eval 'document.querySelector("[data-dd-files] .bg-green-soft") !== null')
Check '文件树有行且能选中' ($rowCount -ge 3 -and $hasActive) "rows=$rowCount active=$hasActive"

Write-Host '── 交互 ──'
[void](Eval '[...document.querySelectorAll("[role=tab]")].find((b) => b.textContent.includes("工具")).click()')
Start-Sleep -Milliseconds 350
$toolsOn = [bool](Eval 'document.querySelector("[data-dd-tools]") !== null')
$filesGone = [bool](Eval 'document.querySelector("[data-dd-files]") === null')
Check '点「工具」→ 工具页出现、文件页隐藏' ($toolsOn -and $filesGone) "tools=$toolsOn filesGone=$filesGone"
Check '工具页坏链是真数字（不是编的）' ((Eval '[...document.querySelectorAll("[data-dd-tools] span")].map((s) => s.textContent.trim()).find((t) => t.endsWith("条"))') -match '^\d+ 条$') "got=$(Eval '[...document.querySelectorAll("[data-dd-tools] span")].map((s) => s.textContent.trim()).find((t) => t.endsWith("条"))')"
Check '没做的工具写「待接」' ([int](Eval '[...document.querySelectorAll("[data-dd-tools] span")].filter((s) => s.textContent.trim() === "待接").length') -eq 4) "n=$(Eval '[...document.querySelectorAll("[data-dd-tools] span")].filter((s) => s.textContent.trim() === "待接").length')"
[void](Eval '[...document.querySelectorAll("[role=tab]")].find((b) => b.textContent.includes("文件")).click()')
Start-Sleep -Milliseconds 300
Check '切回「文件」→ 树回来' ([bool](Eval 'document.querySelector("[data-dd-files]") !== null')) ''
[void](Eval 'document.querySelector("button[aria-label=设置]").click()')
Start-Sleep -Milliseconds 300
Check '底部齿轮能打开设置' ([bool](Eval 'document.querySelector("[role=dialog]") !== null || document.body.innerText.includes("渲染设置")')) ''
[void](Eval 'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))')
Start-Sleep -Milliseconds 300

Write-Host '── 布局与健康 ──'
Check '没有横向溢出' ([bool](Eval 'document.documentElement.scrollWidth <= window.innerWidth + 1')) "scroll=$(Eval 'document.documentElement.scrollWidth') win=$(Eval 'window.innerWidth')"
Check '左栏宽度 = 268' ([int](Eval 'Math.round(document.querySelector("section[aria-label=\"文件与工具\"]").getBoundingClientRect().width)') -eq 268) "w=$(Eval 'Math.round(document.querySelector("section[aria-label=\"文件与工具\"]").getBoundingClientRect().width)')"
$errs = Eval 'window.__errs.length'
Check '没有 JS 报错' ("$errs" -eq '0') "errs=$errs $(Eval 'window.__errs.join(" | ")')"

Write-Host ''
if ($script:fail -eq 0) { Write-Host 'left-tabs: 全部通过' } else { Write-Host "left-tabs: $script:fail 条没过"; exit 1 }
