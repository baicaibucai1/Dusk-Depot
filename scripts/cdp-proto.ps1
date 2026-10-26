$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddproto-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$url = 'file:///C:/AI_Production/Dusk%20Depot/assets/proto-left-tabs.html'

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

Start-Sleep -Milliseconds 800
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })
$PROBE = @'
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push(String(e.message || e.error)));
'@
[void](Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = $PROBE })
[void](Send-Cdp 'Page.navigate' @{ url = $url })
Start-Sleep -Milliseconds 1200
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error)))')

Write-Host '── 结构 ──'
Check '顶部只有两个页签：文件 / 工具' ([int](Eval 'document.querySelectorAll(".side-tab").length') -eq 2) "n=$(Eval 'document.querySelectorAll(".side-tab").length')"
Check '默认选中「文件」' ((Eval 'document.querySelector(".side-tab.on").textContent.trim().split("\n")[0].trim()') -eq '文件') "got=$(Eval 'document.querySelector(".side-tab.on") ? document.querySelector(".side-tab.on").textContent : "none"')"
Check '左栏宽 276' ([int](Eval 'Math.round(document.querySelector(".side").getBoundingClientRect().width)') -eq 276) "w=$(Eval 'Math.round(document.querySelector(".side").getBoundingClientRect().width)')"
Check '右栏宽 280' ([int](Eval 'Math.round(document.querySelector(".aside").getBoundingClientRect().width)') -eq 280) "w=$(Eval 'Math.round(document.querySelector(".aside").getBoundingClientRect().width)')"
Check '文件页可见、工具页隐藏' ((Eval 'document.querySelector("[data-panel=files]").classList.contains("hidden") + "/" + document.querySelector("[data-panel=tools]").classList.contains("hidden")') -eq 'False/True') ''
Check '文件页没有四档切换（先只做文件树）' ([int](Eval 'document.querySelectorAll(".modes").length') -eq 0) "n=$(Eval 'document.querySelectorAll(".modes").length')"
Check '文件页显示仓库名与篇数' ((Eval 'document.querySelector(".tree-head .repo").textContent.trim() + "/" + document.querySelector(".tree-head .n").textContent') -eq '开始这里的库/128 篇') "got=$(Eval 'document.querySelector(".tree-head .repo").textContent.trim() + "/" + document.querySelector(".tree-head .n").textContent')"
Check '树里有文件夹和文件行' ([bool](([int](Eval 'document.querySelectorAll("[data-mode-panel=tree] .row").length') -ge 8) -and ([int](Eval 'document.querySelectorAll("[data-mode-panel=tree] .caret").length') -ge 3))) "rows=$(Eval 'document.querySelectorAll("[data-mode-panel=tree] .row").length')"

Write-Host '── 交互 ──'
[void](Eval 'document.querySelector(".side-tab[data-tab=tools]").click()')
Start-Sleep -Milliseconds 200
Check '点「工具」→ 工具页出现、文件页隐藏' ((Eval 'document.querySelector("[data-panel=tools]").classList.contains("hidden") + "/" + document.querySelector("[data-panel=files]").classList.contains("hidden")') -eq 'False/True') ''
Check '工具页有五件工具 + 索引卡' ([int](Eval 'document.querySelectorAll(".tool-card").length') -eq 5) "n=$(Eval 'document.querySelectorAll(".tool-card").length')"
[void](Eval 'document.querySelector(".side-tab[data-tab=files]").click()')
Start-Sleep -Milliseconds 200
Check '切回「文件」→ 树重新出现' ([bool](Eval '!document.querySelector("[data-panel=files]").classList.contains("hidden") && document.querySelectorAll("[data-mode-panel=tree] .row").length >= 8')) ''
[void](Eval 'document.querySelector(".aside-tab[data-aside=props]").click()')
Start-Sleep -Milliseconds 200
Check '右栏切「属性」→ 出现 4 张卡片' ([int](Eval 'document.querySelectorAll("[data-aside-panel=props] .card").length') -eq 4) "n=$(Eval 'document.querySelectorAll("[data-aside-panel=props] .card").length')"

Write-Host '── 布局 ──'
Check '没有横向溢出' ([bool](Eval 'document.documentElement.scrollWidth <= window.innerWidth + 1')) "scroll=$(Eval 'document.documentElement.scrollWidth') win=$(Eval 'window.innerWidth')"
Check '三栏都在视口内' ([bool](Eval '(() => { const s = document.querySelector(".side").getBoundingClientRect(); const a = document.querySelector(".aside").getBoundingClientRect(); return s.left >= 0 && a.right <= window.innerWidth + 1 })()')) ''
Check '中栏正文最大宽 720 且居中' ((Eval '(() => { const r = document.querySelector("article").getBoundingClientRect(); return Math.round(r.width) + "/" + (Math.abs((r.left + r.right) / 2 - window.innerWidth / 2) < 200) })()') -match '^720/true$') "got=$(Eval '(() => { const r = document.querySelector("article").getBoundingClientRect(); return Math.round(r.width) + "/" + (Math.abs((r.left + r.right) / 2 - window.innerWidth / 2) < 200) })()')"
Check '页面没有 JS 报错' ("$(Eval 'window.__errs.length')" -eq '0') "errs=$(Eval 'window.__errs.join(" | ")')"

Write-Host ''
if ($script:fail -eq 0) { Write-Host 'proto: 全部通过' } else { Write-Host "proto: $script:fail 条没过"; exit 1 }
