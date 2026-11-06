# `.board` 画布手感验收：拖动吸附、多选整体拖、组框跟手。
#
# 这一组是"看着对但手上不对"的重灾区，所以全部用 CDP 真按真拖，
# 并且**在松手之前**读一次 DOM —— 拖动过程不跟手的话，落盘结果是对的，只有中途能看出来。
param([string]$Url = 'http://localhost:5184/')
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddalign-' + [guid]::NewGuid().ToString('N'))
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
function Num([string]$expr) { return [int](Eval $expr) }
$script:pass = 0
$script:fail = 0
function Check([string]$name, $cond, [string]$detail = '') {
  if ($cond) { $script:pass++; Write-Host "  ok  $name" }
  else { $script:fail++; Write-Host "  FAIL $name  $detail" }
}
# 鼠标：Alt=1 Ctrl=2 Meta=4 Shift=8
function Press([double]$x, [double]$y, [int]$mods = 0) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none'; modifiers = $mods })
  Start-Sleep -Milliseconds 40
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1; buttons = 1; modifiers = $mods })
  Start-Sleep -Milliseconds 60
}
function Glide([double]$x, [double]$y, [int]$mods = 0) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'left'; buttons = 1; modifiers = $mods })
  Start-Sleep -Milliseconds 70
}
function Drop([double]$x, [double]$y, [int]$mods = 0) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = 1; buttons = 0; modifiers = $mods })
  Start-Sleep -Milliseconds 120
}
function Click([double]$x, [double]$y, [int]$mods = 0) {
  Press $x $y $mods
  Drop $x $y $mods
  Start-Sleep -Milliseconds 220
}
# 卡片在屏幕上的矩形：left,top,width,height
function CardRect([string]$bid) {
  return (Eval "(() => { const el = [...document.querySelectorAll('[data-dd-card]')].find((x) => x.getAttribute('data-dd-card') === '$bid'); if (!el) return ''; const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round).join(',') })()")
}
# 拖动：从 (x,y) 出发，按 $steps 个点走到 (x2,y2)，$mods 全程按住
function DragPath([double]$x, [double]$y, [double]$x2, [double]$y2, [int]$steps = 6, [int]$mods = 0) {
  Press $x $y $mods
  for ($i = 1; $i -le $steps; $i++) {
    Glide ($x + ($x2 - $x) * $i / $steps) ($y + ($y2 - $y) * $i / $steps) $mods
  }
}
$root = 'C:\AI_Production\Dusk Depot'
$shots = Join-Path $root '.workbuddy\shots\2026-11-06'
New-Item -ItemType Directory -Force -Path $shots | Out-Null
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
  [IO.File]::WriteAllBytes((Join-Path $shots "$name.png"), [Convert]::FromBase64String($r.result.data))
  Write-Host "  shot $name"
}

# 三块摆在已知坐标上：左列 a / 右列 b，底下一块 c 用来试"多选"和"组"
$STUB = @"
(() => {
  window.__files = {
    '白板/对齐.board': { text: JSON.stringify({
      app: 'dusk-depot', format: 'board', version: 1, boardId: 'bd-align',
      title: '对齐', createdAt: '2026-11-01T00:00:00.000Z',
      layout: { mode: 'free', order: ['a','b','c'], pos: {
        a: { x: 60, y: 60, w: 240 },
        b: { x: 460, y: 60, w: 240 },
        c: { x: 60, y: 320, w: 240 }
      } },
      blocks: {
        a: { id: 'a', type: 'paragraph', content: [{ type: 'text', text: '甲' }] },
        b: { id: 'b', type: 'paragraph', content: [{ type: 'text', text: '乙' }] },
        c: { id: 'c', type: 'paragraph', content: [{ type: 'text', text: '丙' }] }
      },
      links: []
    }, null, 2) + '\n' }
  };
  const enc = new TextEncoder();
  function bytesOf(p) {
    const f = window.__files[p];
    if (!f) throw new Error('no file ' + p);
    return enc.encode(f.text);
  }
  function entriesOf(path) {
    const map = new Map();
    for (const p of Object.keys(window.__files)) {
      if (path === '') {
        const i = p.indexOf('/');
        map.set(i < 0 ? p : p.slice(0, i), i < 0 ? 'file' : 'directory');
      } else if (p.startsWith(path + '/')) {
        const rest = p.slice(path.length + 1);
        const i = rest.indexOf('/');
        map.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'directory');
      }
    }
    return [...map].map(([name, kind]) => ({ name, kind }));
  }
  function mk(path) {
    const h = { kind: 'directory', name: path || '库' };
    const def = (k, v) => Object.defineProperty(h, k, { value: v, enumerable: false });
    def('values', async function* () { for (const e of entriesOf(path)) yield e; });
    def('getDirectoryHandle', async (n) => mk(path ? path + '/' + n : n));
    def('getFileHandle', async (n, opts) => {
      const full = path ? path + '/' + n : n;
      if (!(full in window.__files) && !(opts && opts.create)) throw new DOMException('nf', 'NotFoundError');
      if (!(full in window.__files)) window.__files[full] = { text: '' };
      return {
        async getFile() { return new File([bytesOf(full)], n) },
        async createWritable() {
          let buf = ''; const dec = new TextDecoder();
          return {
            async write(d) { if (d instanceof Blob) buf += await d.text(); else if (typeof d === 'string') buf += d; else buf += dec.decode(d) },
            async close() { window.__files[full] = { text: buf }; },
          };
        },
      };
    });
    def('removeEntry', async (n) => {
      const full = path ? path + '/' + n : n;
      for (const p of Object.keys(window.__files)) if (p === full || p.startsWith(full + '/')) delete window.__files[p];
    });
    def('queryPermission', async () => 'granted');
    def('requestPermission', async () => 'granted');
    return h;
  }
  window.showDirectoryPicker = async () => mk('');
  return 'stubbed';
})();
"@

[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })
[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 2600
Check '假仓库装上了' ((Eval $STUB) -eq 'stubbed') ''
[void](Eval '[...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("选择文件夹")).click()')
Start-Sleep -Milliseconds 2200
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error))); "ok"')
$BOARD = 'JSON.parse(window.__files["白板/对齐.board"].text)'

Write-Host 'A. 打开画布'
Check '树里有这块白板' ([bool](Eval '[...document.querySelectorAll("[data-dd-files] button")].some((b) => (b.textContent||"").includes("对齐.board"))')) ''
[void](Eval '[...document.querySelectorAll("[data-dd-files] button")].find((b) => (b.textContent||"").includes("对齐.board")).click()')
Start-Sleep -Milliseconds 1700
$n = Num 'document.querySelectorAll("[data-dd-board-block]").length'
Check '三块都在画布上' ($n -eq 3) "n=$n"
$zoom = Eval 'document.querySelector("[data-dd-zoom]")?.innerText.match(/(\d+)%/)?.[1] ?? ""'
# 下面所有位移都按屏幕像素算（跟缩放无关），这里只确认没有离谱的缩放
Check '缩放接近 100%' ([int]$zoom -ge 95) "zoom=$zoom"

Write-Host 'B. 拖一块贴近另一块：中途出参考线，落下精确对齐'
$ra = (CardRect 'a').Split(',')
$rb = (CardRect 'b').Split(',')
$rc = (CardRect 'c').Split(',')
# 斜着拖到"左边比 b 差 3px、顶边正好贴住 b 的底边"：
# 3px 正是"该吸不该吸"的分界线；往下错开是为了别正好压在 b 身上（后面还要点 b）
$ax = [double]$ra[0] + [double]$ra[2] / 2
$ay = [double]$ra[1] + [double]$ra[3] / 2
$dx = ([double]$rb[0] - 3) - [double]$ra[0]
$dy = ([double]$rb[1] + [double]$rb[3]) - [double]$ra[1]
DragPath $ax $ay ($ax + $dx) ($ay + $dy) 6 0
$gl = Num 'document.querySelectorAll("[data-dd-board-guides] line").length'
Check '拖动过程中画出对齐参考线' ($gl -ge 1) "lines=$gl"
$liveA = (CardRect 'a').Split(',')
Check '拖到 3px 外时已经被吸到 b 的左边' ([Math]::Abs([double]$liveA[0] - [double]$rb[0]) -le 1) "a.left=$($liveA[0]) b.left=$($rb[0])"
Shot 'align-guides'
Drop ($ax + $dx) ($ay + $dy) 0
Start-Sleep -Milliseconds 900
$xa = Eval "$BOARD.layout.pos.a.x"
$ab = Eval "$BOARD.layout.pos.b.x"
Check '落盘坐标就是对齐后的 460' ($xa -eq $ab) "a.x=$xa b.x=$ab"
$ra1 = (CardRect 'a').Split(',')
$rb1 = (CardRect 'b').Split(',')
Check '顶边也吸住了（跟 b 的底边严丝合缝）' ([Math]::Abs(([double]$ra1[1] - ([double]$rb1[1] + [double]$rb1[3]))) -le 1) "a.top=$($ra1[1]) b.bottom=$([double]$rb1[1] + [double]$rb1[3])"
Check '松手后参考线收掉' ((Num 'document.querySelectorAll("[data-dd-board-guides]").length') -eq 0) ''

Write-Host 'C. 按住 Alt 拖：临时关掉吸附'
$ra = (CardRect 'b').Split(',')
$rb = (CardRect 'c').Split(',')
# c 往右拖到离 b 左边 3px 的地方；按住 Alt 就不该被吸过去
$cx = [double]$rb[0] + [double]$rb[2] / 2
$cy = [double]$rb[1] + [double]$rb[3] / 2
$dx2 = ([double]$ra[0] - 3) - [double]$rb[0]
DragPath $cx $cy ($cx + $dx2) $cy 6 1
$gl2 = Num 'document.querySelectorAll("[data-dd-board-guides] line").length'
Check '按着 Alt 不画参考线' ($gl2 -eq 0) "lines=$gl2"
Drop ($cx + $dx2) $cy 1
Start-Sleep -Milliseconds 900
$xc = Eval "$BOARD.layout.pos.c.x"
Check '按着 Alt 没有被吸过去（c.x 没变成 b 的左边）' ($xc -le ($ab - 2)) "c.x=$xc b.x=$ab"

Write-Host 'D. Shift 点选两块，拖其中一块 = 整批一起走'
$rc = (CardRect 'c').Split(',')
$rbb = (CardRect 'b').Split(',')
Click ([double]$rc[0] + [double]$rc[2] / 2) ([double]$rc[1] + [double]$rc[3] / 2) 8
Click ([double]$rbb[0] + [double]$rbb[2] / 2) ([double]$rbb[1] + [double]$rbb[3] / 2) 8
$selN = Num 'document.querySelectorAll("[data-dd-card][data-selected]").length'
Check '两块同时被选中' ($selN -eq 2) "selected=$selN"
$bBefore = [int](Eval "$BOARD.layout.pos.b.x")
$cBefore = [int](Eval "$BOARD.layout.pos.c.x")
$p0 = (CardRect 'b').Split(',')
$bx = [double]$p0[0] + [double]$p0[2] / 2
$by = [double]$p0[1] + [double]$p0[3] / 2
$cLeft0 = [double]$rc[0]
DragPath $bx $by ($bx + 40) $by 5 0
# 松手前先看"跟不跟手"：两张卡必须同时挪了
$liveB = [double](CardRect 'b').Split(',')[0]
$liveC = [double](CardRect 'c').Split(',')[0]
Check '拖动中 b 跟着走' (($liveB - [double]$p0[0]) -ge 20) "位移=$($liveB - [double]$p0[0])"
Check '拖动中 c 也一起走' (($liveC - $cLeft0) -ge 20) "位移=$($liveC - $cLeft0)"
Shot 'multi-drag'
Drop ($bx + 40) $by 0
Start-Sleep -Milliseconds 900
$bAfter = [int](Eval "$BOARD.layout.pos.b.x")
$cAfter = [int](Eval "$BOARD.layout.pos.c.x")
$db = $bAfter - $bBefore
$dc = $cAfter - $cBefore
Check '两块位移一样' ($db -eq $dc) "db=$db dc=$dc"
Check '确实挪动了' ([Math]::Abs($db) -ge 20) "db=$db"

Write-Host 'E. 组合之后拖标题条：整组跟手'
[void](Eval 'document.querySelector("[data-dd-combine]")?.click()')
Start-Sleep -Milliseconds 700
$grip = Eval '(() => { const el = document.querySelector("[data-dd-group-grip]"); if (!el) return ""; const b = el.getBoundingClientRect(); return [b.left + b.width/2, b.top + b.height/2].map(Math.round).join(",") })()'
Check '组合框出现了' ($grip -ne '') "grip=$grip"
if ($grip -ne '') {
  $g = $grip.Split(',')
  $yBeforeB = [int](Eval "$BOARD.layout.pos.b.y")
  $yBeforeC = [int](Eval "$BOARD.layout.pos.c.y")
  $y0b = [double](CardRect 'b').Split(',')[1]
  $y0c = [double](CardRect 'c').Split(',')[1]
  DragPath ([double]$g[0]) ([double]$g[1]) ([double]$g[0]) ([double]$g[1] + 40) 5 0
  $m1 = [double](CardRect 'b').Split(',')[1]
  $m2 = [double](CardRect 'c').Split(',')[1]
  Check '拖动中 b 跟着组走' ([Math]::Abs($m1 - $y0b) -ge 20) "b.top=$m1 was=$y0b"
  Check '拖动中 c 也跟着组走' ([Math]::Abs($m2 - $y0c) -ge 20) "c.top=$m2 was=$y0c"
  Shot 'group-drag'
  Drop ([double]$g[0]) ([double]$g[1] + 40) 0
  Start-Sleep -Milliseconds 900
  $ya = [int](Eval "$BOARD.layout.pos.b.y")
  $yb = [int](Eval "$BOARD.layout.pos.c.y")
  $dyb = $ya - $yBeforeB
  $dyc = $yb - $yBeforeC
  Check '组里两块往下走了' (($dyb -ge 20) -and ($dyc -ge 20)) "db=$dyb dc=$dyc"
  Check '整组位移一致' ($dyb -eq $dyc) "db=$dyb dc=$dyc"
}

Write-Host 'F. 页面没有报错'
$errs = Eval 'JSON.stringify(window.__errs || [])'
Check '没有未捕获异常' ($errs -eq '[]') "errs=$errs"

Write-Host ''
Write-Host "结果：$($script:pass) 通过 / $($script:fail) 失败"
if ($script:fail -gt 0) { exit 1 }
