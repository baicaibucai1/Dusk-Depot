# 点哪里选哪里 —— 全篇逐行逐字用真实鼠标点一遍，看光标落在哪。
#
#   .\scripts\cdp-click-accuracy.ps1                          # 内置靶子文档
#   .\scripts\cdp-click-accuracy.ps1 -File "D:\某库\某篇.md"    # 拿真实文档验
#
# 为什么要有它：块组件（表格/块公式）没有自己的 .cm-line，靠"第几个 DOM 行"
# 推断是错的；只能反过来——问 CM "这个位置在哪"，去那个坐标点一下，看是否回到原位。
param([string]$Url = 'http://localhost:5183/?vault=memory', [string]$File = '')
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddacc2-' + [guid]::NewGuid().ToString('N'))
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
function Click([double]$x, [double]$y) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  Start-Sleep -Milliseconds 200
}
$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}

Start-Sleep -Milliseconds 400
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 2800

if ($File -ne '' -and (Test-Path $File)) {
  $text = [IO.File]::ReadAllText($File)
} else {
  $text = @'
回到 [[开始这里]]。

- [x]

$$\int_a^b f(x)\,dx = F(b) - F(a)$$

| 甲 | 乙 |
| --- | --- |
| 1 | 2 |

最后一行文字，点这里应该落在这里。
'@
}
$json = $text | ConvertTo-Json -Compress
[void](Eval "(() => { const v = window.__dd_view; const t = $json; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, selection: { anchor: 0 } }); v.focus(); return 1 })()")
Start-Sleep -Milliseconds 1200

$lines = [int](Eval 'window.__dd_view.state.doc.lines')
Write-Host "文档 $lines 行，逐行验：滚到该行 → 现算坐标 → 点下去 → 看落在哪行"
$bad = 0
$charBad = 0
$checked = 0
$skipped = 0

for ($n = 1; $n -le $lines; $n++) {
  for ($frac = 0; $frac -le 2; $frac++) {
    $spot = Eval @"
(() => {
  const v = window.__dd_view;
  const doc = v.state.doc;
  const line = doc.line($n);
  if (!line.text.trim()) return 'EMPTY';
  const pos = line.from + Math.floor(line.length * $frac / 3);
  v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  return 'SET';
})()
"@
    if ($spot -eq 'EMPTY') { $skipped++; break }
    Start-Sleep -Milliseconds 120
    $info = Eval @"
(() => {
  const v = window.__dd_view;
  const doc = v.state.doc;
  const line = doc.line($n);
  const pos = line.from + Math.floor(line.length * $frac / 3);
  const c = v.coordsAtPos(pos);
  if (!c) return 'NOCOORD';
  const x = Math.round(c.left + 1);
  const y = Math.round((c.top + c.bottom) / 2);
  const el = document.elementFromPoint(x, y);
  const covered = el && (el.closest('.dd-block') || el.closest('.dd-math') || el.closest('[data-dd-checked]'));
  if (covered) return 'COVERED';
  return pos + ',' + x + ',' + y;
})()
"@
    if ($info -eq 'NOCOORD' -or $info -eq 'COVERED' -or $info -eq 'EMPTY') { $skipped++; continue }
    $p = $info.Split(',')
    $wantPos = [int]$p[0]
    Click ([double]$p[1]) ([double]$p[2])
    $head = [int](Eval 'window.__dd_view.state.selection.main.head')
    $gotLine = [int](Eval "window.__dd_view.state.doc.lineAt($head).number")
    $checked++
    if ($gotLine -ne $n) {
      $bad++
      $t = Eval "window.__dd_view.state.doc.line($n).text"
      Write-Host "FAIL  点第 $n 行（$($p[1]),$($p[2])）→ 落在第 $gotLine 行   [$($t -replace "`n", ' ')]"
    } elseif ([Math]::Abs($head - $wantPos) -gt 2) {
      $charBad++
      $t = Eval "window.__dd_view.state.doc.line($n).text"
      Write-Host "FAIL  第 $n 行字位偏了：期望 $wantPos，实得 $head（差 $($head - $wantPos)）   [$($t -replace "`n", ' ')]"
    }
  }
}

Check "全篇 $checked 个点：点哪一行就落在哪一行" ($bad -eq 0) "错位 $bad 个（跳过 $skipped 处）"
Check '落在行内时，字位误差不超过 2 个字符' ($charBad -eq 0) "偏了 $charBad 处"
Check '零 JS 报错' ([int](Eval 'window.__errs ? window.__errs.length : 0') -eq 0) (Eval 'window.__errs ? window.__errs.join(" | ") : ""')

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "FAILED: $fail" }

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
