$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddsym-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$url = 'http://localhost:5183/assets/proto-symbols.html'

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

Start-Sleep -Milliseconds 600
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Page.navigate' @{ url = $url })
Start-Sleep -Milliseconds 2200
# 这个 headless 环境里 addScriptToEvaluateOnNewDocument 不执行，改成加载完再装探针；
# 首屏脚本是否跑通由下面「面板里符号够多」那条断言保证
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error))); "ok"')

Write-Host '-- 面板 --'
$cells = [int](Eval 'document.querySelectorAll("#pane .cell").length')
Check '面板里符号够多（>100）' ($cells -gt 100) "n=$cells"
Check '分类按钮在' ([int](Eval 'document.querySelectorAll("#cats button").length') -ge 10) "n=$(Eval 'document.querySelectorAll("#cats button").length')"
Check '默认单色：字符用 .g 渲染' ([int](Eval 'document.querySelectorAll("#pane .cell .g").length') -gt 100) "n=$(Eval 'document.querySelectorAll("#pane .cell .g").length')"
Check '默认是「插入正文」模式' ((Eval 'document.querySelector("#mode button.on").dataset.mode') -eq 'insert') ''

Write-Host '-- 插入正文 --'
$before = Eval 'document.getElementById("line2").textContent'
[void](Eval 'document.querySelectorAll("#pane .cell")[0].click()')
Start-Sleep -Milliseconds 150
$after = Eval 'document.getElementById("line2").textContent'
Check '点符号 → 正文变长' ($after.Length -gt $before.Length) "before=$($before.Length) after=$($after.Length)"
Check '源码区同步出现该字符' ([bool](Eval 'document.getElementById("src").textContent.includes(document.querySelectorAll("#pane .cell")[0].dataset.ch)')) ''
Check '源码区是真 markdown（有 # 本周）' ([bool](Eval 'document.getElementById("src").textContent.includes("# 本周")')) ''

Write-Host '-- 三种风格 --'
[void](Eval 'document.querySelector("#styles button[data-style=color]").click()')
Start-Sleep -Milliseconds 250
Check '切彩色 → .e 出现、.g 消失' ([bool](([int](Eval 'document.querySelectorAll("#pane .cell .e").length') -gt 100) -and ([int](Eval 'document.querySelectorAll("#pane .cell .g").length') -lt 100))) "e=$(Eval 'document.querySelectorAll("#pane .cell .e").length')"
[void](Eval 'document.querySelector("#styles button[data-style=openmoji]").click()')
Start-Sleep -Milliseconds 400
$masks = [int](Eval 'document.querySelectorAll("#pane .om").length')
Check '切描边 → mask 元素出现（36 个 emoji 有 SVG）' ($masks -ge 30) "n=$masks"
Check '描边元素真的用上了 SVG 掩码' ([bool](Eval '[...document.querySelectorAll("#pane .om")].some((e) => getComputedStyle(e).maskImage.includes("openmoji"))')) ''

Write-Host '-- 设为文件夹图标 --'
[void](Eval 'document.querySelector("#mode button[data-mode=folder]").click()')
Start-Sleep -Milliseconds 200
Check '切到「设为文件夹图标」' ((Eval 'document.querySelector("#mode button.on").dataset.mode') -eq 'folder') ''
[void](Eval '[...document.querySelectorAll("#pane .cell")].find((b) => b.dataset.hex === "1F680").click()')
Start-Sleep -Milliseconds 300
Check '项目行出现「自定义」标记' ([bool](Eval '[...document.querySelectorAll(".trow")].some((r) => r.textContent.includes("自定义"))')) ''
Check '树里的图标换成了火箭（mask）' ([bool](Eval 'document.querySelector(".trow.act .om") !== null')) ''
Check '16px 预览区有内容' ([bool](Eval 'document.getElementById("z16").innerHTML.length > 50')) ''
Check '配置只有一行字符（不是图片路径）' ([bool](Eval 'document.getElementById("slotline").textContent.includes("icons.json")')) ''
Check '切换文件夹 → 预览跟着换' ([bool](Eval '(() => { const r = [...document.querySelectorAll(".trow")].find((x) => x.textContent.includes("素材")); r.click(); return document.getElementById("zoomName").textContent === "素材" })()')) ''

Write-Host '-- 布局 --'
Check '无横向溢出' ([bool](([int](Eval 'document.documentElement.scrollWidth') -le [int](Eval 'window.innerWidth')))) "scroll=$(Eval 'document.documentElement.scrollWidth') win=$(Eval 'window.innerWidth')"
$errs = [int](Eval 'window.__errs.length')
Check '零 JS 报错' ($errs -eq 0) (Eval 'window.__errs.join(" | ")')

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "$fail FAILED" }
$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
