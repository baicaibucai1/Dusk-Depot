param([string]$Url = 'http://127.0.0.1:5184/')
# `.note` v3 纵向块画布 · 浏览器路径验收
#
# 假目录里放 md、v1 画布、v2 文档流各一份；新建的 v3 文档走真实 FSA 写入。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddb-' + [guid]::NewGuid().ToString('N'))
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
    $buf = [byte[]]::new(4194304); $sb = [System.Text.StringBuilder]::new()
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
  Start-Sleep -Milliseconds 260
}
function ClickText([string]$tag, [string]$text) {
  $r = Eval "(() => { const b = [...document.querySelectorAll('$tag')].find((x) => (x.textContent || '').trim().includes('$text')); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  Click ([double]$p[0] + [double]$p[2] / 2) ([double]$p[1] + [double]$p[3] / 2)
  return $true
}
function ClickSel([string]$sel) {
  $r = Eval "(() => { const b = document.querySelector('$sel'); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  Click ([double]$p[0] + [double]$p[2] / 2) ([double]$p[1] + [double]$p[3] / 2)
  return $true
}
function TypeText([string]$s) {
  [void](Send-Cdp 'Input.insertText' @{ text = $s })
  Start-Sleep -Milliseconds 220
}
function Key([string]$key, [int]$code, [int]$mods = 0) {
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyDown'; key = $key; windowsVirtualKeyCode = $code; nativeVirtualKeyCode = $code; modifiers = $mods })
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $key; windowsVirtualKeyCode = $code; nativeVirtualKeyCode = $code; modifiers = $mods })
  Start-Sleep -Milliseconds 180
}
function WaitFor([string]$expr, [int]$ms = 8000) {
  $step = 250; $waited = 0
  while ($waited -lt $ms) {
    $v = Eval $expr
    if ("$v" -eq 'true' -or "$v" -eq 'True') { return $true }
    Start-Sleep -Milliseconds $step; $waited += $step
  }
  return $false
}
function BlockCount { return Num 'document.querySelectorAll("[data-block-id]").length' }
function ReadFile([string]$p) { return Eval "window.__files['$p']?.text ?? ''" }
function FocusBlock([int]$i) {
  [void](Eval "document.querySelectorAll('[data-block-id]')[$i]?.scrollIntoView({ block: 'center' })")
  Start-Sleep -Milliseconds 220
  $r = Eval "(() => { const b = document.querySelectorAll('[data-block-id]')[$i]?.querySelector('.dd-board-input'); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  Click ([double]$p[0] + 12) ([double]$p[1] + 10)
  return [bool]((Eval 'document.activeElement?.className') -match 'dd-board-input')
}
$shots = Join-Path $PSScriptRoot '..\.workbuddy\shots\2026-10-31'
New-Item -ItemType Directory -Force -Path $shots | Out-Null
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
  [IO.File]::WriteAllBytes((Join-Path $shots "$name.png"), [Convert]::FromBase64String($r.result.data))
  Write-Host "  shot $name"
}
$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}

Start-Sleep -Milliseconds 900
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

$STUB = @'
(() => {
  window.__files = {}; window.__dirs = new Set(['']); window.__log = []; window.__errs = [];
  const enc = new TextEncoder();
  function toB64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function b64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function put(p, text) {
    window.__files[p] = { b64: toB64(enc.encode(text)), text };
    const parts = p.split('/'); for (let i = 1; i < parts.length; i++) window.__dirs.add(parts.slice(0, i).join('/'));
  }
  function childrenOf(path) {
    const prefix = path ? path + '/' : ''; const names = new Set();
    for (const p of Object.keys(window.__files)) {
      if (!p.startsWith(prefix)) continue; const rest = p.slice(prefix.length); if (!rest) continue;
      names.add(rest.split('/')[0]);
    }
    for (const d of window.__dirs) {
      if (!d || d === path || !d.startsWith(prefix)) continue; const rest = d.slice(prefix.length); if (!rest) continue;
      names.add(rest.split('/')[0]);
    }
    const out = [];
    for (const n of names) out.push({ name: n, kind: (prefix + n) in window.__files ? 'file' : 'directory' });
    return out;
  }
  function mk(path) {
    const h = { kind: 'directory', name: path ? path.split('/').pop() : '仓库' };
    const def = (k, v) => Object.defineProperty(h, k, { value: v, enumerable: false });
    def('values', async function* () { for (const c of childrenOf(path)) yield c });
    def('getDirectoryHandle', async (n) => { const full = path ? path + '/' + n : n; window.__dirs.add(full); return mk(full) });
    def('getFileHandle', async (n, opts) => {
      const full = path ? path + '/' + n : n;
      if (!(full in window.__files) && !(opts && opts.create)) throw new DOMException('nf', 'NotFoundError');
      return {
        async getFile() { const f = window.__files[full]; if (!f) throw new DOMException('nf', 'NotFoundError'); return new File([b64(f.b64)], n); },
        async createWritable() {
          const chunks = [];
          return {
            async write(d) { chunks.push(d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : enc.encode(String(d))) },
            async close() {
              let total = 0; for (const c of chunks) total += c.length;
              const all = new Uint8Array(total); let off = 0; for (const c of chunks) { all.set(c, off); off += c.length; }
              let text = null;
              try { const t = new TextDecoder('utf-8', { fatal: true }).decode(all); const r = enc.encode(t);
                if (r.length === all.length && r.every((v, i) => v === all[i])) text = t; } catch {}
              window.__files[full] = { b64: toB64(all), ...(text === null ? {} : { text }) };
              window.__log.push('write:' + full);
            },
          };
        },
      };
    });
    def('removeEntry', async (n) => {
      const full = path ? path + '/' + n : n;
      for (const p of Object.keys(window.__files)) if (p === full || p.startsWith(full + '/')) delete window.__files[p];
      window.__log.push('remove:' + full);
    });
    def('queryPermission', async () => 'granted');
    def('requestPermission', async () => 'granted');
    return h;
  }
  window.showDirectoryPicker = async () => mk('');

  put('笔记.md', '# 笔记\n');

  put('旧画布.note/.note', JSON.stringify({ app: 'dusk-depot', format: 'blocks', version: 1 }, null, 2));
  put('旧画布.note/meta.json', JSON.stringify({ title: '旧画布', createdAt: '' }));
  put('旧画布.note/order.json', JSON.stringify(['b1']));
  put('旧画布.note/blocks/b1.json', JSON.stringify({ id: 'b1', type: 'paragraph', text: '旧画布正文', layout: { x: 40, y: 20, w: 60 } }));

  put('旧文档流.note/.note', JSON.stringify({ app: 'dusk-depot', format: 'blocks', version: 2, layoutMode: 'flow' }, null, 2));
  put('旧文档流.note/meta.json', JSON.stringify({ title: '旧文档流', createdAt: '' }));
  put('旧文档流.note/order.json', JSON.stringify(['b1']));
  put('旧文档流.note/blocks/b1.json', JSON.stringify({ id: 'b1', type: 'paragraph', content: [{ type: 'text', text: '旧文档流正文' }] }));

  const ce = console.error.bind(console);
  console.error = function () { window.__errs.push(Array.from(arguments).map(String).join(' ')); ce.apply(null, arguments) };
  window.addEventListener('error', (e) => window.__errs.push('error: ' + String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => window.__errs.push('reject: ' + String(e.reason)));
  return 'stubbed';
})()
'@

[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 2600
Check '假目录装上了' ((Eval $STUB) -eq 'stubbed') ''
if (-not (ClickText 'button' '选择文件夹')) { Write-Host 'FAIL 点不到选择仓库'; $fail++ }
Start-Sleep -Milliseconds 2400

Write-Host ''
Write-Host 'A. 新建 v3 画布'
$opened = Eval @'
(() => {
  const el = document.querySelector('[data-dd-files] .min-h-0.flex-1');
  if (!el) return 'no-list';
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 260 }));
  return 'ok';
})()
'@
Start-Sleep -Milliseconds 350
Check '右键有「新建块笔记（纵向画布）」' ([bool]((Eval 'document.body.innerText') -match '新建块笔记（纵向画布）')) ''
$item = Eval @'
(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('新建块笔记（纵向画布）'));
  if (!b) return 'no-item'; b.click(); return 'clicked';
})()
'@
Start-Sleep -Milliseconds 1500
TypeText '画布测试'
Key 'Enter' 13
Start-Sleep -Milliseconds 1800
$mark = ReadFile '画布测试.note/.note'
Check '新建文档是 v3 标记' ([bool](($mark -match '"version": 3') -and ($mark -match '"layoutMode": "flow"'))) "mark=$mark"
Check '盘上有 board.json' ([bool]((Eval 'Object.keys(window.__files).join(",")') -match '画布测试.note/board.json')) ''
Check '盘上有 relations.json' ([bool]((Eval 'Object.keys(window.__files).join(",")') -match '画布测试.note/relations.json')) ''
Check '没有再写 order.json' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '画布测试.note/order.json')) ''
Check '直接进纵向画布' ((Num 'document.querySelectorAll("[data-block-id]").length') -eq 1) "n=$(BlockCount)"
Check '标题栏是 v3 标记' ([bool]((Eval 'document.body.innerText') -match '\.note · 纵向画布')) ''

Write-Host ''
Write-Host 'B. 每块独立编辑 + 回车换块'
Check '能点进第一块' (FocusBlock 0) "active=$(Eval 'document.activeElement?.className')"
TypeText '第一块文字'
Key 'Enter' 13
Start-Sleep -Milliseconds 400
Check '回车后出现第二块' ((BlockCount) -eq 2) "n=$(BlockCount)"
TypeText '第二块文字'
Start-Sleep -Milliseconds 900
$b1 = ReadFile '画布测试.note/blocks/b1.json'
$b2 = ReadFile '画布测试.note/blocks/b2.json'
Check '第一块内容落盘' ([bool]($b1 -match '第一块文字')) "b1=$b1"
Check '第二块内容落盘' ([bool]($b2 -match '第二块文字')) "b2=$b2"
$boardRaw = ReadFile '画布测试.note/board.json'
Check 'board.json 记了两块的顺序' ([bool](($boardRaw -match '"b1"') -and ($boardRaw -match '"b2"'))) "board=$boardRaw"
Check 'board.json 不装正文' (-not [bool]($boardRaw -match '第一块文字')) ''

Write-Host ''
Write-Host 'C. 块类型：待办 / 标题'
if (-not (ClickText 'button' '添加块')) { Write-Host 'FAIL 点不到添加块'; $fail++ }
Start-Sleep -Milliseconds 300
if (-not (ClickText 'button' '待办')) { Write-Host 'FAIL 点不到待办'; $fail++ }
Start-Sleep -Milliseconds 700
Check '多了一个待办块' ((BlockCount) -eq 3) "n=$(BlockCount)"
$todoId = Eval '[...document.querySelectorAll("[data-block-id]")].find((el) => el.getAttribute("data-block-type") === "todo")?.getAttribute("data-block-id") ?? ""'
Check '待办块有勾选框' ([bool]((Eval "Boolean(document.querySelector('[data-block-id=$todoId] input[type=checkbox]'))"))) "id=$todoId"
if (-not (FocusBlock 2)) { Write-Host 'FAIL 点不进待办'; $fail++ }
TypeText '记得买书'
Start-Sleep -Milliseconds 300
[void](Eval "document.querySelector('[data-block-id=$todoId] input[type=checkbox]').click(); 'ok'")
Start-Sleep -Milliseconds 800
$todoRaw = ReadFile "画布测试.note/blocks/$todoId.json"
Check '待办勾选状态落盘' ([bool]($todoRaw -match '"checked": true')) "raw=$todoRaw"

# 把第一块转成一级标题
$menu = Eval @'
(() => {
  const b = document.querySelector('[data-block-id="b1"] button[aria-label*="菜单"]');
  if (!b) return 'no'; b.click(); return 'ok';
})()
'@
Start-Sleep -Milliseconds 300
if (-not (ClickText 'button' '转为一级标题')) { Write-Host 'FAIL 点不到转标题'; $fail++ }
Start-Sleep -Milliseconds 800
$b1h = ReadFile '画布测试.note/blocks/b1.json'
Check '第一块变成 heading1' ([bool]($b1h -match '"type": "heading1"')) "b1=$b1h"
Check '转换后正文没丢' ([bool]($b1h -match '第一块文字')) ''

Write-Host ''
Write-Host 'D. 块间连接'
$menu2 = Eval @'
(() => {
  const b = document.querySelector('[data-block-id="b2"] button[aria-label*="菜单"]');
  if (!b) return 'no'; b.click(); return 'ok';
})()
'@
Start-Sleep -Milliseconds 300
if (-not (ClickText 'button' '连接到…')) { Write-Host 'FAIL 点不到连接'; $fail++ }
Start-Sleep -Milliseconds 400
Check '弹出连接对话框' ([bool]((Eval 'document.body.innerText') -match '连接到另一个块')) ''
$inp = Eval @'
(() => {
  const d = document.querySelector('[role=dialog]');
  const i = d?.querySelector('input');
  if (!i) return 'no'; i.focus(); return 'ok';
})()
'@
TypeText '这一段依赖上面的标题'
Start-Sleep -Milliseconds 200
if (-not (ClickText 'button' '建立连接')) { Write-Host 'FAIL 建立连接'; $fail++ }
Start-Sleep -Milliseconds 900
$relRaw = ReadFile '画布测试.note/relations.json'
Check '连接写进 relations.json' ([bool]($relRaw -match '这一段依赖上面的标题')) "rel=$relRaw"
Check '连接类型是 related' ([bool]($relRaw -match '"type": "related"')) ''
Check '右栏出现连接列表' ([bool]((Eval 'document.body.innerText') -match '连接 1')) ''

Write-Host ''
Write-Host 'E. 键盘/拖动改顺序'
$orderBefore = ReadFile '画布测试.note/board.json'
[void](Eval @'
(() => {
  const b = document.querySelector('[data-block-id="b1"] button[aria-label^="拖动块"]');
  if (!b) return 'no'; b.focus(); return 'ok';
})()
'@)
Key 'ArrowDown' 40 1
Start-Sleep -Milliseconds 900
$orderAfter = ReadFile '画布测试.note/board.json'
Check 'Alt+↓ 改了块顺序' ([bool]($orderAfter -ne $orderBefore)) "before=$orderBefore after=$orderAfter"
Check '两块都还在（没有丢块）' ((BlockCount) -eq 3) "n=$(BlockCount)"

# 再验一次"真实拖动"路径：dragstart → dragover → drop
$drag = Eval @'
(async () => {
  const from = document.querySelector('[data-block-id="b2"] button[aria-label^="拖动块"]');
  const to = document.querySelector('[data-block-id="b3"]');
  if (!from || !to) return 'no';
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 120));
  const q = to.getBoundingClientRect();
  to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: q.bottom - 2 }));
  await new Promise((r) => setTimeout(r, 120));
  to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'ok';
})()
'@
Check '拖动事件链能执行' ($drag -eq 'ok') "res=$drag"
Start-Sleep -Milliseconds 900
$dragOrder = ReadFile '画布测试.note/board.json'
Check '拖动后顺序又变了' ([bool]($dragOrder -ne $orderAfter)) "order=$dragOrder"

Write-Host ''
Write-Host 'F. 文件拖入 assets/'
$drop = Eval @'
(async () => {
  const c = document.createElement('canvas');
  c.width = 180; c.height = 96;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0e9b66'; ctx.fillRect(0, 0, 180, 96);
  ctx.fillStyle = '#ffffff'; ctx.font = '16px sans-serif'; ctx.fillText('v3 asset', 36, 54);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], '卡片.png', { type: 'image/png' }));
  const zone = document.querySelector('[data-dd-flow-scroll]');
  if (!zone) return 'no-zone';
  zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'dropped';
})()
'@
Check '图片拖放事件发出去了' ($drop -eq 'dropped') "res=$drop"
Start-Sleep -Milliseconds 1500
$assetPath = Eval 'Object.keys(window.__files).find((p) => p.indexOf("画布测试.note/assets/") === 0) ?? ""'
Check '图片复制进本笔记 assets/' ([bool]($assetPath -ne '')) "path=$assetPath"
$imgBlock = Eval 'Object.keys(window.__files).filter((p) => p.indexOf("画布测试.note/blocks/") === 0).map((p) => window.__files[p].text).find((t) => t.indexOf("assets/") >= 0) ?? ""'
Check '块文件里存的是相对路径' ([bool]($imgBlock -match 'assets/')) "block=$imgBlock"
Check '图片块出现在画布上' ((BlockCount) -eq 4) "n=$(BlockCount)"

# 先收起连接面板，拍一张干净的画布；再打开拍连接
if (ClickText 'button' '连接 1') { Start-Sleep -Milliseconds 350 }
Shot 'board-1440'
if (ClickText 'button' '连接 1') { Start-Sleep -Milliseconds 350 }
Shot 'board-relations-1440'
if (ClickText 'button' '连接 1') { Start-Sleep -Milliseconds 350 }
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1024; height = 768; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 700
Shot 'board-1024'
Write-Host ('  [1024] ' + (Eval "(() => { const m = document.querySelector('[data-dd-flow-scroll]'); const r = m?.getBoundingClientRect(); return 'board=' + (r ? Math.round(r.width) : -1) + ' 溢出=' + (document.documentElement.scrollWidth > window.innerWidth) })()"))
[void](Send-Cdp 'Emulation.clearDeviceMetricsOverride' @{})
Start-Sleep -Milliseconds 500

Write-Host ''
Write-Host 'G. 关掉重开（同一仓库）'
if (-not (ClickText '[data-dd-files] button' '笔记')) { Write-Host 'FAIL 点不到 md'; $fail++ }
Start-Sleep -Milliseconds 600
$logOpen = Eval 'window.__log.length'
if (-not (ClickText '[data-dd-files] button' '画布测试')) { Write-Host 'FAIL 点不到画布'; $fail++ }
Start-Sleep -Milliseconds 1400
Check '重开（无修改）不写盘' ((Eval 'window.__log.length') -eq $logOpen) "log=$(Eval 'window.__log.slice(-4).join(",")')"
Check '重开后块数还在' ((BlockCount) -eq 4) "n=$(BlockCount)"
Check '重开后正文还在' ([bool]((Eval 'document.body.innerText') -match '第一块文字|第二块文字')) ''
Check '重开后连接还在' ([bool]((Eval 'document.body.innerText') -match '连接 1')) ''

Write-Host ''
Write-Host 'H. 旧版只读'
$logBefore = Eval 'window.__log.length'
if (-not (ClickText '[data-dd-files] button' '旧画布')) { Write-Host 'FAIL 点不到旧画布'; $fail++ }
Start-Sleep -Milliseconds 900
Check 'v1 显示只读横幅' ([bool]((Eval 'document.body.innerText') -match '旧版笔记只读打开')) ''
Check 'v1 编辑器不可编辑' ((Eval 'document.querySelector(".dd-note-canvas")?.getAttribute("contenteditable")') -eq 'false') ''
Check 'v1 打开不写盘' ((Eval 'window.__log.length') -eq $logBefore) "log=$(Eval 'window.__log.slice(-3).join(",")')"
if (-not (ClickText '[data-dd-files] button' '旧文档流')) { Write-Host 'FAIL 点不到旧文档流'; $fail++ }
Start-Sleep -Milliseconds 900
Check 'v2 显示只读横幅' ([bool]((Eval 'document.body.innerText') -match '旧版笔记只读打开')) ''
Check 'v2 编辑器不可编辑' ((Eval 'document.querySelector(".dd-flow")?.getAttribute("contenteditable")') -eq 'false') ''
Check 'v2 打开不写盘' ((Eval 'window.__log.length') -eq $logBefore) "log=$(Eval 'window.__log.slice(-3).join(",")')"

Write-Host ''
Write-Host 'I. 删除整篇 v3（含 assets）'
$ctx = Eval @'
(() => {
  const row = [...document.querySelectorAll('[data-dd-files] button')].find((b) => b.textContent.includes('画布测试'));
  if (!row) return 'no-row';
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
  return 'ok';
})()
'@
Start-Sleep -Milliseconds 350
Check '树右键有删除' ([bool]((Eval 'document.body.innerText') -match '删除')) ''
if (-not (ClickText 'button' '删除')) { Write-Host 'FAIL 点不到删除'; $fail++ }
Start-Sleep -Milliseconds 350
if (-not (ClickText 'button' '删除')) { Write-Host 'FAIL 点不到确认删除'; $fail++ }
Start-Sleep -Milliseconds 1200
Check '整篇 .note 目录从盘上消失' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '画布测试\.note')) "files=$(Eval 'Object.keys(window.__files).length')"
Check 'assets 也一起删了' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '画布测试\.note/assets')) ''

Write-Host ''
Write-Host 'J. 控制台'
$errs = Eval 'window.__errs.join(" || ")'
$real = Eval 'window.__errs.filter((e) => e.indexOf("ResizeObserver loop") < 0).join(" || ")'
Check '没有未捕获的报错（除 ResizeObserver 基线）' ([string]::IsNullOrEmpty("$real")) "errs=$errs"

[void](Send-Cdp 'Browser.close' @{})
Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL OK' } else { Write-Host "$fail FAILED"; exit 1 }
