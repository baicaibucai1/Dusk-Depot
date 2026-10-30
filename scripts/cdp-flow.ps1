param([string]$Url = 'http://127.0.0.1:5184/')
# 文档流 `.note`（v2）· 交互验收
#
# 假目录里放三样东西：一篇 md、一篇 v1 画布笔记、一篇 v2 文档流笔记。
# 走真实 FSA 句柄（getFileHandle / createWritable），写盘会记进 window.__log。
$ErrorActionPreference = 'Stop'
$url = $Url
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddf-' + [guid]::NewGuid().ToString('N'))
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
  $msg = @{ id = $myId; method = $method; params = $params } | ConvertTo-Json -Depth 10 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, [Threading.CancellationToken]::None).Wait()
  while ($true) {
    $buf = [byte[]]::new(2097152); $sb = [System.Text.StringBuilder]::new()
    do { $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None).Result; [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)) } while (-not $res.EndOfMessage)
    $obj = $sb.ToString() | ConvertFrom-Json
    if ($obj.id -eq $myId) { return $obj }
  }
}
function Eval([string]$expr) {
  $r = Send-Cdp 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true; awaitPromise = $true }
  if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.exception.description }
  return $r.result.result.value
}
function Num([string]$expr) {
  $v = Eval $expr
  if ("$v" -like 'EXC:*' -or "$v" -eq '') { return -1 }
  return [int]$v
}
function Click([double]$x, [double]$y) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  Start-Sleep -Milliseconds 300
}
function MoveTo([double]$x, [double]$y) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none' })
  Start-Sleep -Milliseconds 200
}
function SelectRange([double]$x1, [double]$y1, [double]$x2, [double]$y2) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x1; y = $y1; button = 'none' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x1; y = $y1; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x2; y = $y2; button = 'left' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x2; y = $y2; button = 'left'; clickCount = 1 })
  Start-Sleep -Milliseconds 380
}
function Key([string]$key, [int]$code, [string]$text = '', [int]$mods = 0) {
  $p = @{ type = 'keyDown'; key = $key; windowsVirtualKeyCode = $code; nativeVirtualKeyCode = $code; modifiers = $mods }
  if ($text -ne '') { $p['text'] = $text; $p['unmodifiedText'] = $text }
  [void](Send-Cdp 'Input.dispatchKeyEvent' $p)
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $key; windowsVirtualKeyCode = $code; nativeVirtualKeyCode = $code; modifiers = $mods })
  Start-Sleep -Milliseconds 110
}
function TypeText([string]$s) {
  [void](Send-Cdp 'Input.insertText' @{ text = $s })
  Start-Sleep -Milliseconds 180
}
$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}
function Rect([string]$expr) {
  $r = Eval "(() => { const el = $expr; if (!el) return ''; const q = el.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
  if ($r -eq '') { return $null }
  $p = $r.Split(',')
  return @([double]$p[0], [double]$p[1], [double]$p[2], [double]$p[3])
}
function ClickSelector([string]$selector) {
  $r = Rect "document.querySelector('$selector')"
  if ($null -eq $r) { return $false }
  Click ($r[0] + $r[2] / 2) ($r[1] + $r[3] / 2)
  return $true
}
function ClickRow([string]$text) {
  $r = Eval "(() => { const b = [...document.querySelectorAll('[data-dd-files] button')].find((x) => x.textContent.trim() === '$text'); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  Click ([double]$p[0] + 20) ([double]$p[1] + [double]$p[3] / 2)
  return $true
}
function BlockRect([int]$i) {
  return Rect "document.querySelectorAll('.dd-flow > *')[$i]"
}
function ScrollTo([int]$i) {
  [void](Eval "document.querySelectorAll('.dd-flow > *')[$i]?.scrollIntoView({ block: 'center' })")
  Start-Sleep -Milliseconds 260
}
function FocusBlock([int]$i) {
  # 先滚到视野中间 —— 底下的块可能已经在折叠线以外，点不到
  [void](Eval "document.querySelectorAll('.dd-flow > *')[$i]?.scrollIntoView({ block: 'center' })")
  Start-Sleep -Milliseconds 240
  $r = BlockRect $i
  if ($null -eq $r) { return $false }
  $y = $r[1] + [Math]::Min(12, [Math]::Max(6, $r[3] / 2))
  Click ($r[0] + 14) $y
  return [bool]((Eval 'document.activeElement?.className') -match 'dd-flow')
}
function BlockCount { return Num "document.querySelectorAll('.dd-flow > *').length" }

Start-Sleep -Milliseconds 900
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

$root = 'C:\AI_Production\Dusk Depot'
$pngB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$root\示例库\素材\示例图片.png"))

$STUB = @"
(() => {
  window.__files = {};
  window.__dirs = new Set(['']);
  window.__log = [];
  window.__errs = [];
  const enc = new TextEncoder();
  function put(p, text) {
    window.__files[p] = { text: text };
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) window.__dirs.add(parts.slice(0, i).join('/'));
  }
  function b64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function childrenOf(path) {
    const prefix = path ? path + '/' : '';
    const names = new Set();
    for (const p of Object.keys(window.__files)) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (!rest) continue;
      names.add(rest.split('/')[0]);
    }
    for (const d of window.__dirs) {
      if (!d || d === path || !d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (!rest) continue;
      names.add(rest.split('/')[0]);
    }
    const out = [];
    for (const n of names) out.push({ name: n, kind: (prefix + n) in window.__files ? 'file' : 'directory' });
    return out;
  }
  function mk(path) {
    const h = { kind: 'directory', name: path ? path.split('/').pop() : '库' };
    const def = (k, v) => Object.defineProperty(h, k, { value: v, enumerable: false });
    def('values', async function* () { for (const c of childrenOf(path)) yield c });
    def('getDirectoryHandle', async (n) => { const full = path ? path + '/' + n : n; window.__dirs.add(full); return mk(full) });
    def('getFileHandle', async (n, opts) => {
      const full = path ? path + '/' + n : n;
      if (!(full in window.__files) && !(opts && opts.create)) throw new DOMException('not found', 'NotFoundError');
      return {
        async getFile() {
          const f = window.__files[full];
          if (!f) throw new DOMException('not found', 'NotFoundError');
          const data = f.text !== undefined ? enc.encode(f.text) : b64(f.b64);
          return new File([data], n);
        },
        async createWritable() {
          let buf = '';
          return {
            async write(d) { buf += d instanceof Blob ? await d.text() : String(d) },
            async close() {
              if (window.__failWrites && full.indexOf('新文档') === 0) throw new DOMException('disk full', 'NotReadableError');
              window.__files[full] = { text: buf }; window.__log.push('write:' + full);
            },
          };
        },
      };
    });
    def('removeEntry', async (n) => {
      const full = path ? path + '/' + n : n;
      for (const p of Object.keys(window.__files)) {
        if (p === full || p.startsWith(full + '/')) delete window.__files[p];
      }
      for (const d of Array.from(window.__dirs)) {
        if (d === full || d.startsWith(full + '/')) window.__dirs.delete(d);
      }
      window.__log.push('remove:' + full);
    });
    def('queryPermission', async () => 'granted');
    def('requestPermission', async () => 'granted');
    return h;
  }
  window.showDirectoryPicker = async () => mk('');

  put('笔记.md', '# 笔记\n\n一篇普通的 markdown。\n');
  window.__files['素材/图.png'] = { b64: '$pngB64' };
  window.__dirs.add('素材');

  put('旧画布.note/.note', JSON.stringify({ app: 'dusk-depot', format: 'blocks', version: 1 }, null, 2));
  put('旧画布.note/meta.json', JSON.stringify({ title: '旧画布', createdAt: '2026-01-01T00:00:00.000Z' }, null, 2));
  put('旧画布.note/order.json', JSON.stringify(['b1', 'b2'], null, 2));
  put('旧画布.note/blocks/b1.json', JSON.stringify({ id: 'b1', type: 'paragraph', text: '画布块一', layout: { x: 0, y: 20, w: 60 } }, null, 2));
  put('旧画布.note/blocks/b2.json', JSON.stringify({ id: 'b2', type: 'paragraph', text: '画布块二', layout: { x: 0, y: 120, w: 60 } }, null, 2));

  put('新文档.note/.note', JSON.stringify({ app: 'dusk-depot', format: 'blocks', version: 2, layoutMode: 'flow' }, null, 2));
  put('新文档.note/meta.json', JSON.stringify({ title: '新文档', createdAt: '2026-10-30T00:00:00.000Z' }, null, 2));
  put('新文档.note/order.json', JSON.stringify(['b1','b2','b3','b4','b5','b6','b7','b8','b9'], null, 2));
  put('新文档.note/blocks/b1.json', JSON.stringify({ id: 'b1', type: 'heading1', content: [{ type: 'text', text: '文档流验收' }] }, null, 2));
  put('新文档.note/blocks/b2.json', JSON.stringify({ id: 'b2', type: 'paragraph', content: [
    { type: 'text', text: '这一段有 ' },
    { type: 'text', text: '粗体', marks: ['bold'] },
    { type: 'text', text: '、' },
    { type: 'text', text: '斜体', marks: ['italic'] },
    { type: 'text', text: '、' },
    { type: 'text', text: '行内代码', marks: ['code'] },
    { type: 'text', text: ' 和 ' },
    { type: 'text', text: '内部链接', marks: [{ type: 'link', href: '笔记.md' }] },
    { type: 'text', text: '。' }
  ] }, null, 2));
  put('新文档.note/blocks/b3.json', JSON.stringify({ id: 'b3', type: 'bulletList', items: [
    { content: [{ type: 'text', text: '第一个要点' }] },
    { content: [{ type: 'text', text: '第二个要点' }] }
  ] }, null, 2));
  put('新文档.note/blocks/b4.json', JSON.stringify({ id: 'b4', type: 'todoList', items: [
    { checked: true, content: [{ type: 'text', text: '已经做完' }] },
    { checked: false, content: [{ type: 'text', text: '还没做' }] }
  ] }, null, 2));
  put('新文档.note/blocks/b5.json', JSON.stringify({ id: 'b5', type: 'code', text: 'const a = 1', lang: 'ts' }, null, 2));
  put('新文档.note/blocks/b6.json', JSON.stringify({ id: 'b6', type: 'divider' }, null, 2));
  put('新文档.note/blocks/b7.json', JSON.stringify({ id: 'b7', type: 'image', src: '素材/图.png', alt: '示例' }, null, 2));
  put('新文档.note/blocks/b8.json', JSON.stringify({ id: 'b8', type: 'database', version: 3, payload: { keep: true } }, null, 2));
  put('新文档.note/blocks/b9.json', JSON.stringify({ id: 'b9', type: 'paragraph', content: [] }, null, 2));

  const ce = console.error.bind(console);
  console.error = function () {
    window.__errs.push(Array.from(arguments).map(String).join(' '));
    ce.apply(null, arguments);
  };
  window.addEventListener('error', (e) => window.__errs.push('error: ' + String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => window.__errs.push('reject: ' + String(e.reason)));
  return 'stubbed';
})();
"@

[void](Send-Cdp 'Page.navigate' @{ url = $url })
Start-Sleep -Milliseconds 2600
$stub = Eval $STUB
Check '假目录装上了' ("$stub" -eq 'stubbed') "res=$stub"
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("选择文件夹")).click()')
Start-Sleep -Milliseconds 2400
$logBase = Num 'window.__log.length'

Write-Host ''
Write-Host 'A. 文件树与打开'
$rows = Eval '[...document.querySelectorAll("[data-dd-files] button")].map((b) => b.textContent.trim()).filter(Boolean).join("|")'
Check '树里有旧画布与新文档' ([bool](($rows -match '旧画布') -and ($rows -match '新文档'))) "rows=$rows"
if (-not (ClickRow '新文档.note')) { Write-Host 'FAIL  点不到新文档'; $fail++ }
Start-Sleep -Milliseconds 1200
Check '进的是文档流编辑器' ((Num 'document.querySelectorAll(".dd-flow").length') -eq 1) ''
Check '块数 9' ((BlockCount) -eq 9) "n=$(BlockCount)"
Check '打开不写盘' ((Num 'window.__log.length') -eq $logBase) "log=$(Eval 'window.__log.join(",")')"

Write-Host ''
Write-Host 'B. 块类型逐个渲染'
Check '一级标题' ((Eval 'document.querySelector(".dd-flow h1")?.textContent') -eq '文档流验收') ''
Check '粗体 / 斜体 / 行内码' ((Num 'document.querySelectorAll(".dd-flow strong").length') -ge 1 -and (Num 'document.querySelectorAll(".dd-flow em").length') -ge 1 -and (Num 'document.querySelectorAll(".dd-flow p code").length') -ge 1) ''
Check '链接 href 保留' ((Eval 'document.querySelector(".dd-flow a")?.getAttribute("href")') -eq '笔记.md') ''
Check '项目符号列表 2 项' ((Num 'document.querySelectorAll(".dd-flow ul:not([data-type]) > li").length') -eq 2) ''
Check '待办 2 项、一勾一空' ((Num 'document.querySelectorAll(".dd-flow ul[data-type=taskList] input:checked").length') -eq 1 -and (Num 'document.querySelectorAll(".dd-flow ul[data-type=taskList] li").length') -eq 2) ''
Check '代码块语言是 ts' ([bool]((Eval 'document.querySelector(".dd-flow pre code")?.className') -match 'language-ts')) "cls=$(Eval 'document.querySelector(".dd-flow pre code")?.className')"
Check '分隔线存在' ((Num 'document.querySelectorAll(".dd-flow hr").length') -eq 1) ''
Check '图片读成了 blob' ([bool]((Eval 'document.querySelector(".dd-flow-image img")?.src') -like 'blob:*')) ''
Check '未知块显示占位且保留类型' ((Num 'document.querySelectorAll(".dd-flow-unknown").length') -eq 1 -and (Eval 'document.querySelector(".dd-flow-unknown-label")?.textContent') -eq 'database') ''

Write-Host ''
Write-Host 'C. 输入：Enter 拆块 / Shift+Enter 软换行'
Check '点进了编辑器' (FocusBlock 8) "active=$(Eval 'document.activeElement?.className')"
TypeText '第一行'
Key 'Enter' 13 '' 8
TypeText '第二行'
Check '软换行没拆块' ((BlockCount) -eq 9) "n=$(BlockCount)"
Check '软换行是 <br>' ((Num 'document.querySelectorAll(".dd-flow br").length') -ge 1) ''
Key 'Enter' 13
Check '回车拆出新块' ((BlockCount) -eq 10) "n=$(BlockCount)"
TypeText '新块'
Check '新块有字' ([bool]((Eval 'document.querySelectorAll(".dd-flow > *")[9]?.textContent') -match '新块')) ''
$ids = Eval '[...document.querySelectorAll(".dd-flow > *")].map((el) => el.getAttribute("data-block-id") || el.querySelector("[data-block-id]")?.getAttribute("data-block-id") || "").join(",")'
$idsUnique = ([string]::Join(',', (@($ids.Split(',') | Select-Object -Unique)))).Length -eq $ids.Length
Check '拆块后每块 id 唯一' $idsUnique "ids=$ids"

Write-Host ''
Write-Host 'D. 斜杠菜单'
Key 'Enter' 13
TypeText '/'
Start-Sleep -Milliseconds 300
Check '菜单弹出来了' ((Num 'document.querySelectorAll(".dd-slash").length') -eq 1) ''
Check '默认列出 11 种块' ((Num 'document.querySelectorAll(".dd-slash-item").length') -eq 11) "n=$(Num 'document.querySelectorAll(".dd-slash-item").length')"
TypeText '列表'
Start-Sleep -Milliseconds 250
Check '搜索"列表"命中 3 项' ((Num 'document.querySelectorAll(".dd-slash-item").length') -eq 3) "n=$(Num 'document.querySelectorAll(".dd-slash-item").length')"
Key 'ArrowDown' 40
Key 'ArrowDown' 40
Key 'Enter' 13
Start-Sleep -Milliseconds 350
Check '回车插入的是待办列表' ((Num 'document.querySelectorAll(".dd-flow ul[data-type=taskList]").length') -eq 2) "n=$(Num 'document.querySelectorAll(".dd-flow ul[data-type=taskList]").length')"
$leftover = Eval '[...document.querySelectorAll(".dd-flow > *")].map((el) => el.textContent || "").join("|").indexOf("/列表") >= 0'
Check '插入后斜杠文字没留下' ($leftover -eq $false) "leftover=$leftover"''
Key 'z' 90 'z' 2
Start-Sleep -Milliseconds 350
Check '撤销回到 11 块（空段落回来了）' ((BlockCount) -eq 11) "n=$(BlockCount)"
Check '撤销把斜杠文字也还回来了' ([bool]((Eval 'document.querySelectorAll(".dd-flow > *")[10]?.textContent') -match '/列表')) "text=$(Eval 'document.querySelectorAll(".dd-flow > *")[10]?.textContent')"


Write-Host ''
Write-Host 'E. 选区浮动条'
ScrollTo 1
$r = BlockRect 1
SelectRange ($r[0] + 2) ($r[1] + 12) ($r[0] + 60) ($r[1] + 12)
Check '选中后浮出工具条' ((Num 'document.querySelectorAll(".dd-bubble").length') -eq 1) ''
$boldBefore = Num 'document.querySelectorAll(".dd-flow strong").length'
if ((ClickSelector '.dd-bubble-btn.is-bold')) { } else { Write-Host 'FAIL  点不到加粗'; $fail++ }
Start-Sleep -Milliseconds 300
Check '加粗按钮真的改了格式' ((Num 'document.querySelectorAll(".dd-flow strong").length') -ne $boldBefore) "before=$boldBefore after=$(Num 'document.querySelectorAll(".dd-flow strong").length')"

SelectRange ($r[0] + 2) ($r[1] + 12) ($r[0] + 40) ($r[1] + 12)
if (-not (ClickSelector '.dd-bubble-btn.is-link')) { Write-Host 'FAIL  点不到链接按钮'; $fail++ }
Start-Sleep -Milliseconds 250
TypeText '笔记.md'
Key 'Enter' 13
Start-Sleep -Milliseconds 300
$linkCount = Num @'
[...document.querySelectorAll('.dd-flow a')].filter((a) => a.getAttribute('href') === '笔记.md').length
'@
Check '插入链接写出了 href' ($linkCount -ge 2) "n=$linkCount"

Write-Host ''
Write-Host 'F. 块手柄与块菜单'
ScrollTo 1
$r = BlockRect 1
MoveTo ($r[0] + 30) ($r[1] + 10)
Start-Sleep -Milliseconds 250
Check '悬停出手柄' ((Num 'document.querySelectorAll(".dd-block-tools").length') -eq 1) ''
if (-not (ClickSelector '.dd-block-btn.is-grip')) { Write-Host 'FAIL  点不到手柄'; $fail++ }
Start-Sleep -Milliseconds 300
Check '块菜单打开了' ((Num 'document.querySelectorAll(".dd-block-menu").length') -eq 1) ''
Check '菜单里有"转换为"' ([bool]((Eval 'document.querySelector(".dd-block-menu")?.textContent') -match '转换为')) ''
$h1Before = Num 'document.querySelectorAll(".dd-flow h1").length'
Key 'Enter' 13
Start-Sleep -Milliseconds 300
Check '回车执行第一项（转一级标题）' ((Num 'document.querySelectorAll(".dd-flow h1").length') -eq ($h1Before + 1)) "before=$h1Before after=$(Num 'document.querySelectorAll(".dd-flow h1").length')"
Key 'z' 90 'z' 2
Start-Sleep -Milliseconds 300
Check '撤销回段落' ((Num 'document.querySelectorAll(".dd-flow h1").length') -eq $h1Before) ''

ScrollTo 2
$r = BlockRect 2
MoveTo ($r[0] + 30) ($r[1] + 10)
Start-Sleep -Milliseconds 250
if (-not (ClickSelector '.dd-block-btn.is-grip')) { Write-Host 'FAIL  点不到手柄（第二次）'; $fail++ }
Start-Sleep -Milliseconds 250
[void](Eval '(() => { const b = [...document.querySelectorAll(".dd-block-menu .dd-menu-item")].find((x) => x.textContent.includes("复制")); if (b) b.click(); return !!b })()')
Start-Sleep -Milliseconds 350
Check '复制一块 +1' ((BlockCount) -eq 12) "n=$(BlockCount)"

Write-Host ''
Write-Host 'G. 拖动手柄换顺序'
ScrollTo 2
$g0 = BlockRect 0
MoveTo ($g0[0] + 30) ($g0[1] + 10)
Start-Sleep -Milliseconds 250
$orderBefore = Eval '[...document.querySelectorAll(".dd-flow > *")].map((el) => (el.textContent || "").trim().slice(0, 6)).join("|")'
$dragOk = Eval @'
(() => {
  const grip = document.querySelector('.dd-block-btn.is-grip');
  const scroll = document.querySelector('[data-dd-flow-scroll]');
  if (!grip || !scroll) return 'no-grip';
  const blocks = [...document.querySelectorAll('.dd-flow > *')];
  const target = blocks[2];
  const tr = target.getBoundingClientRect();
  const dt = new DataTransfer();
  grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: tr.left + 40, clientY: tr.bottom - 4 };
  scroll.dispatchEvent(new DragEvent('dragover', opts));
  scroll.dispatchEvent(new DragEvent('drop', opts));
  return 'done';
})()
'@
Start-Sleep -Milliseconds 400
$orderAfter = Eval '[...document.querySelectorAll(".dd-flow > *")].map((el) => (el.textContent || "").trim().slice(0, 6)).join("|")'
Check '拖动改变了顺序' (($dragOk -eq 'done') -and ($orderBefore -ne $orderAfter)) "res=$dragOk before=$orderBefore after=$orderAfter"
Key 'z' 90 'z' 2
Start-Sleep -Milliseconds 300

Write-Host ''
Write-Host 'H. 保存：只写变动的块'
Start-Sleep -Milliseconds 900
$log = Eval 'window.__log.join(",")'
Check '写盘记录里有新文档的块' ([bool]($log -match '新文档\.note/blocks')) "log=$log"
Check '顺序变了才写 order.json' ([bool]($log -match '新文档\.note/order\.json')) "log=$log"
Check '没碰旧画布' (-not ($log -match '旧画布')) "log=$log"
$saved = Eval 'Object.keys(window.__files).filter((k) => k.indexOf("新文档.note/blocks/") === 0).map((k) => window.__files[k].text).filter((t) => t.indexOf("第一行") >= 0).join("~")'
Check '软换行 + 文字真的落盘了' ([bool](($saved -match '第一行') -and ($saved -match '第二行'))) ("saved=" + ($saved -replace "\s+", " "))
$unknown = Eval 'window.__files["新文档.note/blocks/b8.json"]?.text ?? ""'
Check '未知块原样写回（type/payload 都在）' ([bool](($unknown -match 'database') -and ($unknown -match 'keep'))) "unknown=$unknown"
$anyLayout = Eval 'Object.keys(window.__files).filter((k) => k.indexOf("新文档.note/blocks/") === 0).map((k) => window.__files[k].text).join("").indexOf("layout") >= 0'
Check '块文件里没有 layout（文档流不该有坐标）' ($anyLayout -eq $false) "saved=$saved"


Write-Host ''
Write-Host 'I. 中文输入法合成期间不弹斜杠菜单'
$last = (BlockCount) - 1
Check '能点进最后一块' (FocusBlock $last) "i=$last active=$(Eval 'document.activeElement?.className')"
Key 'Enter' 13
$comp = Eval @'
(() => {
  const el = document.querySelector('.dd-flow');
  el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  return 'composing';
})()
'@
TypeText '/'
Start-Sleep -Milliseconds 250
Check '合成期间的 / 不弹菜单' ((Num 'document.querySelectorAll(".dd-slash").length') -eq 0) "comp=$comp n=$(Num 'document.querySelectorAll(".dd-slash").length')"
[void](Eval "document.querySelector('.dd-flow').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '/' })); 'done'")
TypeText 'x'
Start-Sleep -Milliseconds 200
Check '合成结束后也不补弹菜单' ((Num 'document.querySelectorAll(".dd-slash").length') -eq 0) ''
Key 'Enter' 13

Write-Host ''
Write-Host 'J. 标签切换：旧编辑器的延迟保存不串到新文档'
$before = Eval 'Object.keys(window.__files).filter((k) => k.indexOf("新文档.note/blocks/") === 0).map((k) => window.__files[k].text).join("").indexOf("串线检查") >= 0'
Check '打字前焦点在编辑器里' (FocusBlock ((BlockCount) - 1)) "active=$(Eval 'document.activeElement?.className')"
TypeText '串线检查'
if (-not (ClickRow '旧画布.note')) { Write-Host 'FAIL  切不到旧画布'; $fail++ }
Start-Sleep -Milliseconds 1200
$afterNew = Eval 'Object.keys(window.__files).filter((k) => k.indexOf("新文档.note/blocks/") === 0).map((k) => window.__files[k].text).join("").indexOf("串线检查") >= 0'
$dirtyOld = Eval 'window.__files["旧画布.note/blocks/b1.json"]?.text ?? ""'
Check '切走前的内容写回了它自己的文档' ($afterNew -eq $true) "before=$before after=$afterNew"
Check '旧文档没被塞进别人的内容' (-not ([bool]($dirtyOld -match '串线检查'))) ''
Check '切走之后仍停在画布编辑器（内容没被换掉）' ((Num 'document.querySelectorAll(".dd-note-canvas").length') -eq 1) ''
if (-not (ClickRow '新文档.note')) { Write-Host 'FAIL  切不回新文档'; $fail++ }
Start-Sleep -Milliseconds 1200
Check '切回来内容还在' ([bool]((Eval 'document.querySelector(".dd-flow").textContent') -match '串线检查')) ''

Write-Host ''
Write-Host 'K. 保存失败：仍标未保存，能重试'
[void](Eval 'window.__failWrites = true; "ok"')
Check '能点进最后一块（失败测试）' (FocusBlock ((BlockCount) - 1)) "active=$(Eval 'document.activeElement?.className')"
TypeText '写不进去'
Start-Sleep -Milliseconds 1100
Check '状态变成保存失败' ((Eval 'document.querySelector(".dd-flow-status")?.getAttribute("data-status")') -eq 'error') "st=$(Eval 'document.querySelector(".dd-flow-status")?.getAttribute("data-status")')"
Check '有重试按钮' ((Num 'document.querySelectorAll(".dd-flow-retry").length') -eq 1) ''
[void](Eval 'window.__failWrites = false; "ok"')
# 状态条在文档顶部，刚才滚到底了，点之前先滚回去
[void](Eval "document.querySelector('[data-dd-flow-scroll]').scrollTop = 0; 'ok'")
Start-Sleep -Milliseconds 300
if (-not (ClickSelector '.dd-flow-retry')) { Write-Host 'FAIL  点不到重试'; $fail++ }
Start-Sleep -Milliseconds 900
$st = Eval 'document.querySelector(".dd-flow-status")?.getAttribute("data-status")'
$errText = Eval 'document.querySelector(".dd-flow-error")?.textContent ?? ""'
$failFlag = Eval 'String(window.__failWrites)'
Check '重试之后存好了' ($st -eq 'saved') "st=$st flag=$failFlag err=$errText"
$fixed = Eval 'Object.keys(window.__files).filter((k) => k.indexOf("新文档.note/blocks/") === 0).map((k) => window.__files[k].text).join("").indexOf("写不进去") >= 0'
Check '失败那次的内容真的补写进去了' ($fixed -eq $true) "fixed=$fixed"

Write-Host ''
Write-Host 'L. 新建块笔记（右键菜单）'
$opened = Eval @'
(() => {
  const el = document.querySelector('[data-dd-files] .min-h-0.flex-1');
  if (!el) return 'no-list';
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 260 }));
  return 'ok';
})()
'@
Start-Sleep -Milliseconds 350
$item = Eval @'
(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('新建块笔记'));
  if (!b) return 'no-item';
  b.click();
  return 'clicked';
})()
'@
Start-Sleep -Milliseconds 2000
$newDoc = Eval 'window.__files["未命名.note/.note"]?.text ?? ""'
Check '盘上多了一篇 v2 文档' ([bool](($newDoc -match '"version": 2') -and ($newDoc -match '"layoutMode": "flow"'))) "opened=$opened item=$item"
Check '新文档直接进文档流编辑器' ((Num 'document.querySelectorAll(".dd-flow").length') -eq 1) ''
Check '新文档只有一块空段落' ((Num 'document.querySelectorAll(".dd-flow > *").length') -eq 1) "n=$(Num 'document.querySelectorAll(".dd-flow > *").length')"
# 新建后自动进改名输入框：直接打字回车，验证"搬目录 + 改 meta 标题"
TypeText '会议记录'
Key 'Enter' 13
Start-Sleep -Milliseconds 1500
$renamed = Eval 'window.__files["会议记录.note/.note"]?.text ?? ""'
$oldGone = Eval 'window.__files["未命名.note/.note"] === undefined'
$meta = Eval 'window.__files["会议记录.note/meta.json"]?.text ?? ""'
$titleNow = Eval 'document.querySelector(".dd-flow-title")?.value ?? ""'
Check '改名把目录搬过去了' ([bool]($renamed -match 'layoutMode')) "oldGone=$oldGone"
Check '旧目录清掉了' ($oldGone -eq $true) ''
Check 'meta 里的标题跟着改' ([bool]($meta -match '会议记录')) "meta=$meta"
Check '编辑器跟着换了路径' ($titleNow -eq '会议记录') "title=$titleNow"
Write-Host ''
Write-Host 'M. 旧 v1 笔记：照旧按画布打开，不写盘'
$logBeforeV1 = Num 'window.__log.length'
if (-not (ClickRow '旧画布.note')) { Write-Host 'FAIL  点不到旧画布'; $fail++ }
Start-Sleep -Milliseconds 1100
Check '画布编辑器在' ((Num 'document.querySelectorAll(".dd-note-canvas").length') -eq 1) ''
Check '两块都在' ((Num 'document.querySelectorAll(".dd-note-card").length') -eq 2) "n=$(Num 'document.querySelectorAll(".dd-note-card").length')"
Check '位置还是 absolute（没被文档流化）' ((Eval 'document.querySelector(".dd-note-card")?.style.position') -eq 'absolute') "pos=$(Eval 'document.querySelector(".dd-note-card")?.style.position')"
Check '打开旧笔记不写盘' ((Num 'window.__log.length') -eq $logBeforeV1) "log=$(Eval 'window.__log.join(",")')"
Check 'v1 块文件里 layout 还在' ([bool]((Eval 'window.__files["旧画布.note/blocks/b1.json"]?.text') -match 'layout')) ''

Write-Host ''
Write-Host 'N. Markdown 编辑器：既有 flushSync 基线'
if (-not (ClickRow '笔记')) { Write-Host 'FAIL  点不到笔记'; $fail++ }
Start-Sleep -Milliseconds 1300
Check 'md 编辑器正常挂载' ((Num 'document.querySelectorAll(".cm-editor").length') -eq 1) ''
$fs = Num 'window.__errs.filter((e) => e.indexOf("flushSync") >= 0).length'
Write-Host "   [baseline] flushSync 警告 $fs 条 —— 既有基线（CodeMirror 挂载期），不计入通过/失败"

Write-Host ''
Write-Host 'O. 控制台'
$errs = Eval 'window.__errs.join(" || ")'
Check '没有新增 React/ProseMirror 报错' ([string]::IsNullOrEmpty("$errs") -or -not ($errs -match 'ProseMirror|react|React|flushSync')) "errs=$errs"

[void](Send-Cdp 'Browser.close' @{})
Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL OK' } else { Write-Host "$fail FAILED"; exit 1 }
