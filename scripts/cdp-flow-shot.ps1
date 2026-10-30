param([string]$Url = 'http://127.0.0.1:5184/', [string]$Out = "$env:TEMP\dd-flow-shots")
# 文档流视觉检查：1440×900 / 1024×768 各截一张，再单独截斜杠菜单、选区工具条、块菜单。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$profile = Join-Path $env:TEMP ('dds-' + [guid]::NewGuid().ToString('N'))
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
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
  [IO.File]::WriteAllBytes((Join-Path $Out "$name.png"), [Convert]::FromBase64String($r.result.data))
  Write-Host "  shot $name"
}
function Click([double]$x, [double]$y) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $x; y = $y; button = 'none' })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = $x; y = $y; button = 'left'; clickCount = 1 })
  Start-Sleep -Milliseconds 320
}

Start-Sleep -Milliseconds 900
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

$STUB = @"
(() => {
  window.__files = {}; window.__dirs = new Set(['']); window.__log = [];
  const enc = new TextEncoder();
  function put(p, text) {
    window.__files[p] = { text: text };
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) window.__dirs.add(parts.slice(0, i).join('/'));
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
      if (!(full in window.__files) && !(opts && opts.create)) throw new DOMException('nf', 'NotFoundError');
      return {
        async getFile() { return new File([enc.encode(window.__files[full].text || '')], n) },
        async createWritable() { let buf = ''; return { async write(d) { buf += d instanceof Blob ? await d.text() : String(d) }, async close() { window.__files[full] = { text: buf } } } },
      };
    });
    def('removeEntry', async (n) => { const full = path ? path + '/' + n : n; for (const p of Object.keys(window.__files)) if (p === full || p.startsWith(full + '/')) delete window.__files[p]; });
    def('queryPermission', async () => 'granted');
    def('requestPermission', async () => 'granted');
    return h;
  }
  window.showDirectoryPicker = async () => mk('');
  put('说明.md', '# 说明\n\n这是给截图用的示例库。\n');
  put('写作.note/.note', JSON.stringify({ app: 'dusk-depot', format: 'blocks', version: 2, layoutMode: 'flow' }, null, 2));
  put('写作.note/meta.json', JSON.stringify({ title: '写作计划', createdAt: '2026-10-30T00:00:00.000Z' }, null, 2));
  put('写作.note/order.json', JSON.stringify(['b1','b2','b3','b4','b5','b6','b7'], null, 2));
  put('写作.note/blocks/b1.json', JSON.stringify({ id: 'b1', type: 'heading1', content: [{ type: 'text', text: '十月写作计划' }] }, null, 2));
  put('写作.note/blocks/b2.json', JSON.stringify({ id: 'b2', type: 'paragraph', content: [
    { type: 'text', text: '这份计划只做一件事：把 ' },
    { type: 'text', text: '手上这篇长文', marks: ['bold'] },
    { type: 'text', text: ' 收尾。参考资料见 ' },
    { type: 'text', text: '说明', marks: [{ type: 'link', href: '说明.md' }] },
    { type: 'text', text: '。' }
  ] }, null, 2));
  put('写作.note/blocks/b3.json', JSON.stringify({ id: 'b3', type: 'heading2', content: [{ type: 'text', text: '这一周' }] }, null, 2));
  put('写作.note/blocks/b4.json', JSON.stringify({ id: 'b4', type: 'todoList', items: [
    { checked: true, content: [{ type: 'text', text: '整理访谈记录' }] },
    { checked: false, content: [{ type: 'text', text: '写完第三节' }] },
    { checked: false, content: [{ type: 'text', text: '把引用补全' }] }
  ] }, null, 2));
  put('写作.note/blocks/b5.json', JSON.stringify({ id: 'b5', type: 'quote', content: [{ type: 'text', text: '先写完，再写好。' }] }, null, 2));
  put('写作.note/blocks/b6.json', JSON.stringify({ id: 'b6', type: 'code', text: 'npm run build\nnpm test', lang: 'bash' }, null, 2));
  put('写作.note/blocks/b7.json', JSON.stringify({ id: 'b7', type: 'bulletList', items: [
    { content: [{ type: 'text', text: '每天只改一遍' }] },
    { content: [{ type: 'text', text: '第二天再读一遍' }] }
  ] }, null, 2));
  return 'stubbed';
})();
"@

[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 2500
[void](Eval $STUB)
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("选择文件夹")).click()')
Start-Sleep -Milliseconds 2200
$r = Eval "(() => { const b = [...document.querySelectorAll('[data-dd-files] button')].find((x) => x.textContent.trim() === '写作.note'); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
$p = $r.Split(',')
Click ([double]$p[0] + 20) ([double]$p[1] + [double]$p[3] / 2)
Start-Sleep -Milliseconds 1400

Write-Host "输出目录：$Out"
Shot 'flow-1440'

# 悬停第二块：手柄 + 正文
$br = Eval "(() => { const el = document.querySelectorAll('.dd-flow > *')[1]; const q = el.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
$b = $br.Split(',')
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = [double]$b[0] + 120; y = [double]$b[1] + 12; button = 'none' })
Start-Sleep -Milliseconds 350
Shot 'flow-hover'

# 斜杠菜单：点最后一块，回车开新段，输入 /
$last = Eval "(() => { const els = document.querySelectorAll('.dd-flow > *'); const el = els[els.length - 1]; el.scrollIntoView({ block: 'center' }); const q = el.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
$l = $last.Split(',')
Click ([double]$l[0] + 16) ([double]$l[1] + 12)
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyDown'; key = 'Enter'; windowsVirtualKeyCode = 13; nativeVirtualKeyCode = 13 })
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'Enter'; windowsVirtualKeyCode = 13; nativeVirtualKeyCode = 13 })
Start-Sleep -Milliseconds 200
[void](Send-Cdp 'Input.insertText' @{ text = '/' })
Start-Sleep -Milliseconds 400
Shot 'flow-slash'
[void](Send-Cdp 'Input.insertText' @{ text = '列表' })
Start-Sleep -Milliseconds 300
Shot 'flow-slash-query'
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyDown'; key = 'Escape'; windowsVirtualKeyCode = 27; nativeVirtualKeyCode = 27 })
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'Escape'; windowsVirtualKeyCode = 27; nativeVirtualKeyCode = 27 })
Start-Sleep -Milliseconds 200
# 把刚才留下的 "/列表" 删掉
for ($i = 0; $i -lt 3; $i++) {
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyDown'; key = 'Backspace'; windowsVirtualKeyCode = 8; nativeVirtualKeyCode = 8 })
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'Backspace'; windowsVirtualKeyCode = 8; nativeVirtualKeyCode = 8 })
}
Start-Sleep -Milliseconds 200

# 选区工具条：选住正文里的一小段
$br2 = Eval "(() => { const el = document.querySelectorAll('.dd-flow > *')[1]; el.scrollIntoView({ block: 'center' }); const q = el.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
$b2 = $br2.Split(',')
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = [double]$b2[0] + 4; y = [double]$b2[1] + 12; button = 'none' })
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = [double]$b2[0] + 4; y = [double]$b2[1] + 12; button = 'left'; clickCount = 1 })
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = [double]$b2[0] + 150; y = [double]$b2[1] + 12; button = 'left' })
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = [double]$b2[0] + 150; y = [double]$b2[1] + 12; button = 'left'; clickCount = 1 })
Start-Sleep -Milliseconds 450
Shot 'flow-bubble'

# 块菜单
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = [double]$b2[0] + 120; y = [double]$b2[1] + 12; button = 'none' })
Start-Sleep -Milliseconds 300
$grip = Eval "(() => { const b = document.querySelector('.dd-block-btn.is-grip'); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
if ($grip -ne '') {
  $g = $grip.Split(',')
  Click ([double]$g[0] + [double]$g[2] / 2) ([double]$g[1] + [double]$g[3] / 2)
  Start-Sleep -Milliseconds 350
  Shot 'flow-block-menu'
}

# 1024×768
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyDown'; key = 'Escape'; windowsVirtualKeyCode = 27; nativeVirtualKeyCode = 27 })
[void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = 'Escape'; windowsVirtualKeyCode = 27; nativeVirtualKeyCode = 27 })
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = 900; y = 700; button = 'none' })
Start-Sleep -Milliseconds 400
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1024; height = 768; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 700
[void](Eval "document.querySelector('[data-dd-flow-scroll]').scrollTop = 0; 'ok'")
Start-Sleep -Milliseconds 300
$br3 = Eval "(() => { const el = document.querySelectorAll('.dd-flow > *')[1]; const q = el.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
$b3 = $br3.Split(',')
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = [double]$b3[0] + 60; y = [double]$b3[1] + 12; button = 'none' })
Start-Sleep -Milliseconds 350
Shot 'flow-1024'
Shot 'flow-1024-hover'
Write-Host '  1024 布局量尺：'
Write-Host ('    ' + (Eval "(() => { const d = document.querySelector('.dd-flow').getBoundingClientRect(); const t = document.querySelectorAll('.dd-flow > *')[1].getBoundingClientRect(); const h = document.querySelector('.dd-block-tools')?.getBoundingClientRect(); return 'doc=' + Math.round(d.left) + '..' + Math.round(d.right) + ' 段左边=' + Math.round(t.left) + ' 手柄=' + (h ? Math.round(h.left) + '..' + Math.round(h.right) : 'none') })()"))
[void](Send-Cdp 'Emulation.clearDeviceMetricsOverride' @{})
Start-Sleep -Milliseconds 300

[void](Send-Cdp 'Browser.close' @{})
Write-Host 'done'
