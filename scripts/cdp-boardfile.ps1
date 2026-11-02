# `.board` 无限画布：文件区闭环 + 画布手势 + 编辑 + 连接 + .note 引用 + PDF 图标。
# 用 CDP 驱动无头 Edge 真点真拖，不是"看着像"。
param([string]$Url = 'http://localhost:5184/')
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddboard-' + [guid]::NewGuid().ToString('N'))
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
function ClickText([string]$text) {
  return (Eval "(() => { const b = [...document.querySelectorAll('[data-dd-files] button')].find((x) => (x.textContent || '').includes('$text')); if (!b) return false; b.click(); return true })()")
}
function RightClickRow([string]$text) {
  return (Eval "(() => { const b = [...document.querySelectorAll('[data-dd-files] button')].find((x) => (x.textContent || '').includes('$text')); if (!b) return false; b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 160, clientY: 200 })); return true })()")
}
function MenuItem([string]$text) {
  return (Eval "(() => { const b = [...document.querySelectorAll('[role=menuitem]')].find((x) => (x.textContent || '').trim() === '$text'); if (!b) return false; b.click(); return true })()")
}
function Key([string]$key, [string]$code, [int]$vk, [int]$mods = 0) {
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; key = $key; code = $code; windowsVirtualKeyCode = $vk; modifiers = $mods })
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $key; code = $code; windowsVirtualKeyCode = $vk; modifiers = $mods })
}
function BoxOf([string]$sel) {
  return (Eval "(() => { const el = document.querySelector('$sel'); if (!el) return ''; const r = el.getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2].map(Math.round).join(',') })()")
}
function DragTo([double]$x1, [double]$y1, [double]$x2, [double]$y2) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x1; y = $y1; button = 'left'; clickCount = 1; buttons = 1 })
  Start-Sleep -Milliseconds 70
  for ($i = 1; $i -le 6; $i++) {
    $x = $x1 + ($x2 - $x1) * $i / 6
    $y = $y1 + ($y2 - $y1) * $i / 6
    [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'left'; buttons = 1 })
    Start-Sleep -Milliseconds 25
  }
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x2; y = $y2; button = 'left'; clickCount = 1; buttons = 0 })
}
$root = 'C:\AI_Production\Dusk Depot'
$shots = Join-Path $root '.workbuddy\shots\2026-11-02'
New-Item -ItemType Directory -Force -Path $shots | Out-Null
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
  [IO.File]::WriteAllBytes((Join-Path $shots "$name.png"), [Convert]::FromBase64String($r.result.data))
  Write-Host "  shot $name"
}

$pngB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$root\示例库\素材\示例图片.png"))
$pdfB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$root\示例库\素材\示例文档.pdf"))

$STUB = @"
(() => {
  window.__files = {
    '笔记.md': { text: '# 笔记\n\n这是普通笔记。\n' },
    '素材/图.png': { b64: '$pngB64' },
    '素材/文档.pdf': { b64: '$pdfB64' },
    '白板/项目.board': { text: JSON.stringify({
      app: 'dusk-depot', format: 'board', version: 1, boardId: 'bd-demo',
      title: '项目白板', createdAt: '2026-11-01T00:00:00.000Z',
      layout: { mode: 'free', order: ['n1','n2'], pos: { n1: { x: 40, y: 40, w: 460 }, n2: { x: 120, y: 240, w: 320 } } },
      blocks: {
        n1: { id: 'n1', type: 'heading1', content: [{ type: 'text', text: '本周目标' }] },
        n2: { id: 'n2', type: 'paragraph', content: [{ type: 'text', text: '把白板做出来。' }] }
      },
      links: [{ id: 'l1', from: 'n1', to: 'n2', type: 'depends', label: '先有骨架', createdAt: 1 }]
    }, null, 2) + '\n' },
    '笔记/周会.note/.note': { text: JSON.stringify({ app: 'dusk-depot', format: 'board', version: 3, layoutMode: 'flow' }) },
    '笔记/周会.note/meta.json': { text: JSON.stringify({ title: '周会', createdAt: '2026-11-01T00:00:00.000Z' }) },
    '笔记/周会.note/board.json': { text: JSON.stringify({ version: 3, layoutMode: 'flow', order: ['b1','b2'], settings: {} }) },
    '笔记/周会.note/relations.json': { text: JSON.stringify({ version: 3, relations: [] }) },
    '笔记/周会.note/blocks/b1.json': { text: JSON.stringify({ id: 'b1', type: 'paragraph', content: [{ type: 'text', text: '结论记在白板上。' }] }) + '\n' },
    '笔记/周会.note/blocks/b2.json': { text: JSON.stringify({ id: 'b2', type: 'boardref', boardId: 'bd-demo', path: '白板/项目.board', view: 'preview' }) + '\n' }
  };
  window.__failWrite = null;
  const enc = new TextEncoder();
  function bytesOf(p) {
    const f = window.__files[p];
    if (!f) throw new Error('no file ' + p);
    if (f.text !== undefined) return enc.encode(f.text);
    const bin = atob(f.b64); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function entriesOf(path) {
    const map = new Map();
    for (const p of Object.keys(window.__files)) {
      if (path === '') {
        const i = p.indexOf('/');
        const name = i < 0 ? p : p.slice(0, i);
        map.set(name, i < 0 ? 'file' : 'directory');
      } else if (p.startsWith(path + '/')) {
        const rest = p.slice(path.length + 1);
        const i = rest.indexOf('/');
        const name = i < 0 ? rest : rest.slice(0, i);
        map.set(name, i < 0 ? 'file' : 'directory');
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
            async close() {
              if (window.__failWrite === full) throw new Error('磁盘满了');
              window.__files[full] = { text: buf };
            },
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
Start-Sleep -Milliseconds 2400
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error))); "ok"')

$BOARD = 'JSON.parse(window.__files["白板/项目.board"].text)'

Write-Host 'A. 文件树：.board 与 PDF 的图标'
Check '白板行有专属图标' ((Num 'document.querySelectorAll("[data-dd-files] [data-icon=board]").length') -ge 1) ''
Check 'PDF 行有自己的图标（手画的页-P）' ((Num 'document.querySelectorAll("[data-dd-files] [data-icon=pdf]").length') -ge 1) ''
Check '不再用 Lucide file-type 冒充 PDF' ((Num 'document.querySelectorAll("[data-dd-files] .lucide-file-type").length') -eq 0) ''
Check '树里有 白板/项目.board' ([bool](Eval '[...document.querySelectorAll("[data-dd-files] button")].some((b) => (b.textContent||"").includes("项目.board"))')) ''

Write-Host 'B. 打开白板：是画布，不是 JSON，也不是纵向列表'
Check '点白板打开' (ClickText '项目.board') ''
Start-Sleep -Milliseconds 1700
Check '出现画布' ((Num 'document.querySelectorAll("[data-dd-board-canvas]").length') -eq 1) ''
$blockN = Num 'document.querySelectorAll("[data-dd-board-block]").length'
Check '两块都在画布上' ($blockN -eq 2) "n=$blockN"
Check '连接画成一条曲线' ((Num 'document.querySelectorAll("[data-dd-board-link]").length') -eq 1) ''
$zoomText = Eval 'document.querySelector("[data-dd-zoom]")?.innerText.replace(/\n/g, " ") ?? ""'
Check '右下角有缩放控件' ([bool]("$zoomText" -match '\d+%')) "zoom=$zoomText"
$bg = Eval 'getComputedStyle(document.querySelector("[data-dd-board-canvas]")).backgroundImage'
Check '画布有点阵背景' ([bool]("$bg" -match 'radial-gradient')) "bg=$bg"
$pos1 = Eval "$BOARD.layout.pos.n2.x"
Check '坐标来自文件（n2.x=120）' ($pos1 -eq 120) "x=$pos1"
$status = Eval 'document.querySelector("header span[aria-live]")?.textContent ?? ""'
Check '初始状态是已保存' ($status -eq '已保存') "status=$status"
Key 'Tab' 'Tab' 9
Start-Sleep -Milliseconds 250
$focusRing = Eval '(() => { const el = document.activeElement; if (!el || el === document.body) return "none"; const cs = getComputedStyle(el); return el.tagName + "|" + cs.outlineStyle + "|" + cs.outlineWidth })()'
Check '键盘焦点画得出来（2px solid）' ([bool]("$focusRing" -match '\|solid\|2px')) "focus=$focusRing"
Shot 'canvas-1440'

Write-Host 'B2. 平移 / 缩放'
$tf0 = Eval 'document.querySelector("[data-dd-board-canvas] > div")?.style.transform ?? ""'
$panFrom = Eval '(() => { const r = document.querySelector("[data-dd-board-canvas]").getBoundingClientRect(); return [r.right - 120, r.bottom - 220].map(Math.round).join(",") })()'
$p = $panFrom.Split(',')
DragTo ([double]$p[0]) ([double]$p[1]) ([double]$p[0] - 90) ([double]$p[1] - 60)
Start-Sleep -Milliseconds 300
$tf1 = Eval 'document.querySelector("[data-dd-board-canvas] > div")?.style.transform ?? ""'
Check '拖空白处能平移画布' ($tf1 -ne $tf0) "before=$tf0 after=$tf1"
$z0 = Eval 'document.querySelector("[data-dd-zoom]")?.innerText.match(/(\d+)%/)?.[1] ?? ""'
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseWheel'; x = 700; y = 400; deltaX = 0; deltaY = -240; modifiers = 2 })
Start-Sleep -Milliseconds 400
$z1 = Eval 'document.querySelector("[data-dd-zoom]")?.innerText.match(/(\d+)%/)?.[1] ?? ""'
Check 'Ctrl+滚轮能缩放' ([int]$z1 -gt [int]$z0) "before=$z0 after=$z1"
[void](Eval '(() => { const b = [...document.querySelectorAll("[data-dd-zoom] button")].find((x) => (x.textContent||"").includes("适合内容")); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 400
$z2 = Eval 'document.querySelector("[data-dd-zoom]")?.innerText.match(/(\d+)%/)?.[1] ?? ""'
Check '「适合内容」把缩放拉回能看全' ([int]$z2 -le 100) "zoom=$z2"
Shot 'canvas-fit'

Write-Host 'B3. 双击空白处加一块'
$before = Num 'document.querySelectorAll("[data-dd-board-block]").length'
[void](Eval '(() => { const el = document.querySelector("[data-dd-board-canvas]"); const r = el.getBoundingClientRect(); const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width - 260, clientY: r.top + 240 }; el.dispatchEvent(new MouseEvent("dblclick", opts)); return true })()')
Start-Sleep -Milliseconds 1000
$after = Num 'document.querySelectorAll("[data-dd-board-block]").length'
Check '双击空白处多了一个块' ($after -eq $before + 1) "before=$before after=$after"
$newId = Eval "$BOARD.layout.order[$($before)]"
$newPos = Eval "$BOARD.layout.pos['$newId'] ? JSON.stringify($BOARD.layout.pos['$newId']) : ''"
Check '新块带着自己的坐标落盘' ([bool]("$newPos" -match '"x"')) "pos=$newPos"
Check '落点不在原点（是双击那里）' (-not [bool]("$newPos" -match '"x":0,"y":0')) "pos=$newPos"
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'rawKeyDown'; key = 'z'; code = 'KeyZ'; windowsVirtualKeyCode = 90; modifiers = 2 })
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'z'; code = 'KeyZ'; windowsVirtualKeyCode = 90; modifiers = 2 })
Start-Sleep -Milliseconds 900
$afterUndo = Num 'document.querySelectorAll("[data-dd-board-block]").length'
Check '撤销把多出来的那块收回去了' ($afterUndo -eq $before) "n=$afterUndo"

Write-Host 'C. 编辑块：只改这一块，改完真的落盘'
[void](Eval '(() => { const el = document.querySelector("[data-dd-card=\"n2\"] .dd-board-input"); if (!el) return false; el.focus(); const s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); s.addRange(r); return true })()')
[void](Send-Cdp 'Input.insertText' @{ text = '（已改）' })
Start-Sleep -Milliseconds 1300
$text2 = Eval 'window.__files["白板/项目.board"].text'
Check '磁盘上的块内容更新了' ([bool]("$text2" -match '已改')) ''
$linkKept = Eval "$BOARD.links.length"
Check '连接没有被编辑冲掉' ($linkKept -eq 1) "links=$linkKept"
$n1Kept = Eval "$BOARD.blocks.n1.content[0].text"
Check '其它块也没被动' ($n1Kept -eq '本周目标') "n1=$n1Kept"
$status2 = Eval 'document.querySelector("header span[aria-live]")?.textContent ?? ""'
Check '状态回到已保存' ($status2 -eq '已保存') "status=$status2"

Write-Host 'D. 撤销 / 重做'
[void](Eval 'document.querySelector("button[aria-label=撤销]").click()')
Start-Sleep -Milliseconds 1000
$text3 = Eval 'window.__files["白板/项目.board"].text'
Check '撤销后磁盘上也没有那句话' (-not [bool]("$text3" -match '已改')) ''
[void](Eval 'document.querySelector("button[aria-label=重做]").click()')
Start-Sleep -Milliseconds 1000
$text4 = Eval 'window.__files["白板/项目.board"].text'
Check '重做后又回来了' ([bool]("$text4" -match '已改')) ''

Write-Host 'E. 添加元素菜单'
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "添加元素"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 400
Check '菜单里有「待办」' (MenuItem '待办') ''
Start-Sleep -Milliseconds 900
$blockN2 = Num 'document.querySelectorAll("[data-dd-board-block]").length'
Check '画布上多了一块' ($blockN2 -eq 3) "n=$blockN2"
$hasPos = Eval "(() => { const d = $BOARD; return d.layout.order.every((id) => d.layout.pos[id] && typeof d.layout.pos[id].x === 'number') })()"
Check '三块都有坐标（不再靠顺序排）' ([bool]$hasPos) ''

Write-Host 'E2. 从文件树拖进来 = 引用（不复制）'
$duskBefore = Eval 'Object.keys(window.__files).filter((p) => p.startsWith(".dusk/")).length'
[void](Eval @'
(() => {
  const dt = new DataTransfer();
  dt.setData('text/plain', '素材/图.png');
  const el = document.querySelector('[data-dd-board-canvas]');
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const at = { clientX: r.right - 300, clientY: r.top + 70 };
  el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
  el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
  return true;
})()
'@)
Start-Sleep -Milliseconds 1100
$refBlock = Eval "(() => { const d = $BOARD; const id = d.layout.order[d.layout.order.length-1]; const b = d.blocks[id]; return JSON.stringify({ type: b.type, src: b.src, source: b.source, pos: d.layout.pos[id] }) })()"
Check '落下来是一张引用卡片' ([bool]("$refBlock" -match '"source":"link"')) "block=$refBlock"
Check '引用的是那个仓库文件' ([bool]("$refBlock" -match '素材/图.png')) "block=$refBlock"
Check '引用也带着落点坐标' ([bool]("$refBlock" -match '"pos":\{"x"')) "block=$refBlock"
$duskAfter = Eval 'Object.keys(window.__files).filter((p) => p.startsWith(".dusk/")).length'
Check '没有复制出附件目录' ($duskAfter -eq $duskBefore) "before=$duskBefore after=$duskAfter"

Write-Host 'F. 摆位置：方向键微调 + 拖动 + 调宽'
[void](Eval '(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); const el = document.querySelector("[data-dd-card=\"n2\"]"); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 })); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); return true })()')
Start-Sleep -Milliseconds 400
$x0 = Eval "$BOARD.layout.pos.n2.x"
Key 'ArrowRight' 'ArrowRight' 39
Key 'ArrowRight' 'ArrowRight' 39
Start-Sleep -Milliseconds 1000
$xn = Eval "$BOARD.layout.pos.n2.x"
Check '方向键能把块往右挪 16px' ([int]$xn -eq [int]$x0 + 16) "before=$x0 after=$xn"

$grip = BoxOf '[data-dd-card="n2"] [data-dd-card-grip]'
Check '拿得到拖动握把' ($grip -ne '') "grip=$grip"
if ($grip -ne '') {
  $g = $grip.Split(',')
  DragTo ([double]$g[0]) ([double]$g[1]) ([double]$g[0] + 90) ([double]$g[1] + 60)
  Start-Sleep -Milliseconds 1000
  $xm = [int](Eval "$BOARD.layout.pos.n2.x")
  $ym = [int](Eval "$BOARD.layout.pos.n2.y")
  Check '拖动能改坐标（右移约 90 / 下移约 60）' (($xm -gt [int]$xn + 60) -and ($ym -gt 280)) "x=$xm y=$ym"
  Check '拖动后还是已保存' ((Eval 'document.querySelector("header span[aria-live]")?.textContent') -eq '已保存') ''
} else {
  Check '拖动能改坐标（右移约 90 / 下移约 60）' $false 'no grip'
  Check '拖动后还是已保存' $false 'no grip'
}

$w0 = [int](Eval "$BOARD.layout.pos.n2.w")
$rh = BoxOf '[data-dd-card="n2"] [title="拖动调整宽度"]'
if ($rh -ne '') {
  $r = $rh.Split(',')
  DragTo ([double]$r[0]) ([double]$r[1]) ([double]$r[0] + 70) ([double]$r[1])
  Start-Sleep -Milliseconds 1000
  $w1 = [int](Eval "$BOARD.layout.pos.n2.w")
  Check '拖右边缘能改宽度' ($w1 -gt $w0 + 40) "before=$w0 after=$w1"
} else {
  Check '拖右边缘能改宽度' $false 'no handle'
}
Shot 'canvas-moved'

Write-Host 'F2. 悬停卡片：四个锚点都出来，而且不和拖动/调宽手柄抢位置'
$cbox = BoxOf '[data-dd-card="n1"]'
if ($cbox -ne '') {
  $cb = $cbox.Split(',')
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = [double]$cb[0]; y = [double]$cb[1]; buttons = 0 })
  Start-Sleep -Milliseconds 350
  $op = Eval '(() => { const el = document.querySelector("[data-dd-card=\"n1\"] [data-dd-port=\"top\"]"); if (!el) return "-1"; return String(getComputedStyle(el).opacity) })()'
  Check '悬停后锚点可见（不是藏着摸不到）' ([double]$op -gt 0.5) "opacity=$op"
  $opGrip = Eval '(() => { const el = document.querySelector("[data-dd-card=\"n1\"] [data-dd-card-grip]"); return el ? String(getComputedStyle(el).opacity) : "-1" })()'
  $opResize = Eval '(() => { const el = document.querySelector("[data-dd-card=\"n1\"] [title=\"拖动调整宽度\"]"); return el ? String(getComputedStyle(el).opacity) : "-1" })()'
  Check '拖动握把和调宽手柄也一起出来' (([double]$opGrip -gt 0.5) -and ([double]$opResize -gt 0.5)) "grip=$opGrip resize=$opResize"
  $shapes = Eval '(() => { const card = document.querySelector("[data-dd-card=\"n1\"]"); const items = [...card.querySelectorAll("[data-dd-port], [data-dd-card-grip], [title=\"拖动调整宽度\"]")]; return JSON.stringify(items.map((el) => { const r = el.getBoundingClientRect(); return { k: el.dataset.ddPort || el.getAttribute("title"), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } })) })()'
  $list = $shapes | ConvertFrom-Json
  Check '四个锚点 + 两个手柄都在' ($list.Count -eq 6) "n=$($list.Count)"
  $clash = @()
  for ($i = 0; $i -lt $list.Count; $i++) {
    for ($j = $i + 1; $j -lt $list.Count; $j++) {
      $a = $list[$i]; $b = $list[$j]
      if ($a.x -lt ($b.x + $b.w) -and ($a.x + $a.w) -gt $b.x -and $a.y -lt ($b.y + $b.h) -and ($a.y + $a.h) -gt $b.y) {
        $clash += "$($a.k)/$($b.k)"
      }
    }
  }
  Check '锚点和手柄互不重叠（不然会抢鼠标）' ($clash.Count -eq 0) "clash=$($clash -join ',')"
  Shot 'canvas-hover-ports'
} else {
  Check '悬停后锚点可见（不是藏着摸不到）' $false 'no card'
  Check '四个锚点 + 两个手柄都在' $false 'no card'
  Check '锚点和手柄互不重叠（不然会抢鼠标）' $false 'no card'
}

Write-Host 'F3. 两个手势必须分得开：按住卡片是拖，按住圆点才是连线'
$edgePt = Eval '(() => { const r = document.querySelector("[data-dd-card=\"n1\"]").getBoundingClientRect(); return [Math.round(r.left + 3), Math.round(r.top + r.height / 2)].join(",") })()'
$posX0 = [int](Eval "$BOARD.layout.pos.n1.x")
$posY0 = [int](Eval "$BOARD.layout.pos.n1.y")
$ep = $edgePt.Split(',')
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = [double]$ep[0]; y = [double]$ep[1]; button = 'left'; clickCount = 1; buttons = 1 })
Start-Sleep -Milliseconds 60
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = [double]$ep[0] + 44; y = [double]$ep[1] + 26; button = 'left'; buttons = 1 })
Start-Sleep -Milliseconds 260
Check '按在卡片边上拖，不会冒出连线预览' ((Num 'document.querySelectorAll("[data-dd-board-wire]").length') -eq 0) ''
$portVisible = Eval '(() => { const el = document.querySelector("[data-dd-card=\"n1\"] [data-dd-port=\"top\"]"); if (!el) return "-1"; return String(getComputedStyle(el).opacity) })()'
Check '拖动中锚点确实隐藏了' ([double]$portVisible -lt 0.2) "opacity=$portVisible"
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = [double]$ep[0] + 44; y = [double]$ep[1] + 26; button = 'left'; clickCount = 1; buttons = 0 })
Start-Sleep -Milliseconds 900
$posX1 = [int](Eval "$BOARD.layout.pos.n1.x")
$posY1 = [int](Eval "$BOARD.layout.pos.n1.y")
Check '按在边上确实拖动的是卡片本身' (($posX1 -gt $posX0 + 20) -and ($posY1 -gt $posY0 + 10)) "x=$posX0->$posX1 y=$posY0->$posY1"

Write-Host 'F4. 从圆点拖，卡片一点不动'
$posX2 = [int](Eval "$BOARD.layout.pos.n1.x")
$portPt = BoxOf '[data-dd-card="n1"] [data-dd-port="top"]'
$blankPt = Eval '(() => { const r = document.querySelector("[data-dd-board-canvas]").getBoundingClientRect(); return [Math.round(r.left + 90), Math.round(r.top + 90)].join(",") })()'
if ($portPt -ne '') {
  $pp = $portPt.Split(',')
  $bp = $blankPt.Split(',')
  DragTo ([double]$pp[0]) ([double]$pp[1]) ([double]$bp[0]) ([double]$bp[1])
  Start-Sleep -Milliseconds 700
  $posX3 = [int](Eval "$BOARD.layout.pos.n1.x")
  Check '拖线不会顺手把卡片挪走' ($posX3 -eq $posX2) "x=$posX2->$posX3"
} else {
  Check '拖线不会顺手把卡片挪走' $false 'no port'
}
Write-Host 'G0. 直接拖线：从卡片边上的圆点拖到另一块就建连接'
$linksBefore = [int](Eval "$BOARD.links.length")
$portCount = Num 'document.querySelectorAll("[data-dd-card] [data-dd-port]").length'
Check '每张卡都有四个连接锚点' ($portCount -ge 12) "n=$portCount"
$wireFrom = BoxOf '[data-dd-card="n2"] [data-dd-port="right"]'
$wireTo = BoxOf '[data-dd-card="n1"] [data-dd-port="bottom"]'
Check '拿得到起点锚点' ($wireFrom -ne '') "pt=$wireFrom"
Check '拿得到目标锚点' ($wireTo -ne '') "pt=$wireTo"
$hitOk = Eval "(() => { const p = '$wireTo'.split(',').map(Number); const el = document.elementFromPoint(p[0], p[1]); return Boolean(el && el.closest('[data-dd-card=\"n1\"]')) })()"
Check '松手点确实落在 n1 上' ([bool]$hitOk) "target=$wireTo"
if ($wireFrom -ne '' -and $wireTo -ne '') {
  $wf = $wireFrom.Split(',')
  $wt = $wireTo.Split(',')
  # 拖到一半先停一下：应该出现一条跟着走的预览线
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = [double]$wf[0]; y = [double]$wf[1]; button = 'left'; clickCount = 1; buttons = 1 })
  Start-Sleep -Milliseconds 60
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = [double]$wt[0]; y = [double]$wt[1]; button = 'left'; buttons = 1 })
  Start-Sleep -Milliseconds 250
  Check '拖动中有预览线' ((Num 'document.querySelectorAll("[data-dd-board-wire]").length') -eq 1) ''
  Check '悬停的卡片被标出来' ((Num 'document.querySelectorAll("[data-dd-card=\"n1\"][class*=ring-green]").length') -eq 1) ''
  Shot 'canvas-wire'
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = [double]$wt[0]; y = [double]$wt[1]; button = 'left'; clickCount = 1; buttons = 0 })
  Start-Sleep -Milliseconds 1100
  $linksAfter = [int](Eval "$BOARD.links.length")
  Check '松手就多了一条连接' ($linksAfter -eq $linksBefore + 1) "before=$linksBefore after=$linksAfter"
  $wireLink = Eval "(() => { const d = $BOARD; const l = d.links[d.links.length-1]; return JSON.stringify({ from: l.from, to: l.to, type: l.type, fromSide: l.fromSide, toSide: l.toSide }) })()"
  Check '连接记下了起点和终点' ([bool]("$wireLink" -match '"from":"n2"') -and [bool]("$wireLink" -match '"to":"n1"')) "link=$wireLink"
  Check '记下从哪条边拖出来的' ([bool]("$wireLink" -match '"fromSide":"right"')) "link=$wireLink"
  Check '终点吸附到朝向起点的那条边' ([bool]("$wireLink" -match '"toSide":"bottom"')) "link=$wireLink"
  Check '默认是「相关」类型（不用先选）' ([bool]("$wireLink" -match '"type":"related"')) "link=$wireLink"
  Check '画布上多了一条线' ((Num 'document.querySelectorAll("[data-dd-board-link]").length') -eq $linksAfter) ''
  Check '提示说清楚了这两块连上了' ([bool]((Eval 'document.body.innerText') -match '已连接')) ''
  Check '拖完落盘了' ((Eval 'document.querySelector("header span[aria-live]")?.textContent') -eq '已保存') ''
} else {
  Check '松手就多了一条连接' $false 'no port'
  Check '连接记下了起点和终点' $false 'no port'
  Check '记下从哪条边拖出来的' $false 'no port'
  Check '终点吸附到朝向起点的那条边' $false 'no port'
  Check '默认是「相关」类型（不用先选）' $false 'no port'
  Check '画布上多了一条线' $false 'no port'
  Check '提示说清楚了这两块连上了' $false 'no port'
  Check '拖完落盘了' $false 'no port'
}

Write-Host 'G0b. 拖到空白处不建连接，并且明说没连上'
$linksKeep = [int](Eval "$BOARD.links.length")
$blankFrom = BoxOf '[data-dd-card="n2"] [data-dd-port="top"]'
$blankAt = Eval '(() => { const r = document.querySelector("[data-dd-board-canvas]").getBoundingClientRect(); return [Math.round(r.left + 70), Math.round(r.top + 70)].join(",") })()'
if ($blankFrom -ne '') {
  $bf = $blankFrom.Split(',')
  $ba = $blankAt.Split(',')
  DragTo ([double]$bf[0]) ([double]$bf[1]) ([double]$ba[0]) ([double]$ba[1])
  Start-Sleep -Milliseconds 700
  Check '空白处松手不会建连接' ([int](Eval "$BOARD.links.length") -eq $linksKeep) ''
  Check '并且提示没连上（不是静默失败）' ([bool]((Eval 'document.body.innerText') -match '没连上')) ''
  Check '预览线收掉了' ((Num 'document.querySelectorAll("[data-dd-board-wire]").length') -eq 0) ''
} else {
  Check '空白处松手不会建连接' $false 'no port'
  Check '并且提示没连上（不是静默失败）' $false 'no port'
  Check '预览线收掉了' $false 'no port'
}

Write-Host 'G. 建立连接（选中块 → 工具条）'
[void](Eval '(() => { const el = document.querySelector("[data-dd-card=\"n1\"]"); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 })); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); return true })()')
Start-Sleep -Milliseconds 400
Check '选中块后出现工具条' ((Num 'document.querySelectorAll("[data-dd-board-toolbar]").length') -eq 1) ''
Check '点工具条上的「连接到…」' ([bool](Eval '(() => { const b = document.querySelector("[data-dd-board-toolbar] button[aria-label=\"连接到…\"]"); if (!b) return false; b.click(); return true })()')) ''
Start-Sleep -Milliseconds 500
Check '打开连接对话框' ((Num 'document.querySelectorAll("[role=dialog][aria-label=新建块间连接]").length') -eq 1) ''
[void](Eval '(() => { const s = document.querySelector("[role=dialog] select"); if (!s) return false; s.value = s.options[1] ? s.options[1].value : s.value; s.dispatchEvent(new Event("change", { bubbles: true })); return true })()')
[void](Eval '(() => { const b = [...document.querySelectorAll("[role=dialog] button")].find((x) => (x.textContent||"").trim() === "建立连接"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 1000
$linksViaDialog = [int](Eval "$BOARD.links.length")
Check '磁盘上多了一条连接' ($linksViaDialog -eq $linksKeep + 1) "links=$linksViaDialog"
Check '画布上每条连接都画出来了' ((Num 'document.querySelectorAll("[data-dd-board-link]").length') -eq $linksViaDialog) ''
Check '连接面板列出全部' ((Num 'document.querySelectorAll("[data-dd-board-link-row]").length') -eq $linksViaDialog) ''
Shot 'canvas-links'

Write-Host 'G2. 关掉重开：坐标、连接、正文都还在'
$posBefore = Eval "JSON.stringify($BOARD.layout.pos)"
[void](Eval '(() => { const b = [...document.querySelectorAll("button[aria-label]")].find((x) => (x.getAttribute("aria-label") || "").startsWith("关闭 项目.board")); if (!b) return false; b.click(); return true })()')
Start-Sleep -Milliseconds 800
Check '白板标签关掉了' ((Num 'document.querySelectorAll("[data-dd-board-canvas]").length') -eq 0) ''
[void](ClickText '项目.board')
Start-Sleep -Milliseconds 1700
$posAfter = Eval "JSON.stringify($BOARD.layout.pos)"
Check '重开后每块的位置一模一样' ($posAfter -eq $posBefore) "before=$posBefore after=$posAfter"
Check '重开后连接还在' ((Num 'document.querySelectorAll("[data-dd-board-link]").length') -eq $linksViaDialog) "want=$linksViaDialog"
Check '重开后正文就是改过的那份' ([bool]((Eval 'document.querySelector("[data-dd-board-canvas]")?.innerText ?? ""') -match '（已改）')) ''

Write-Host 'H. 保存失败：状态必须是失败，重试能成功'
[void](Eval "window.__failWrite = '白板/项目.board'; 'ok'")
[void](Eval '(() => { const el = document.querySelector("[data-dd-card=\"n2\"] .dd-board-input"); if (!el) return false; el.focus(); const s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); s.addRange(r); return true })()')
[void](Send-Cdp 'Input.insertText' @{ text = '失败测试' })
Start-Sleep -Milliseconds 1500
$errStatus = Eval 'document.querySelector("header span[aria-live]")?.textContent'
Check '写盘失败时状态是「保存失败」' ($errStatus -eq '保存失败') "status=$errStatus"
Check '出现错误条（带重试）' ((Num 'document.querySelectorAll("[role=alert]").length') -ge 1) ''
[void](Eval "window.__failWrite = null; 'ok'")
[void](Eval '(() => { const b = [...document.querySelectorAll("[role=alert] button")].find((x) => (x.textContent||"").includes("重试")); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 1000
Check '重试后真的保存成功' ((Eval 'document.querySelector("header span[aria-live]")?.textContent') -eq '已保存') ''
Check '重试把改动写进去了' ([bool]((Eval 'window.__files["白板/项目.board"].text') -match '失败测试')) ''

Write-Host 'I. 改名：文件搬家 + 标签跟着换 + 内容还在'
Check '右键白板行' (RightClickRow '项目.board') ''
Start-Sleep -Milliseconds 300
Check '菜单里有重命名' (MenuItem '重命名') ''
Start-Sleep -Milliseconds 300
[void](Eval '(() => { const el = document.querySelector("[data-dd-files] input"); if (!el) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value"); setter.set.call(el, "项目白板"); el.dispatchEvent(new Event("input", { bubbles: true })); return true })()')
Start-Sleep -Milliseconds 200
Key 'Enter' 'Enter' 13
Start-Sleep -Milliseconds 1400
Check '磁盘上换成新文件名' ((Eval 'Object.keys(window.__files).filter((p) => p.endsWith(".board")).join(",")') -eq '白板/项目白板.board') ''
Check '旧文件没了' ((Eval '!("白板/项目.board" in window.__files)') -eq $true) ''
Check '标签页指向新路径' ([bool]((Eval '[...document.querySelectorAll("header button[title]")].map((b) => b.getAttribute("title")).join("|")') -match '项目白板.board')) ''
Check '白板还开着（没有因为改名关掉）' ((Num 'document.querySelectorAll("[data-dd-board-canvas]").length') -eq 1) ''
Start-Sleep -Milliseconds 1200
Check '文件里的标题跟着改名走了' ((Eval 'JSON.parse(window.__files["白板/项目白板.board"].text).title') -eq '项目白板') ''
Check '编辑器里的标题也换了' ((Eval 'document.querySelector("input[aria-label=白板标题]")?.value') -eq '项目白板') ''

Write-Host 'J. .note 的引用块：按 id 认，改名后仍然指向它'
Check '点开周会' (ClickText '周会') ''
Start-Sleep -Milliseconds 2400
$refText = Eval 'document.querySelector("[data-dd-flow-scroll]")?.innerText.replace(/\n+/g, " / ") ?? ""'
Check '引用块显示的是新名字（按 boardId 认出来的）' ([bool]("$refText" -match '项目白板')) "text=$refText"
Check '没有出现「白板找不到」' (-not [bool]("$refText" -match '白板找不到')) "text=$refText"
Shot 'note-boardref-1440'

Write-Host 'K. 从引用块打开 → 编辑 → 回笔记看到最新'
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "打开"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 1600
Check '引用块的「打开」进到了白板' ((Num 'document.querySelectorAll("[data-dd-board-canvas]").length') -ge 1) ''
[void](Eval '(() => { const el = document.querySelector("[data-dd-card=\"n2\"] .dd-board-input"); if (!el) return false; el.focus(); const s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); s.addRange(r); return true })()')
[void](Send-Cdp 'Input.insertText' @{ text = '（引用后改的）' })
Start-Sleep -Milliseconds 1300
[void](ClickText '周会')
Start-Sleep -Milliseconds 1800
Check '从笔记再看已是同一份最新数据' ([bool]((Eval 'document.querySelector("[data-dd-flow-scroll]")?.innerText ?? ""') -match '引用后改的')) ''

Write-Host 'L. 删除白板前：说清楚谁引用了它'
Check '右键白板行（删除）' (RightClickRow '项目白板') ''
Start-Sleep -Milliseconds 300
Check '点删除' (MenuItem '删除') ''
Start-Sleep -Milliseconds 1600
$dlgText = Eval 'document.querySelector("[role=dialog][aria-label=删除白板]")?.innerText.replace(/\n+/g, " / ") ?? ""'
Check '确认框里列出引用' ([bool]("$dlgText" -match '有 1 篇笔记引用了它')) "text=$dlgText"
Shot 'board-delete-dialog'
[void](Eval '(() => { const b = [...document.querySelectorAll("[role=dialog] button")].find((x) => (x.textContent||"").trim() === "先不删"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 300
Check '取消后文件还在' ((Eval '"白板/项目白板.board" in window.__files') -eq $true) ''

Write-Host 'M. 删掉引用块 ≠ 删掉白板'
[void](ClickText '周会')
Start-Sleep -Milliseconds 1400
[void](Eval '(() => { const b = document.querySelector("button[aria-label=\"块 b2 的菜单\"]"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 300
Check '引用块菜单里有删除' (MenuItem '删除这个块') ''
Start-Sleep -Milliseconds 1000
Check '笔记里引用块没了' ((Num 'document.querySelectorAll("[data-block-id=b2]").length') -eq 0) ''
Check '白板文件还在' ((Eval '"白板/项目白板.board" in window.__files') -eq $true) ''

Write-Host 'N. 删除白板：确认后文件真的消失'
[void](RightClickRow '项目白板')
Start-Sleep -Milliseconds 300
[void](MenuItem '删除')
Start-Sleep -Milliseconds 1600
$dlgText2 = Eval 'document.querySelector("[role=dialog][aria-label=删除白板]")?.innerText.replace(/\n+/g, " / ") ?? ""'
Check '没有引用时如实说没引用' ([bool]("$dlgText2" -match '没有笔记引用它')) "text=$dlgText2"
[void](Eval '(() => { const b = [...document.querySelectorAll("[role=dialog] button")].find((x) => (x.textContent||"").trim() === "删除白板"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 1100
Check '磁盘上删掉了' ((Eval '"白板/项目白板.board" in window.__files') -eq $false) ''
Check '树里也没有了' (-not [bool]((Eval '[...document.querySelectorAll("[data-dd-files] button")].map((b) => b.textContent.trim()).join("|")') -match '项目白板')) ''
Check '笔记没被连累' ((Eval '"笔记/周会.note/meta.json" in window.__files') -eq $true) ''

Write-Host 'O. 新建白板：默认就是空画布'
[void](RightClickRow '白板')
Start-Sleep -Milliseconds 300
Check '文件夹菜单里有「新建白板（.board）」' (MenuItem '新建白板（.board）') ''
Start-Sleep -Milliseconds 1100
[void](Eval '(() => { const el = document.querySelector("[data-dd-files] input"); if (!el) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value"); setter.set.call(el, "空板"); el.dispatchEvent(new Event("input", { bubbles: true })); return true })()')
Start-Sleep -Milliseconds 200
Key 'Enter' 'Enter' 13
Start-Sleep -Milliseconds 1100
Check '磁盘上建出了 空板.board' ((Eval 'Object.keys(window.__files).filter((p) => p.endsWith(".board")).join(",")') -eq '白板/空板.board') ''
Check '新建的白板直接打开了画布' ((Num 'document.querySelectorAll("[data-dd-board-canvas]").length') -ge 1) ''
Check '空白画布有明确提示' ([bool]((Eval 'document.querySelector("[data-dd-board-canvas]")?.innerText ?? ""') -match '这块白板还是空的')) ''
Check '新文件是 free 布局' ((Eval 'JSON.parse(window.__files["白板/空板.board"].text).layout.mode') -eq 'free') ''
Shot 'canvas-empty'

Write-Host 'P. PDF 图标：树 / 标签页 / 右栏'
Check '点开 PDF' (ClickText '文档.pdf') ''
Start-Sleep -Milliseconds 2300
Check '标签页里有 PDF 图标' ((Num 'document.querySelectorAll("header [data-icon=pdf]").length') -ge 1) ''
Check '右栏文件信息里也有' ((Num 'document.querySelectorAll("aside[aria-label=文件信息] [data-icon=pdf]").length') -ge 1) ''
$iconBox = Eval '(() => { const s = document.querySelector("aside[aria-label=文件信息] [data-icon=pdf]"); if (!s) return ""; const r = s.getBoundingClientRect(); return Math.round(r.width) + "x" + Math.round(r.height) })()'
Check '右栏图标 20×20（和别的文件类型一致）' ($iconBox -eq '20x20') "box=$iconBox"
Shot 'pdf-icon-fixed'

Write-Host 'Q. 窄窗口：画布不横向溢出'
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1024; height = 768; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 700
[void](ClickText '空板')
Start-Sleep -Milliseconds 1300
$overflow = Eval 'document.documentElement.scrollWidth - document.documentElement.clientWidth'
Check '1024 宽没有横向溢出' ($overflow -le 0) "overflow=$overflow"
Check '画布还在（没有被挤没）' ((Num 'document.querySelectorAll("[data-dd-board-canvas]").length') -ge 1) ''
Shot 'canvas-1024'
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1440; height = 900; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 500

Write-Host 'R. 没有运行时报错'
$errs = Eval 'window.__errs.join(" | ")'
Check '控制台没有未捕获错误' (-not [bool]$errs) "errs=$errs"

Write-Host ''
Write-Host "通过 $script:pass / $($script:pass + $script:fail)"
if ($script:fail -gt 0) { Write-Host "失败 $script:fail"; exit 1 }

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
