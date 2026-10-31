param([string]$Url = 'http://127.0.0.1:5184/')
# `.note` v1（画布）/ v2（文档流）旧版只读回归
#
# 新文档一律走 v3 纵向画布；旧文档还按原编辑器打开，但**只读、不写盘、不迁移**。
# 这个脚本只验三件事：内容仍然显示、布局/块结构没被改写、打开不动文件。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddl-' + [guid]::NewGuid().ToString('N'))
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
  Start-Sleep -Milliseconds 280
}
function ClickText([string]$tag, [string]$text) {
  $r = Eval "(() => { const b = [...document.querySelectorAll('$tag')].find((x) => (x.textContent || '').trim().includes('$text')); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  Click ([double]$p[0] + [double]$p[2] / 2) ([double]$p[1] + [double]$p[3] / 2)
  return $true
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
  function put(p, text) {
    window.__files[p] = { text };
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
        async getFile() { return new File([enc.encode(window.__files[full].text)], n); },
        async createWritable() {
          let buf = '';
          return {
            async write(d) { buf += d instanceof Blob ? await d.text() : String(d) },
            async close() { window.__files[full] = { text: buf }; window.__log.push('write:' + full); },
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

  put('笔记.md', '# 笔记\n\n一篇普通的 markdown。\n');

  put('旧画布.note/.note', JSON.stringify({ app: 'dusk-depot', format: 'blocks', version: 1 }, null, 2));
  put('旧画布.note/meta.json', JSON.stringify({ title: '旧画布', createdAt: '2026-01-01T00:00:00.000Z' }, null, 2));
  put('旧画布.note/order.json', JSON.stringify(['b1', 'b2']));
  put('旧画布.note/blocks/b1.json', JSON.stringify({ id: 'b1', type: 'paragraph', text: '画布块一', layout: { x: 0, y: 20, w: 60 } }));
  put('旧画布.note/blocks/b2.json', JSON.stringify({ id: 'b2', type: 'paragraph', text: '画布块二', layout: { x: 0, y: 120, w: 60 } }));

  put('旧文档流.note/.note', JSON.stringify({ app: 'dusk-depot', format: 'blocks', version: 2, layoutMode: 'flow' }, null, 2));
  put('旧文档流.note/meta.json', JSON.stringify({ title: '旧文档流', createdAt: '2026-01-01T00:00:00.000Z' }, null, 2));
  put('旧文档流.note/order.json', JSON.stringify(['b1', 'b2', 'b3', 'b4']));
  put('旧文档流.note/blocks/b1.json', JSON.stringify({ id: 'b1', type: 'heading1', content: [{ type: 'text', text: '文档流标题' }] }));
  put('旧文档流.note/blocks/b2.json', JSON.stringify({ id: 'b2', type: 'paragraph', content: [{ type: 'text', text: '文档流正文', marks: ['bold'] }] }));
  put('旧文档流.note/blocks/b3.json', JSON.stringify({ id: 'b3', type: 'todoList', items: [
    { checked: true, content: [{ type: 'text', text: '已完成' }] },
    { checked: false, content: [{ type: 'text', text: '未完成' }] }
  ] }));
  put('旧文档流.note/blocks/b4.json', JSON.stringify({ id: 'b4', type: 'code', text: 'const a = 1', lang: 'ts' }));

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
Write-Host 'A. v1 画布：内容 / 坐标 / 只读'
$logs0 = Eval 'window.__log.length'
if (-not (ClickText '[data-dd-files] button' '旧画布')) { Write-Host 'FAIL 点不到旧画布'; $fail++ }
Start-Sleep -Milliseconds 1000
Check 'v1 走画布编辑器' ((Num 'document.querySelectorAll(".dd-note-canvas").length') -eq 1) ''
Check 'v1 只读横幅' ([bool]((Eval 'document.body.innerText') -match '旧版笔记只读打开')) ''
Check 'v1 不可编辑' ((Eval 'document.querySelector(".dd-note-canvas")?.getAttribute("contenteditable")') -eq 'false') ''
Check 'v1 两块都在' ((Num 'document.querySelectorAll(".dd-note-canvas [data-block-id]").length') -eq 2) ''
Check 'v1 正文还在' ([bool]((Eval 'document.querySelector(".dd-note-canvas")?.textContent') -match '画布块一')) ''
$layout = Eval 'document.querySelector(".dd-note-canvas [data-block-id=b2]")?.getAttribute("data-layout-json") ?? ""'
Check 'v1 坐标原样保留' ([bool](($layout -match '"y":120') -and ($layout -match '"w":60'))) "layout=$layout"
Check 'v1 打开不写盘' ((Eval 'window.__log.length') -eq $logs0) "log=$(Eval 'window.__log.join(",")')"

Write-Host ''
Write-Host 'B. v2 文档流：内容 / 块结构 / 只读'
$logs1 = Eval 'window.__log.length'
if (-not (ClickText '[data-dd-files] button' '旧文档流')) { Write-Host 'FAIL 点不到旧文档流'; $fail++ }
Start-Sleep -Milliseconds 1000
Check 'v2 走文档流编辑器' ((Num 'document.querySelectorAll(".dd-flow").length') -eq 1) ''
Check 'v2 只读横幅' ([bool]((Eval 'document.body.innerText') -match '旧版笔记只读打开')) ''
Check 'v2 不可编辑' ((Eval 'document.querySelector(".dd-flow")?.getAttribute("contenteditable")') -eq 'false') ''
Check 'v2 四块都在' ((Num 'document.querySelectorAll(".dd-flow > *").length') -eq 4) "n=$(Num 'document.querySelectorAll(".dd-flow > *").length')"
$flowText = Eval 'document.querySelector(".dd-flow")?.textContent ?? ""'
Check 'v2 标题/正文还在' ([bool](($flowText -match '文档流标题') -and ($flowText -match '文档流正文'))) ''
Check 'v2 待办状态还在' ([bool](($flowText -match '已完成') -and ($flowText -match '未完成'))) ''
Check 'v2 代码块还在' ([bool]($flowText -match 'const a = 1')) ''
Check 'v2 打开不写盘' ((Eval 'window.__log.length') -eq $logs1) "log=$(Eval 'window.__log.join(",")')"

Write-Host ''
Write-Host 'C. markdown 不受影响'
if (-not (ClickText '[data-dd-files] button' '笔记')) { Write-Host 'FAIL 点不到 md'; $fail++ }
Start-Sleep -Milliseconds 1000
Check 'md 编辑器正常挂载' ((Num 'document.querySelectorAll(".cm-editor").length') -eq 1) ''
Check 'md 内容正常' ([bool]((Eval 'document.querySelector(".cm-content")?.textContent') -match '普通的 markdown')) ''

Write-Host ''
Write-Host 'D. 控制台'
$real = Eval 'window.__errs.filter((e) => e.indexOf("ResizeObserver loop") < 0).join(" || ")'
Check '没有未捕获的报错（除 ResizeObserver 基线）' ([string]::IsNullOrEmpty("$real")) "errs=$real"

[void](Send-Cdp 'Browser.close' @{})
Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL OK' } else { Write-Host "$fail FAILED"; exit 1 }
