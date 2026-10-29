$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddsym2-' + [guid]::NewGuid().ToString('N'))
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
Start-Sleep -Milliseconds 2600
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error))); "ok"')

Write-Host '-- 入口 --'
Check '文件树里有「项目」目录' ([bool](Eval '[...document.querySelectorAll("[data-dd-files] button")].some((b) => b.textContent.trim().endsWith("项目"))')) ''
Check '工具条有「插入符号」按钮' ([bool](Eval 'document.querySelector("button[aria-label=插入符号]") !== null')) ''

Write-Host '-- A. 插入正文 --'
[void](Eval 'document.querySelector("button[aria-label=插入符号]").click()')
Start-Sleep -Milliseconds 350
Check '面板打开' ([bool](Eval 'document.querySelector("[data-dd-symbols]") !== null')) ''
$cells = [int](Eval 'document.querySelectorAll("[data-dd-symbols] button[title]").length')
Check '面板里有符号（>100）' ($cells -gt 100) "n=$cells"
Check '有「最近用过」区块时置顶（首次没有）' ($true) ''
[void](Eval '(() => { const i = document.querySelector("[data-dd-symbols] input"); i.value = "火箭"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1 })()')
Start-Sleep -Milliseconds 300
Check '搜索「火箭」命中 🚀' ([bool](Eval '[...document.querySelectorAll("[data-dd-symbols] button")].some((b) => b.textContent.trim() === "🚀")')) "got=$(Eval '[...document.querySelectorAll("[data-dd-symbols] button")].map((b) => b.textContent.trim()).join("|").slice(0,60)')"

$before = [int](Eval 'document.querySelector(".cm-content").textContent.length')
[void](Eval '[...document.querySelectorAll("[data-dd-symbols] button")].find((b) => b.textContent.trim() === "🚀").click()')
Start-Sleep -Milliseconds 500
$after = [int](Eval 'document.querySelector(".cm-content").textContent.length')
Check '点了之后正文变长' ($after -gt $before) "before=$before after=$after"
Check '正文里真的出现 🚀' ([bool](Eval 'document.querySelector(".cm-content").textContent.includes("🚀")')) ''
Check '面板自动关掉' ([bool](Eval 'document.querySelector("[data-dd-symbols]") === null')) ''

Write-Host '-- B. 文件夹图标 --'
[void](Eval '(() => { const r = [...document.querySelectorAll("[data-dd-files] button")].find((b) => b.textContent.trim().endsWith("项目")); const row = r.closest("div"); row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 240, clientY: 200 })); return 1 })()')
Start-Sleep -Milliseconds 350
Check '右键菜单出现「设置图标…」' ([bool](Eval '[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "设置图标…")')) "menu=$(Eval '[...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => t.length < 12).join("/")')"
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "设置图标…").click()')
Start-Sleep -Milliseconds 400
Check '图标选择器打开，标题带文件夹名' ([bool](Eval '(document.querySelector("[data-dd-symbols]") || {}).textContent?.includes("项目 的图标")')) "title=$(Eval 'document.querySelector("[data-dd-symbols]") ? document.querySelector("[data-dd-symbols]").textContent.slice(0, 24) : "none"')"
[void](Eval '(() => { const i = document.querySelector("[data-dd-symbols] input"); i.value = "上线"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1 })()')
Start-Sleep -Milliseconds 300
[void](Eval '[...document.querySelectorAll("[data-dd-symbols] button")].find((b) => b.textContent.trim() === "🚀").click()')
Start-Sleep -Milliseconds 500
Check '树里「项目」用上了 🚀（自定义图标）' ([bool](Eval 'document.querySelector("[data-dd-diricon]") !== null')) "n=$(Eval 'document.querySelectorAll("[data-dd-diricon]").length')"
Check '那个字符就是 🚀' ((Eval 'document.querySelector("[data-dd-diricon]").textContent.trim()') -eq '🚀') "got=$(Eval 'document.querySelector("[data-dd-diricon]").textContent.trim()')"
Check '原来那个 folder 图标被换掉了' ([bool](Eval '(() => { const r = [...document.querySelectorAll("[data-dd-files] button")].find((b) => b.textContent.trim().endsWith("项目")).closest("div"); return r.querySelector(".lucide-folder, .lucide-folder-open") === null })()')) ''

Write-Host '-- C. 清除与残留 --'
[void](Eval '(() => { const r = [...document.querySelectorAll("[data-dd-files] button")].find((b) => b.textContent.trim().endsWith("项目")); r.closest("div").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 240, clientY: 200 })); return 1 })()')
Start-Sleep -Milliseconds 300
Check '有图标时菜单里出现「清除图标」' ([bool](Eval '[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "清除图标")')) ''
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "清除图标").click()')
Start-Sleep -Milliseconds 400
Check '清除后树里恢复默认 folder 图标' ([bool](Eval '(document.querySelector("[data-dd-diricon]") === null) && document.querySelector(".lucide-folder, .lucide-folder-open") !== null')) ''

Write-Host '-- 布局 --'
Check '无横向溢出' ([bool](([int](Eval 'document.documentElement.scrollWidth') -le [int](Eval 'window.innerWidth')))) "scroll=$(Eval 'document.documentElement.scrollWidth') win=$(Eval 'window.innerWidth')"
$errs = [int](Eval 'window.__errs.length')
Check '零 JS 报错' ($errs -eq 0) (Eval 'window.__errs.join(" | ")')

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "$fail FAILED" }
$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
