# 用 CDP 驱动无头 Edge 真点按钮，验证：新建笔记 / 改名 / 新建文件夹 / 置顶。
# 截图只能证明"看着对"，这里证明"点了真会发生事"。

$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddcdp-' + [guid]::NewGuid().ToString('N'))
# 端口随机：固定端口时，上一轮没退干净的实例会占着它，CDP 就连到旧浏览器上
$port = Get-Random -Minimum 9400 -Maximum 9800

# 先清掉所有无头实例（只动带 --headless 的，不碰你自己的浏览器窗口）
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1500,900', 'http://localhost:5183/?vault=memory'
)

function Wait-Target {
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $list = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2
      $page = $list | Where-Object { $_.type -eq 'page' -and $_.url -like '*localhost:5183*' } | Select-Object -First 1
      if ($page) { return $page }
    } catch { }
    Start-Sleep -Milliseconds 400
  }
  throw 'CDP 目标没出现'
}

$target = Wait-Target
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()

$id = 0
function Send-Cdp([string]$method, [hashtable]$params) {
  $script:id++
  $myId = $script:id
  $msg = @{ id = $myId; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, [Threading.CancellationToken]::None).Wait()

  # 响应里混着事件，必须按 id 认领，否则返回值会整体错位一格
  while ($true) {
    $buf = [byte[]]::new(262144)
    $sb = [Text.StringBuilder]::new()
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
  return $r.result.result.value
}

# 直接给受控 input 赋值（React 认的是原生 setter + input 事件）
$SET_INPUT = @'
(el, v) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}
'@

$fails = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "  ✓ $name" } else { "  ✗ $name  $detail"; $script:fails += $name }
}

Start-Sleep -Milliseconds 2500
[void](Send-Cdp 'Runtime.enable' @{})

"新建笔记"
$clicked = Eval "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '新建笔记'); if (!b) return 'no'; b.click(); return 'ok' })()"
Start-Sleep -Milliseconds 900
$hasInput = Eval "document.querySelectorAll('input').length"
Check '点完立刻进改名态' ($clicked -eq 'ok' -and $hasInput -ge 1) "clicked=$clicked inputs=$hasInput"

[void](Eval "(() => { const el = document.querySelector('input'); ($SET_INPUT)(el, '改名测试'); return 1 })()")
Start-Sleep -Milliseconds 900
$named = Eval "document.body.innerText.includes('改名测试')"
Check '改名落到树上' ([bool]$named) ''

"新建文件夹"
$MK_FOLDER = @'
(() => {
  const b = document.querySelector('button[aria-label="新建文件夹"]')
  if (!b) return 'no'
  b.click()
  return 'ok'
})()
'@
$mk = Eval $MK_FOLDER
Start-Sleep -Milliseconds 900
$mkInput = Eval "document.querySelectorAll('input').length"
Check '按钮建出文件夹并进改名态' ($mk -eq 'ok' -and $mkInput -ge 1) "clicked=$mk inputs=$mkInput"

[void](Eval "(() => { const el = document.querySelector('input'); ($SET_INPUT)(el, '我的目录'); return 1 })()")
Start-Sleep -Milliseconds 900
$dirMade = Eval "document.body.innerText.includes('我的目录')"
Check '目录名改成功' ([bool]$dirMade) ''

"置顶"
# ⚠️ 顶栏也有一颗 aria-label="更多"（没绑事件），所以只挑行上那一颗，
#    并且对**行本身**派发真正的 contextmenu 事件 —— 那才是右键走的路。
$OPEN_MENU = @'
(() => {
  const rowBtn = [...document.querySelectorAll('button[aria-label="更多"]')]
    .find((b) => b.className.indexOf('opacity-0') >= 0)
  if (!rowBtn) return 'no-row'
  const row = rowBtn.parentElement
  if (!row) return 'no-parent'
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 200 }))
  return 'ok'
})()
'@
$target = Eval $OPEN_MENU
Start-Sleep -Milliseconds 500
$CLICK_PIN = @'
(() => {
  const m = document.querySelector('[role=menu]')
  if (!m) return 'no-menu'
  const b = [...m.querySelectorAll('button')].find((x) => x.textContent.trim() === '置顶')
  if (!b) return 'no-item'
  b.click()
  return 'ok'
})()
'@
$pinned = Eval $CLICK_PIN
Start-Sleep -Milliseconds 700
$menuText = Eval "(() => { const m = document.querySelector('[role=menu]'); return m ? m.innerText.split('\n').join('/') : 'none' })()"
$READ_ZZQ = @'
(() => {
  const raw = localStorage.getItem('dusk.memory.repo.v2')
  if (!raw) return 'no-store'
  const blob = JSON.parse(raw)
  return blob.files && blob.files['.zzq'] ? blob.files['.zzq'] : 'no-mark'
})()
'@
$zzq = [string](Eval $READ_ZZQ)
"  菜单内容：$menuText"
"  .zzq：" + ($zzq -replace "`r?`n", ' ')
Check '右键菜单能置顶' ($pinned -eq 'ok') "menu=$target item=$pinned"
Check '置顶写进了仓库的 .zzq' ($zzq.Contains('改名测试')) "zzq=$zzq"

"分栏"
# 树上的行按名字点（左栏点文件 = 切换语义）
$OPEN = @'
((name) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === name)
  if (!b) return 'no'
  b.click()
  return 'ok'
})
'@

$SPLIT0 = "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '向右拆分这一栏'); if (!b) return 'no'; b.click(); return 'ok' })()"
$s0 = Eval $SPLIT0
Start-Sleep -Milliseconds 700
$panes2 = Eval 'document.querySelectorAll("main").length'
Check '拆一次 → 两栏' ($s0 -eq 'ok' -and [int]$panes2 -eq 2) "panes=$panes2"

$SPLIT_LAST = "(() => { const b = [...document.querySelectorAll('button')].filter((x) => x.getAttribute('aria-label') === '向右拆分这一栏'); if (!b.length) return 'no'; b[b.length - 1].click(); return 'ok' })()"
$s1 = Eval $SPLIT_LAST
Start-Sleep -Milliseconds 700
$panes3 = Eval 'document.querySelectorAll("main").length'
Check '再拆一次 → 三栏' ($s1 -eq 'ok' -and [int]$panes3 -eq 3) "panes=$panes3"

# 点第二栏认领焦点，再看左栏点文件时到底改的是哪一栏
$FOCUS1 = '(() => { const m = document.querySelectorAll("main")[1]; if (!m) return "no"; m.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return "ok" })()'
[void](Eval $FOCUS1)
Start-Sleep -Milliseconds 300

$PATHS = '(() => [...document.querySelectorAll("main")].map((m) => m.dataset.activePath).join(" | "))()'
$before = [string](Eval $PATHS)
[void](Eval "($OPEN)('开始这里.md')")
Start-Sleep -Milliseconds 700
$after = [string](Eval $PATHS)

$b = $before.Split('|')
$a = $after.Split('|')
Check '左栏点文件只改焦点栏（第二栏）' (
  $b[0].Trim() -eq $a[0].Trim() -and $b[1].Trim() -ne $a[1].Trim()
) "before=$before after=$after"

"拖分隔条"
$DRAG_PANE = @'
(() => {
  const d = document.querySelector('[aria-label="调整分栏宽度"]')
  if (!d) return -1
  const m = document.querySelectorAll('main')[0]
  const before = Math.round(m.getBoundingClientRect().width)
  const r = d.getBoundingClientRect()
  d.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left, bubbles: true }))
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 80, bubbles: true }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  return before
})()
'@
$wBefore = Eval $DRAG_PANE
Start-Sleep -Milliseconds 600
$wAfter = Eval '(() => { const m = document.querySelectorAll("main")[0]; return Math.round(m.getBoundingClientRect().width) })()'
Check '拖分隔条改分栏宽度' ([int]$wAfter - [int]$wBefore -ge 40) "before=$wBefore after=$wAfter"

"拖宽"
$DRAG = @'
(() => {
  const sep = document.querySelector('[role=separator][aria-label="调整左栏宽度"]')
  if (!sep) return 'no-sep'
  const panel = sep.parentElement
  const before = Math.round(panel.getBoundingClientRect().width)
  const r = sep.getBoundingClientRect()
  sep.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left, bubbles: true }))
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 64, bubbles: true }))
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  return before
})()
'@
$before = Eval $DRAG
Start-Sleep -Milliseconds 600
$MEASURE = @'
(() => {
  const s = document.querySelector('[role=separator][aria-label="调整左栏宽度"]')
  return s ? Math.round(s.parentElement.getBoundingClientRect().width) : -1
})()
'@
$after = Eval $MEASURE
Check '拖把手左栏变宽' (([int]$after - [int]$before) -ge 40) "before=$before after=$after"

$savedW = Eval "localStorage.getItem('dusk.widths.v1')"
Check '宽度写进了本地存储' ([bool]$savedW -and $savedW.Length -gt 5) "w=$savedW"

"仓库切换器"
$OPEN_VAULTS = @'
(() => {
  const b = document.querySelector('button[title*="点击切换仓库"]')
  if (!b) return 'no'
  b.click()
  return 'ok'
})()
'@
$vo = Eval $OPEN_VAULTS
Start-Sleep -Milliseconds 400
$READ_MENU = @'
(() => {
  const panel = [...document.querySelectorAll('div')].find(
    (d) => typeof d.className === 'string' && d.className.indexOf('bottom-9') >= 0,
  )
  return panel ? panel.innerText.split('\n').join('/') : 'none'
})()
'@
$vtext = [string](Eval $READ_MENU)
Check '点底部仓库名弹出切换器' ($vo -eq 'ok' -and $vtext.Contains('切换仓库')) "open=$vo text=$vtext"
Check '切换器里有"选择其他文件夹"' ($vtext.Contains('选择其他文件夹')) "text=$vtext"

$shot = $null
[void](Send-Cdp 'Page.enable' @{})
$shot = Send-Cdp 'Page.captureScreenshot' @{ format = 'png' }
if ($shot.result.data) {
  $out = Join-Path (Get-Location) 'assets\shots\ops.png'
  [IO.File]::WriteAllBytes($out, [Convert]::FromBase64String($shot.result.data))
  "截图：$out"
}

"记住仓库"
$savedRef = Eval "localStorage.getItem('dusk.repo.v1')"
Check '仓库引用存进了本地存储' ([bool]$savedRef -and $savedRef.Length -gt 5) "ref=$savedRef"

# 关掉 ?vault=memory 再进一次：应该凭存下来的引用自己回到上次那个仓库
[void](Send-Cdp 'Page.navigate' @{ url = 'http://localhost:5183/' })
Start-Sleep -Milliseconds 2500
$auto = Eval "document.body.innerText.includes('笔记库') && document.body.innerText.indexOf('选一个文件夹当仓库') < 0"
Check '刷新后自动回到上次的仓库，不再要求重选' ([bool]$auto) ''

""
if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
# Edge 会派生子进程，光杀主进程不够；按 profile 路径一网打尽
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
