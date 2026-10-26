# 验图床：往编辑器里丢一张真 PNG，看它有没有进 附件/、正文有没有引用、阅读模式能不能显示。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddimg-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800

Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400

$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1200,900', 'http://localhost:5183/?vault=memory'
)
for ($i = 0; $i -lt 40; $i++) {
  try {
    $list = Invoke-RestMethod "http://127.0.0.1:$port/json/list" -TimeoutSec 2
    $page = $list | Where-Object { $_.type -eq 'page' -and $_.url -like '*localhost:5183*' } | Select-Object -First 1
    if ($page) { break }
  } catch { }
  Start-Sleep -Milliseconds 400
}
if (-not $page) { throw 'CDP 目标没出现' }

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
  if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.text }
  return $r.result.result.value
}
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png' }
  if ($r.result.data) {
    $out = Join-Path (Get-Location) "assets\shots\$name"
    [IO.File]::WriteAllBytes($out, [Convert]::FromBase64String($r.result.data))
    "截图：$out"
  }
}
$fails = @()
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { "  ✓ $name" } else { "  ✗ $name  $detail"; $script:fails += $name }
}

Start-Sleep -Milliseconds 3000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

$PROBE = @'
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || String(e.error))));
'@
[void](Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = $PROBE })
[void](Send-Cdp 'Page.navigate' @{ url = 'http://localhost:5183/?vault=memory' })
Start-Sleep -Milliseconds 3500

[void](Eval "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n); if (!b) return 'no'; b.click(); return 'ok' })('开始这里.md')")
Start-Sleep -Milliseconds 1200

"拖入一张 PNG"
$DROP = @'
(() => {
  // 120x64 的绿底小图（看得见）
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAHgAAABACAYAAADRTbMSAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAFPSURBVHhe7dFBagMxEAVR3yT3yVVy+xDI0kGY4Liww2CrW/BVi7cZGHXTdXr7eD8r14kflMXA4QwczsDhDBzOwOEMHM7A4QwczsDhDBzOwOEMHM7A4ZYG/vz+Ooz/6pj2wAz3DL6px1oDM9Qr+LbuawnMODNxlm6VB2aQCpypq9LADFGJs3VRFpgBOnAHGTheSWAevhN32d30wDz4CtxpZwYOZ+BwUwPz0Ctxt10ZOJyBwxk4nIHDTQvMA6/G/XY1LfDAI6/E3XZl4HAGDmfgcAYONzXwwEOvwJ12ZuBwBg43PfDAg3fiLrsrCTzw8B24gwwcryzwwACVOFsXpYEHhqjAmboqDzwwyEycpVstgX8xziv4tu5rDTww1DP4ph5rD/wXw/2H/+qYpYFVz8DhDBzOwOEMHM7A4QwczsDhDBzOwOEMHM7A4QwczsDhfgCKuL0BHSaXmAAAAABJRU5ErkJggg=='
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const file = new File([bytes], '截图.png', { type: 'image/png' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const el = document.querySelector('.cm-content') || document.body
  el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  return 'dropped'
})()
'@
$r = [string](Eval $DROP)
Start-Sleep -Milliseconds 1200
"  结果：$r"

$doc = [string](Eval '(() => window.__dd_view.state.doc.toString())()')
"  正文片段：" + ($doc -replace "`n", '⏎').Substring(0, [Math]::Min(120, $doc.Length))
Check '正文里出现了图床引用' ($doc -match '!\[\]\(附件/') ''

$stored = [string](Eval "(() => { const raw = localStorage.getItem('dusk.memory.repo.v2'); if (!raw) return 'no-store'; const keys = Object.keys(JSON.parse(raw).files); return keys.filter((k) => k.startsWith('附件/')).join(' | ') })()")
"  图床里的文件：$stored"
Check '图片写进了 附件/ 目录' ([bool]$stored) "files=$stored"

$isB64 = [bool](Eval "(() => { const raw = localStorage.getItem('dusk.memory.repo.v2'); const files = JSON.parse(raw).files; const k = Object.keys(files).find((x) => x.startsWith('附件/')); return k ? files[k].startsWith('\u0000b64:') : false })()")
Check '图片以二进制（base64）存，没被当成文本搞坏' $isB64 ''

Start-Sleep -Milliseconds 1500
$editImgs = Eval 'document.querySelectorAll(".cm-editor img.dd-img").length'
Check '编写模式里图片也画出来了' ([int]$editImgs -ge 1) "imgs=$editImgs"
Shot 'image-edit.png'

[void](Eval "((n) => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === n); if (!b) return 'no'; b.click(); return 'ok' })('阅读')")
Start-Sleep -Milliseconds 1500
$imgs = Eval 'document.querySelectorAll("main img[src^=''blob:'']").length'
Check '阅读模式里图片正常显示' ([int]$imgs -ge 1) "imgs=$imgs"

$CENTERED = '(() => { const fig = document.querySelector("[data-image-block]"); if (!fig) return "no-figure"; const img = fig.querySelector("img"); if (!img) return "no-img"; const f = fig.getBoundingClientRect(); const i = img.getBoundingClientRect(); return Math.round((i.left + i.width / 2) - (f.left + f.width / 2)) })()'
$off = Eval $CENTERED
Check '独占一段的图片居中成图' ([Math]::Abs([int]$off) -le 2) "偏差=$off"
Shot 'image-embed.png'

"--- 错误 ---"
Eval '(() => (window.__errs || []).slice(0, 5).join("\n"))()'

""
if ($fails.Count -gt 0) { "结果：失败 $($fails -join ', ')"; exit 1 }
"结果：全部通过"

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
