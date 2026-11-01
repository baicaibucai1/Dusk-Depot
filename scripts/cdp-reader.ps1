param([string]$Url = 'http://127.0.0.1:5184/')
# EPUB 阅读器排版 / 翻页 / 滚动模式 · 交互验收
#
# 用一本 8 章的长篇假书：两章的短书一屏就放完了，看不出分栏、行距、
# 页码这些只在长文里才暴露的问题。
$ErrorActionPreference = 'Stop'
$url = $Url
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddrd-' + [guid]::NewGuid().ToString('N'))
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
  Start-Sleep -Milliseconds 420
}
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}
function ClickText([string]$sel, [string]$text) {
  $r = Eval "(() => { const b = [...document.querySelectorAll('$sel')].find((x) => (x.textContent || '').includes('$text')); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  Click ([double]$p[0] + [double]$p[2] / 2) ([double]$p[1] + [double]$p[3] / 2)
  return $true
}
function ClickRow([string]$text) {
  $r = Eval "(() => { const b = [...document.querySelectorAll('[data-dd-files] button')].find((x) => (x.textContent || '').includes('$text')); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  Click ([double]$p[0] + 20) ([double]$p[1] + [double]$p[3] / 2)
  return $true
}
function ClickSel([string]$sel) {
  $r = Eval "(() => { const b = document.querySelector('$sel'); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  Click ([double]$p[0] + [double]$p[2] / 2) ([double]$p[1] + [double]$p[3] / 2)
  return $true
}
$shots = Join-Path $PSScriptRoot '..\.workbuddy\shots\2026-10-31'
New-Item -ItemType Directory -Force -Path $shots | Out-Null
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
  [IO.File]::WriteAllBytes((Join-Path $shots "$name.png"), [Convert]::FromBase64String($r.result.data))
  Write-Host "  shot $name"
}
$fail = 0

$root = 'C:\AI_Production\Dusk Depot'
$longB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:TEMP\dd-shelf-epub\长夜.epub"))

$STUB = @"
(() => {
  window.__files = {}; window.__dirs = new Set(['']); window.__log = []; window.__errs = [];
  window.__picked = 0;
  const enc = new TextEncoder();
  function b64(s) {
    const bin = atob(s); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function putBytes(p, base64) {
    window.__files[p] = { b64: base64 };
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) window.__dirs.add(parts.slice(0, i).join('/'));
  }
  window.__idb = new Map();
  const fakeIdb = {
    open() {
      const req = {};
      setTimeout(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          createObjectStore() {},
          close() {},
          transaction() {
            const tx = {
              objectStore() {
                return {
                  put(v, k) { window.__idb.set(k, v); },
                  get(k) { const r = {}; r.result = window.__idb.get(k); setTimeout(() => r.onsuccess && r.onsuccess(), 0); return r; },
                  delete(k) { window.__idb.delete(k); },
                };
              },
            };
            setTimeout(() => tx.oncomplete && tx.oncomplete(), 5);
            return tx;
          },
        };
        req.result = db;
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
  try { Object.defineProperty(window, 'indexedDB', { value: fakeIdb, configurable: true }); } catch {}

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
    def('__path', path);
    def('values', async function* () { for (const c of childrenOf(path)) yield c });
    def('getDirectoryHandle', async (n) => { const full = path ? path + '/' + n : n; window.__dirs.add(full); return mk(full) });
    def('getFileHandle', async (n, opts) => {
      const full = path ? path + '/' + n : n;
      if (!(full in window.__files) && !(opts && opts.create)) throw new DOMException('nf', 'NotFoundError');
      return {
        async getFile() {
          const f = window.__files[full];
          if (!f) throw new DOMException('nf', 'NotFoundError');
          const data = b64(f.b64);
          return new File([data], n, { lastModified: 1 });
        },
        async createWritable() {
          const chunks = [];
          return {
            async write(d) {
              if (d instanceof Blob) chunks.push(new Uint8Array(await d.arrayBuffer()));
              else if (typeof d === 'string') chunks.push(enc.encode(d));
              else chunks.push(new Uint8Array(d));
            },
            async close() {
              let total = 0;
              for (const c of chunks) total += c.length;
              const all = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) { all.set(c, off); off += c.length; }
              let text = null;
              try {
                const t = new TextDecoder('utf-8', { fatal: true }).decode(all);
                const round = enc.encode(t);
                let same = round.length === all.length;
                if (same) for (let i = 0; i < all.length; i++) if (round[i] !== all[i]) { same = false; break; }
                if (same) text = t;
              } catch {}
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
    });
    def('queryPermission', async () => 'granted');
    def('requestPermission', async () => 'granted');
    def('isSameEntry', async (other) => other && other.__path === path);
    def('resolve', async (child) => {
      const c = child && child.__path;
      if (typeof c !== 'string') return null;
      if (c === path) return [];
      return c.startsWith(path ? path + '/' : '') ? c.split('/') : null;
    });
    return h;
  }
  // 第 1 次是仓库（根），第 2 次是书架目录（书库）—— 两者必须分开，
  // 否则 `.zzq` 会被写进书架目录，看不出"书架不写仓库"这条边界
  window.showDirectoryPicker = async () => {
    window.__picked += 1;
    return window.__picked === 1 ? mk('') : mk('书库');
  };
  window.__long = '$longB64';
  putBytes('书.epub', window.__long);
  window.__mkEpub = () => {
    const bin = atob(window.__long);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], '长夜.epub', { type: 'application/epub+zip' });
  };
  const ce = console.error.bind(console);
  console.error = function () { window.__errs.push(Array.from(arguments).map(String).join(' ')); ce.apply(null, arguments) };
  window.addEventListener('unhandledrejection', (e) => window.__errs.push('reject: ' + String(e.reason)));
  return 'stubbed';
})()
"@

[void](Send-Cdp 'Page.navigate' @{ url = $url })
Start-Sleep -Milliseconds 2800
$stub = Eval $STUB
Check '假目录装上了' ("$stub" -eq 'stubbed') "res=$stub"
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("选择文件夹")).click()')

# 等仓库打开（遍历假目录也要几十毫秒到几秒），导航条出现才算进主界面
$nav = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 400
  if ((Eval 'Boolean(document.querySelector("nav[aria-label=功能导航]"))') -eq $true) { $nav = $true; break }
}
Check '仓库打开、导航条出现' $nav ''
if (-not (ClickSel 'nav[aria-label=功能导航] button[aria-label=书架]')) { Write-Host 'FAIL 点不到书架'; $fail++ }
Start-Sleep -Milliseconds 900
Write-Host ('   [shelf] ' + (Eval 'document.querySelector("[data-dd-shelf]")?.innerText.replace(/\\n/g, " / ").slice(0, 80) ?? "none"'))
if (-not (ClickText 'button' '选一个文件夹')) { Write-Host 'FAIL 点不到选文件夹'; $fail++ }
Start-Sleep -Milliseconds 1600

Write-Host 'A. 导入长篇样书并打开'
$drop = Eval @'
(() => {
  const dt = new DataTransfer();
  dt.items.add(window.__mkEpub());
  const zone = document.querySelector('[data-drop-zone="shelf-welcome"]');
  if (!zone) return 'no-zone';
  zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'dropped';
})()
'@
Check '拖入长书' ($drop -eq 'dropped') "res=$drop"
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  if ((Eval 'Boolean(window.__files["书库/library.json"])') -eq $true) { $ok = $true; break }
}
Check '导入完成（清单已落盘）' $ok ''

$row = Eval "(() => { const b = document.querySelector('[data-dd-shelf] [data-book-id]'); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
if ($row -ne '') {
  $p = $row.Split(',')
  Click ([double]$p[0] + 30) ([double]$p[1] + [double]$p[3] / 2)
}
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  if ((Eval 'Boolean(document.querySelector("[data-dd-reader] iframe"))') -eq $true) { $ready = $true; break }
}
Check '阅读器渲染出 iframe' $ready ''
Start-Sleep -Milliseconds 1500

Write-Host ''
Write-Host 'B. 分页模式的排版数据'
$diag = Eval @'
(() => {
  const f = document.querySelector('[data-dd-reader] iframe');
  if (!f) return 'no-iframe';
  const d = f.contentDocument, w = f.contentWindow;
  const q = f.getBoundingClientRect();
  const b = d.body;
  const cs = w.getComputedStyle(b);
  const p = d.querySelector('p');
  const ps = p ? w.getComputedStyle(p) : null;
  return JSON.stringify({
    iframe: [Math.round(q.width), Math.round(q.height)],
    bodyScroll: [b.scrollWidth, b.scrollHeight],
    bodyClient: [b.clientWidth, b.clientHeight],
    columns: cs.columnCount + ' / ' + cs.columnWidth + ' / ' + cs.columnGap,
    overflow: cs.overflowX + ' / ' + cs.overflowY,
    lh: cs.lineHeight, fs: cs.fontSize,
    pLH: ps && ps.lineHeight, pFS: ps && ps.fontSize, pMargin: ps && ps.marginTop,
    htmlScrollW: d.documentElement.scrollWidth,
    htmlClientW: d.documentElement.clientWidth,
    typo: Boolean(d.getElementById('dd-typography')),
  });
})()
'@
Write-Host ('   [paged] ' + $diag)
$dom = Eval @'
(() => {
  const box = document.querySelector('[data-dd-reader][data-flow]');
  const kids = [...box.children].map((c) => c.tagName + '|' + (c.className || '') + '|' + Math.round(c.getBoundingClientRect().width) + '|' + getComputedStyle(c).width);
  const host = box.firstElementChild;
  const inner = host ? [...host.children].map((c) => c.tagName + '|' + (c.className || '') + '|' + Math.round(c.getBoundingClientRect().width)) : [];
  return JSON.stringify({ box: Math.round(box.getBoundingClientRect().width), kids, inner });
})()
'@
Write-Host ('   [dom] ' + $dom)
$d = $diag | ConvertFrom-Json
$pLine = [double](("$($d.pLH)" -replace 'px', ''))
Check '压住了书自带的坏行高（行距设置真的生效）' ($pLine -gt 25) "pLH=$($d.pLH)（书里写的是 0.6em）"
Check '字号设置也生效（不是浏览器的 16px）' ([int](("$($d.fs)" -replace 'px', '')) -eq 17) "fs=$($d.fs)"


Shot 'reader-paged'

Write-Host ''
Write-Host 'C. 分页模式：点击左右两侧翻页'
$fr = '0,0,0,0'
if ((Num 'document.querySelectorAll("[data-dd-reader] iframe").length') -eq 1) {
$fr = Eval "(() => { const f = document.querySelector('[data-dd-reader] iframe'); if (!f) return '0,0,0,0'; const q = f.getBoundingClientRect(); const b = f.contentDocument.body; const br = b ? b.getBoundingClientRect() : { left: 0, width: q.width }; return (q.left + br.left) + ',' + q.top + ',' + br.width + ',' + q.height })()"
$fp = $fr.Split(',')
$fl = [double]$fp[0]; $ft = [double]$fp[1]; $fw = [double]$fp[2]; $fh = [double]$fp[3]
Write-Host "   分页 iframe = $([Math]::Round($fw)) x $([Math]::Round($fh))"
Check '正文列宽贴着版心（不是整窗）' ($fw -le 760) "w=$fw"

$readCfi = '(() => { try { const bs = JSON.parse(window.__files["书库/library.json"].text).books; return (bs.find((b) => b.cfi) || {}).cfi || "" } catch { return "" } })()'
$cfiP0 = Eval $readCfi
Click ($fl + $fw * 0.8) ($ft + $fh * 0.5)
Start-Sleep -Milliseconds 1500
$cfiP1 = Eval $readCfi
$libPeek = Eval '(() => { try { const b = JSON.parse(window.__files["书库/library.json"].text).books[0]; return JSON.stringify({ id: b.id, cfi: b.cfi, pct: b.percent }) } catch (e) { return "ERR " + e } })()'
Write-Host ('   [lib] ' + $libPeek)
Check '点正文右侧翻到下一屏' ([bool](($cfiP1 -match 'epubcfi') -and ($cfiP1 -ne $cfiP0))) "a=$cfiP0 b=$cfiP1"
Click ($fl + $fw * 0.2) ($ft + $fh * 0.5)
Start-Sleep -Milliseconds 1500
$cfiP2 = Eval $readCfi
Check '点正文左侧翻回上一屏' ([bool]($cfiP2 -ne $cfiP1)) "b=$cfiP1 c=$cfiP2"

Write-Host ''
Write-Host 'D. 切换滚动阅读'
if (-not (ClickSel 'button[aria-label=阅读显示]')) { Write-Host 'FAIL 打不开阅读设置'; $fail++ }
Start-Sleep -Milliseconds 600
Shot 'reader-prefs'
Check '设置里有「滚动阅读」' ([bool]((Eval 'document.body.innerText') -match '滚动阅读')) ''
if (-not (ClickText 'button' '滚动阅读')) { Write-Host 'FAIL 点不到滚动阅读'; $fail++ }
Start-Sleep -Milliseconds 2600
Check '切到滚动模式' ((Eval 'document.querySelector("[data-dd-reader][data-flow]")?.dataset.flow') -eq 'scroll') "flow=$(Eval 'document.querySelector("[data-dd-reader][data-flow]")?.dataset.flow')"
Check '滚动模式下不再显示左右翻页提示' ((Num 'document.querySelectorAll("[data-dd-turn-zone]").length') -eq 0) ''
$diag2 = Eval @'
(() => {
  const f = document.querySelector('[data-dd-reader] iframe');
  if (!f) return 'no-iframe';
  const d = f.contentDocument, w = f.contentWindow;
  const q = f.getBoundingClientRect();
  const b = d.body;
  const cs = w.getComputedStyle(b);
  return JSON.stringify({
    iframe: [Math.round(q.width), Math.round(q.height)],
    bodyScrollH: b.scrollHeight,
    bodyClientH: b.clientHeight,
    columns: cs.columnCount + ' / ' + cs.columnWidth,
    htmlScrollH: d.documentElement.scrollHeight,
    lh: cs.lineHeight,
  });
})()
'@
Write-Host ('   [scroll] ' + $diag2)
Shot 'reader-scroll'

# 滚动模式：滚轮应该滚正文（不是翻页）
$readTop = '(() => { const box = document.querySelector("[data-dd-reader] .epub-container"); return Math.round(box ? box.scrollTop : -1) })()'
$before = Eval $readTop
if (-not (ClickSel 'button[aria-label=阅读显示]')) { Write-Host '   [info] 设置面板没关' }
Start-Sleep -Milliseconds 400
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $fl + $fw * 0.5; y = $ft + $fh * 0.5; button = 'none' })
for ($i = 0; $i -lt 4; $i++) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseWheel'; x = $fl + $fw * 0.5; y = $ft + $fh * 0.5; deltaX = 0; deltaY = 500 })
  Start-Sleep -Milliseconds 180
}
Start-Sleep -Milliseconds 1200
$after = Eval $readTop
Check '滚动模式滚轮能滚正文' (([int]$after -ne [int]$before) -and [int]$after -ge 0) "before=$before after=$after"

# 切回分页：位置要接上
if (-not (ClickSel 'button[aria-label=阅读显示]')) { Write-Host 'FAIL 打开设置2'; $fail++ }
Start-Sleep -Milliseconds 500
if (-not (ClickText 'button' '左右翻页')) { Write-Host 'FAIL 点不到左右翻页'; $fail++ }
Start-Sleep -Milliseconds 2600
Check '切回分页模式' ((Eval 'document.querySelector("[data-dd-reader][data-flow]")?.dataset.flow') -eq 'paged') "flow=$(Eval 'document.querySelector("[data-dd-reader][data-flow]")?.dataset.flow')"
$cfiBack = Eval $readCfi
$pctBack = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books[0].percent || 0 } catch { return -1 } })()'
Check '切回分页后没跳回开头（进度还在）' ([bool]([double]$pctBack -gt 0.02)) "pct=$pctBack cfi=$cfiBack was=$cfiP2"
}

Write-Host ''
Write-Host 'E. 文件区直接打开 EPUB'
# 阅读设置面板的全屏遮罩还开着，先点掉它，否则点导航只会关面板
[void](Eval '(() => { const el = [...document.querySelectorAll("div")].find((d) => typeof d.className === "string" && d.className.includes("fixed") && d.className.includes("inset-0") && d.className.includes("z-20")); if (el) el.click(); return Boolean(el); })()')
Start-Sleep -Milliseconds 400
if (-not (ClickSel 'nav[aria-label=功能导航] button[aria-label=文件]')) { Write-Host 'FAIL 回不到文件区'; $fail++ }
Start-Sleep -Milliseconds 900
$hasEpubRow = Eval "[...document.querySelectorAll('[data-dd-files] button')].some((b) => (b.textContent || '').includes('.epub'))"
Check '文件树里能看到 .epub' ($hasEpubRow -eq $true) ''
if (-not (ClickRow '.epub')) { Write-Host 'FAIL 点不到 epub'; $fail++ }
Start-Sleep -Milliseconds 3000
Check '点一下就切到书架工作区' ((Num 'document.querySelectorAll("[data-dd-shelf]").length') -eq 1) ''
Check '阅读器直接打开了' ((Num 'document.querySelectorAll("[data-dd-reader] iframe").length') -eq 1) "iframe=$(Num 'document.querySelectorAll("[data-dd-reader] iframe").length')"
Check '内容相同的书没有被复制第二份' ((Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length") -eq 1) "n=$(Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length")"
$nowBook = Eval 'document.querySelector("[data-dd-reader] header p")?.textContent ?? ""'
Check '打开的是《长夜》' ([bool]($nowBook -match '长夜')) "title=$nowBook"

Write-Host ''
Write-Host 'F. 控制台'
$errs = Eval 'window.__errs.join(" || ")'
Check '没有未捕获的报错' ([string]::IsNullOrEmpty("$errs")) "errs=$errs"

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL OK' } else { Write-Host "FAILED: $fail"; exit 1 }
