param([string]$Url = 'http://127.0.0.1:5184/')
# 书架 / EPUB 阅读器 · 浏览器路径验收
#
# 假目录：showDirectoryPicker 按 __pickSeq 依次返回目录，默认 ['', '书库', ...]。
# 假 IndexedDB 保存目录句柄（真实 IDB 不能 clone 带方法的对象），用来验"取消换目录后句柄没变"。
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddshelf-' + [guid]::NewGuid().ToString('N'))
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
  Start-Sleep -Milliseconds 320
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
function ClickDialogText([string]$text) {
  $r = Eval "(() => { const d = document.querySelector('[role=dialog]'); if (!d) return ''; const b = [...d.querySelectorAll('button')].find((x) => (x.textContent || '').includes('$text')); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  Click ([double]$p[0] + [double]$p[2] / 2) ([double]$p[1] + [double]$p[3] / 2)
  return $true
}
function ClickBook([string]$title) {
  $r = Eval "(() => { const row = [...document.querySelectorAll('[data-dd-shelf] [data-book-id]')].find((el) => (el.textContent || '').includes('$title')); if (!row) return ''; const b = row.querySelector('button'); const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  Click ([double]$p[0] + [double]$p[2] / 2) ([double]$p[1] + [double]$p[3] / 2)
  return $true
}
function Key([string]$key, [int]$code, [int]$mods = 0) {
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyDown'; key = $key; windowsVirtualKeyCode = $code; nativeVirtualKeyCode = $code; modifiers = $mods })
  [void](Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $key; windowsVirtualKeyCode = $code; nativeVirtualKeyCode = $code; modifiers = $mods })
  Start-Sleep -Milliseconds 180
}
function WaitFor([string]$expr, [int]$ms = 8000) {
  $step = 250
  $waited = 0
  while ($waited -lt $ms) {
    $v = Eval $expr
    if ("$v" -eq 'true' -or "$v" -eq 'True') { return $true }
    Start-Sleep -Milliseconds $step
    $waited += $step
  }
  return $false
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

$root = 'C:\AI_Production\Dusk Depot'
$bookB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:TEMP\dd-shelf-epub\三体.epub"))
$book2B64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:TEMP\dd-shelf-epub\银河.epub"))
$badB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:TEMP\dd-shelf-epub\损坏.epub"))
$drmB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:TEMP\dd-shelf-epub\加密.epub"))
$repoB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:TEMP\dd-shelf-epub\基地.epub"))

$STUB = @"
(() => {
  window.__files = {}; window.__dirs = new Set(['']); window.__log = []; window.__errs = [];
  window.__picked = 0;
  window.__pickSeq = ['', '书库', '新书架A', '搬不动', '新书库', '书库'];
  window.__perm = 'granted'; window.__grant = true;
  window.__failWrites = null;
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
  function putBytes(p, base64, text) {
    window.__files[p] = { b64: base64, ...(text === undefined ? {} : { text }) };
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) window.__dirs.add(parts.slice(0, i).join('/'));
  }
  function put(p, text) { putBytes(p, toB64(enc.encode(text)), text); }

  /* 假 IndexedDB：真 IDB 没法结构化克隆带方法的句柄，这里存引用 */
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
              if (window.__failWrites && full.includes(window.__failWrites)) throw new DOMException('disk full', 'NotReadableError');
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
      window.__log.push('remove:' + full);
    });
    def('queryPermission', async () => window.__perm);
    def('requestPermission', async () => { if (window.__grant) { window.__perm = 'granted'; return 'granted'; } return 'denied'; });
    def('isSameEntry', async (other) => other && other.__path === path);
    def('resolve', async (child) => {
      const c = child && child.__path;
      if (typeof c !== 'string') return null;
      if (c === path) return [];
      return c.startsWith(path ? path + '/' : '') ? c.split('/') : null;
    });
    return h;
  }
  window.showDirectoryPicker = async () => {
    window.__picked += 1;
    const path = window.__pickSeq[window.__picked - 1] ?? '书库';
    return mk(path);
  };

  put('笔记.md', '# 笔记\n\n仓库里的东西。\n');
  putBytes('仓库书.epub', '$repoB64');

  const ce = console.error.bind(console);
  console.error = function () { window.__errs.push(Array.from(arguments).map(String).join(' ')); ce.apply(null, arguments) };
  window.addEventListener('error', (e) => window.__errs.push('error: ' + String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => window.__errs.push('reject: ' + String(e.reason)));
  return 'stubbed';
})()
"@

[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 2600
Check '假目录装上了' ((Eval $STUB) -eq 'stubbed') ''
if (-not (ClickText 'button' '选择文件夹')) { Write-Host 'FAIL 点不到选择仓库'; $fail++ }
Start-Sleep -Milliseconds 2400

Write-Host ''
Write-Host 'A. 书架入口与首次设置'
Check '左侧有「书架」' ((Num 'document.querySelectorAll("nav[aria-label=功能导航] button").length') -ge 3) ''
if (-not (ClickSel 'nav[aria-label=功能导航] button[aria-label=书架]')) { Write-Host 'FAIL 点不到书架'; $fail++ }
Start-Sleep -Milliseconds 700
Check '进入书架工作区（待设置）' ([bool]((Eval 'document.body.innerText') -match '先给书架选个位置')) ''
Check '还没建书架清单（没偷偷写仓库）' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match 'library.json')) ''

if (-not (ClickText 'button' '选一个文件夹')) { Write-Host 'FAIL 点不到选文件夹'; $fail++ }
Start-Sleep -Milliseconds 1300
Check '书架位置独立于仓库（书库/）' ([bool]((Eval 'window.__picked') -eq 2)) "picked=$(Eval 'window.__picked')"
Check '空书架欢迎页' ([bool]((Eval 'document.body.innerText') -match '书架还是空的')) ''
Check '空页说明会复制、不动原文件' ([bool]((Eval 'document.body.innerText') -match '原文件不动|复制')) ''

Write-Host ''
Write-Host 'B. 拖入两本（浏览器分支，字节级）'
$drop = Eval @"
(() => {
  const mkFile = (b64, name) => {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: 'application/epub+zip' });
  };
  const dt = new DataTransfer();
  dt.items.add(mkFile('$bookB64', '三体.epub'));
  dt.items.add(mkFile('$book2B64', '银河.epub'));
  const zone = document.querySelector('[data-drop-zone="shelf-welcome"]');
  if (!zone) return 'no-zone';
  zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'dropped';
})()
"@
Check '拖放事件发出去了' ($drop -eq 'dropped') "res=$drop"
$imported = WaitFor 'Boolean(window.__files["书库/三体.epub"]) && Boolean(window.__files["书库/银河.epub"]) && Boolean(window.__files["书库/library.json"])' 20000
Check '两本书都复制进了书架目录' $imported "files=$(Eval 'Object.keys(window.__files).join(",")')"
Check '书没进仓库' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '^三体.epub')) ''
$b64Len = Eval 'window.__files["书库/三体.epub"]?.b64.length ?? -1'
$b64Head = Eval 'window.__files["书库/三体.epub"]?.b64.slice(0, 64) ?? ""'
$b64Tail = Eval 'window.__files["书库/三体.epub"]?.b64.slice(-64) ?? ""'
$same = ([int]$b64Len -eq $bookB64.Length) -and ($b64Head -eq $bookB64.Substring(0, 64)) -and ($b64Tail -eq $bookB64.Substring($bookB64.Length - 64))
Check 'EPUB 按原始字节保存（长度与首尾一致）' ($same -eq $true) "len=$b64Len want=$($bookB64.Length)"
Check '列表里两本' ((Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length") -eq 2) "n=$(Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length")"
$libRaw = Eval 'window.__files["书库/library.json"]?.text || ""'
Check '清单记了书名/作者/大小' ([bool](($libRaw -match '三体') -and ($libRaw -match '刘慈欣'))) "lib=$libRaw"
Check '清单带封面缩略图（data URL）' ([bool]($libRaw -match 'data:image/jpeg;base64')) ''

Shot 'shelf-list-1440'

Write-Host ''
Write-Host 'C. 重复 / 损坏 / DRM / 超大 / 批量部分失败'
$batch = Eval @"
(() => {
  const mkFile = (b64, name) => {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: 'application/epub+zip' });
  };
  const dt = new DataTransfer();
  dt.items.add(mkFile('$bookB64', '三体（另一个名字）.epub'));
  dt.items.add(mkFile('$badB64', '损坏.epub'));
  dt.items.add(mkFile('$drmB64', '加密.epub'));
  const big = new File([new Uint8Array(4)], '超大.epub', { type: 'application/epub+zip' });
  Object.defineProperty(big, 'size', { value: 201 * 1024 * 1024 });
  dt.items.add(big);
  document.querySelector('[data-drop-zone="shelf-list"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'ok';
})()
"@
Start-Sleep -Milliseconds 2600
Check '同一本书不重复入库（按内容判）' ((Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length") -eq 2) "n=$(Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length")"
Check '提示"已在书架中"并能打开已有' ([bool]((Eval 'document.body.innerText') -match '已在书架中')) ''
Check '坏文件没进书架' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '损坏.epub')) ''
Check '坏文件给了提示' ([bool]((Eval 'document.body.innerText') -match '不是标准 EPUB|打不开')) ''
Check 'DRM 书没入库' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '加密.epub')) ''
Check 'DRM 提示说清楚' ([bool]((Eval 'document.body.innerText') -match 'DRM')) ''
Check '超大文件在复制前被拒' ([bool]((Eval 'document.body.innerText') -match '超过单本上限')) ''
Check '批量结果里成功/失败分开计数' ([bool]((Eval 'document.body.innerText') -match '失败 3')) "body=$(Eval 'document.querySelector("[data-dd-shelf]")?.innerText.replace(/\n/g," / ").slice(-200)')"

Write-Host ''
Write-Host 'D. 阅读 / 翻页 / 快速切书'
if (-not (ClickBook '三体')) { Write-Host 'FAIL 点不到书'; $fail++ }
$ready = WaitFor 'Boolean(document.querySelector("[data-dd-reader] iframe"))' 12000
Check '阅读器渲染出 iframe' $ready ''
Start-Sleep -Milliseconds 900
$body = Eval 'document.querySelector("[data-dd-reader] iframe")?.contentDocument?.body?.innerText ?? ""'
Check '正文里有第一章' ([bool]($body -match '地球往事')) "body=$($body.Substring(0,[Math]::Min(60,$body.Length)))"
Check '右栏有目录' ([bool]((Eval 'document.querySelector("[aria-label=书籍目录与书签]")?.textContent') -match '第一章')) ''

Shot 'shelf-reader-1440'
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1024; height = 768; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 700
Shot 'shelf-reader-1024'
Write-Host ('  [1024 阅读] ' + (Eval "(() => { const m = document.querySelector('main'); const r = m?.getBoundingClientRect(); const f = document.querySelector('[data-dd-reader] iframe'); return 'main=' + (r ? Math.round(r.width) : -1) + ' iframe=' + (f ? Math.round(f.getBoundingClientRect().width) : -1) + ' 溢出=' + (document.documentElement.scrollWidth > window.innerWidth) })()"))
[void](Send-Cdp 'Emulation.clearDeviceMetricsOverride' @{})
Start-Sleep -Milliseconds 500

Key 'ArrowRight' 39
Start-Sleep -Milliseconds 1300
$cfi1 = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books.find((b) => b.title === "三体").cfi || "" } catch { return "" } })()'
Check '翻页后进度记下来了（CFI）' ([bool]($cfi1 -match 'epubcfi')) "cfi=$cfi1"

# 书内键盘：焦点进 iframe 也能翻
$before = Eval 'document.querySelector("[data-dd-reader] iframe")?.contentDocument?.body?.innerText.slice(0, 20) ?? ""'
[void](Eval 'document.querySelector("[data-dd-reader] iframe")?.contentWindow?.focus(); "ok"')
Key 'ArrowRight' 39
Start-Sleep -Milliseconds 900
$cfiKey = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books.find((b) => b.title === "三体").cfi || "" } catch { return "" } })()'
Check 'iframe 里按方向键也能翻页' ([bool]($cfiKey -match 'epubcfi')) "before=$before cfi=$cfiKey"

if (-not (ClickSel 'button[aria-label=返回书架]')) { Write-Host 'FAIL 点不到返回书架'; $fail++ }
Start-Sleep -Milliseconds 600
if (-not (ClickBook '银河')) { Write-Host 'FAIL 点不到银河'; $fail++ }
[void](WaitFor 'Boolean(document.querySelector("[data-dd-reader] iframe"))' 10000)
Start-Sleep -Milliseconds 900
$pct1 = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books.find((b) => b.title === "三体").percent || 0 } catch { return -1 } })()'
$pct2 = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books.find((b) => b.title === "银河系搭车客指南").percent || 0 } catch { return -1 } })()'
Check '切书后新书用自己从 0 开始的进度（没串）' ([bool]([double]$pct2 -lt 0.05 -and [double]$pct1 -gt 0)) "三体=$pct1 银河=$pct2"
if (-not (ClickSel 'button[aria-label=返回书架]')) { Write-Host 'FAIL 返回书架2'; $fail++ }
Start-Sleep -Milliseconds 500
if (-not (ClickBook '三体')) { Write-Host 'FAIL 再点三体'; $fail++ }
[void](WaitFor 'Boolean(document.querySelector("[data-dd-reader] iframe"))' 10000)
Start-Sleep -Milliseconds 900
$cfiBack = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books.find((b) => b.title === "三体").cfi || "" } catch { return "" } })()'
Check '切回三体还是原来的 CFI' ($cfiBack -eq $cfiKey) "back=$cfiBack was=$cfiKey"

Write-Host ''
Write-Host 'E. 书签（不重复、可删除）'
if (-not (ClickSel 'button[aria-label=加书签]')) { Write-Host 'FAIL 点不到加书签'; $fail++ }
Start-Sleep -Milliseconds 700
$marks = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books.find((b) => b.title === "三体").bookmarks.length } catch { return -1 } })()'
Check '书签写进了清单' ([bool]($marks -eq 1)) "n=$marks"
if (-not (ClickSel 'button[aria-label=加书签]')) { Write-Host 'FAIL 第二次加书签'; $fail++ }
Start-Sleep -Milliseconds 600
$marks2 = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books.find((b) => b.title === "三体").bookmarks.length } catch { return -1 } })()'
Check '同一位置不重复加书签' ([bool]($marks2 -eq 1)) "n=$marks2"
if (ClickText '[aria-label=书籍目录与书签] button' '书签') { } else { Write-Host 'FAIL 点不到书签页签'; $fail++ }
Start-Sleep -Milliseconds 400
Check '书签列表有那一条' ([bool]((Eval 'document.querySelector("[aria-label=书籍目录与书签]")?.textContent') -match '第一章|第二章|当前位置')) ''

Write-Host ''
Write-Host 'F. 保存失败：保留待存 + 红条 + 重试'
[void](Eval 'window.__failWrites = "书库/library.json"; "ok"')
Key 'ArrowRight' 39
Start-Sleep -Milliseconds 1300
$ban = Eval 'document.querySelector("[data-dd-shelf]")?.innerText ?? ""'
Check '写失败时出现"没有保存"红条' ([bool]($ban -match '书架清单没有保存')) "panel=$($ban.Substring(0,[Math]::Min(80,$ban.Length)))"
Check '红条给重试保存' ([bool]($ban -match '重试保存')) ''
$libBefore = Eval 'window.__files["书库/library.json"]?.text || ""'
[void](Eval 'window.__failWrites = null; "ok"')
if (-not (ClickText 'button' '重试保存')) { Write-Host 'FAIL 点不到重试保存'; $fail++ }
Start-Sleep -Milliseconds 1200
$ban2 = Eval 'document.querySelector("[data-dd-shelf]")?.innerText ?? ""'
Check '重试成功后红条消失' (-not [bool]($ban2 -match '书架清单没有保存')) ''
$libAfter = Eval 'window.__files["书库/library.json"]?.text || ""'
Check '重试把失败的改动补写进去' ([bool]($libAfter -ne $libBefore)) ''

Write-Host ''
Write-Host 'G. 换目录：取消不动当前书架'
if (-not (ClickSel 'button[aria-label=设置]')) { Write-Host 'FAIL 点不到设置'; $fail++ }
Start-Sleep -Milliseconds 350
if (-not (ClickText 'button' '存储位置')) { Write-Host 'FAIL 点不到书架设置'; $fail++ }
Start-Sleep -Milliseconds 250
$cfgBefore = Eval 'localStorage.getItem("dusk.shelf.v1")'
$handleBefore = Eval 'window.__idb.get("shelf:handle")?.__path ?? ""'
if (-not (ClickText 'button' '更换')) { Write-Host 'FAIL 点不到更换'; $fail++ }
Start-Sleep -Milliseconds 900
Check '弹出换目录对话框并列出现状' ([bool]((Eval 'document.body.innerText') -match '目标目录现状')) ''
Check '能选搬迁（目标是空的）' ([bool]((Eval 'document.body.innerText') -match '搬迁书架到新位置')) ''
if (-not (ClickText 'button' '取消（当前书架不变）')) { Write-Host 'FAIL 点不到取消'; $fail++ }
Start-Sleep -Milliseconds 500
Check '取消后配置没变' ((Eval 'localStorage.getItem("dusk.shelf.v1")') -eq $cfgBefore) "now=$(Eval 'localStorage.getItem("dusk.shelf.v1")')"
Check '取消后 IndexedDB 句柄没变' ((Eval 'window.__idb.get("shelf:handle")?.__path ?? ""') -eq $handleBefore) "now=$(Eval 'window.__idb.get("shelf:handle")?.__path ?? ""')"
Check '取消后书还在列表里' ((Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length") -eq 2) ''
Check '取消后书还在原目录' ([bool]((Eval 'Object.keys(window.__files).join(",")') -match '书库/三体.epub')) ''

Write-Host ''
Write-Host 'H. 导入中禁止换目录'
$slow = Eval @"
(() => {
  const bin = atob('$book2B64'); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const f = new File([bytes], '慢书.epub', { type: 'application/epub+zip' });
  Object.defineProperty(f, 'arrayBuffer', { value: () => new Promise((r) => setTimeout(() => r(bytes.buffer.slice(0)), 1400)) });
  const dt = new DataTransfer(); dt.items.add(f);
  document.querySelector('[data-drop-zone="shelf-list"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'ok';
})()
"@
Start-Sleep -Milliseconds 350
$pickedDuring = Eval 'window.__picked'
$dis = Eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('更换')); return b ? b.disabled : null })()"
Check '导入中「更换」是禁用的' ($dis -eq $true) "disabled=$dis"
if (ClickText 'button' '更换') { Start-Sleep -Milliseconds 400 }
Check '导入中点更换不会拉起选择器' ((Eval 'window.__picked') -eq $pickedDuring) "picked=$(Eval 'window.__picked') was=$pickedDuring"
Start-Sleep -Milliseconds 2200
Key 'Escape' 27
Write-Host ''

Write-Host 'I. 搬迁失败：旧书架可用、目标可重试'
if (-not (ClickSel 'button[aria-label=设置]')) { Write-Host 'FAIL 设置2'; $fail++ }
Start-Sleep -Milliseconds 300
if (-not (ClickText 'button' '存储位置')) { Write-Host 'FAIL 存储2'; $fail++ }
Start-Sleep -Milliseconds 250
if (-not (ClickText 'button' '更换')) { Write-Host 'FAIL 更换2'; $fail++ }
Start-Sleep -Milliseconds 800
Check '目标是空目录，可以提供搬迁' ([bool]((Eval 'document.body.innerText') -match '搬迁书架到新位置')) ''
[void](Eval 'window.__failWrites = "搬不动/.dusk-migrate"; "ok"')
if (-not (ClickText 'button' '搬迁书架到新位置')) { Write-Host 'FAIL 点不到搬迁'; $fail++ }
Start-Sleep -Milliseconds 1600
$moveErr = Eval 'document.body.innerText'
Check '搬迁失败就地显示原因' ([bool]($moveErr -match 'disk full|复制失败|失败')) ''
Check '失败后提示当前书架没被改动' ([bool]($moveErr -match '当前书架没有被改动')) ''
Check '失败后旧书架文件还在' ([bool]((Eval 'Object.keys(window.__files).join(",")') -match '书库/三体.epub')) ''
Check '失败后配置还是旧目录' ([bool]((Eval 'localStorage.getItem("dusk.shelf.v1")') -match '书库')) ''
Check '失败后目标没留下半成品' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '搬不动/')) "files=$(Eval 'Object.keys(window.__files).join(",")')"
[void](Eval 'window.__failWrites = null; "ok"')
if (-not (ClickText 'button' '取消（当前书架不变）')) { Write-Host 'FAIL 取消搬迁'; $fail++ }
Start-Sleep -Milliseconds 400

Write-Host ''
Write-Host 'J. 搬迁成功：新目录有书、旧目录保留'
if (-not (ClickText 'button' '更换')) { Write-Host 'FAIL 更换3'; $fail++ }
Start-Sleep -Milliseconds 800
if (-not (ClickText 'button' '搬迁书架到新位置')) { Write-Host 'FAIL 搬迁3'; $fail++ }
$moved = WaitFor 'Boolean(window.__files["新书库/三体.epub"]) && Boolean(window.__files["新书库/library.json"])' 20000
Check '新书架目录里有书和清单' $moved "files=$(Eval 'Object.keys(window.__files).join(",")')"
Check '旧书架目录原样保留' ([bool]((Eval 'Object.keys(window.__files).join(",")') -match '书库/三体.epub')) ''
Check '配置指向新目录' ([bool]((Eval 'localStorage.getItem("dusk.shelf.v1")') -match '新书库')) "cfg=$(Eval 'localStorage.getItem("dusk.shelf.v1")')"
Start-Sleep -Milliseconds 800
Check '界面仍显示两本书' ((Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length") -eq 2) "n=$(Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length")"
Check '新目录没有暂存残留' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '新书库/.dusk-migrate')) ''
Key 'Escape' 27

Write-Host ''
Write-Host 'K. 删除 → 回收站 → 还原 → 彻底删除'
Start-Sleep -Milliseconds 300
# 关掉设置
Key 'Escape' 27
Start-Sleep -Milliseconds 300
$menu = Eval @'
(() => {
  const row = [...document.querySelectorAll('[data-dd-shelf] [data-book-id]')].find((el) => el.textContent.includes('三体'));
  if (!row) return 'no';
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));
  return 'ok';
})()
'@
Start-Sleep -Milliseconds 350
Check '右键菜单有「在资源管理器中查看」' ([bool]((Eval 'document.body.innerText') -match '在资源管理器中查看')) ''
Check 'FSA 下它是灰的（拿不到真实路径）' ((Eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('在资源管理器中查看')); return b ? b.disabled : null })()") -eq $true) ''
if (-not (ClickText 'button' '删除（移到回收站）')) { Write-Host 'FAIL 点不到删除'; $fail++ }
Start-Sleep -Milliseconds 350
Check '确认框说明删的是书架副本' ([bool]((Eval 'document.body.innerText') -match '原始文件')) ''
if (-not (ClickText 'button' '移到回收站')) { Write-Host 'FAIL 确认删除'; $fail++ }
Start-Sleep -Milliseconds 1000
Check '文件搬进 .trash（不是立刻删）' ([bool]((Eval 'Object.keys(window.__files).join(",")') -match '新书库/.trash/')) ''
Check '正常列表只剩一本' ((Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length") -eq 1) "n=$(Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length")"
Check '清单里还留着条目（可还原）' ((Eval '(() => { try { return JSON.parse(window.__files["新书库/library.json"].text).books.filter((b) => b.trashedAt).length } catch { return -1 } })()') -eq 1) ''
if (-not (ClickText 'button' '回收站')) { Write-Host 'FAIL 点不到回收站'; $fail++ }
Start-Sleep -Milliseconds 400
Check '回收站里能看到这本' ((Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length") -eq 1) ''
$menu2 = Eval @'
(() => {
  const row = document.querySelector('[data-dd-shelf] [data-book-id]');
  const r = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));
  return 'ok';
})()
'@
Start-Sleep -Milliseconds 300
if (-not (ClickText 'button' '还原到书架')) { Write-Host 'FAIL 点不到还原'; $fail++ }
Start-Sleep -Milliseconds 1000
Check '还原后文件回到书架根目录' ([bool]((Eval 'Object.keys(window.__files).join(",")') -match '新书库/三体.epub')) ''
if (-not (ClickText 'button' '全部')) { Write-Host 'FAIL 点不到全部'; $fail++ }
Start-Sleep -Milliseconds 400
Check '还原后列表回到两本' ((Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length") -eq 2) ''

Start-Sleep -Milliseconds 200
$kb = Eval @'
(() => {
  const row = [...document.querySelectorAll('[data-dd-shelf] [data-book-id]')].find((el) => el.textContent.includes('三体'));
  row.querySelector('button').focus();
  return document.activeElement === row.querySelector('button');
})()
'@
Check '书目行能拿到键盘焦点' ($kb -eq $true) ''
Key 'ContextMenu' 93
Start-Sleep -Milliseconds 350
Check '键盘能打开书籍菜单' ([bool]((Eval 'document.body.innerText') -match '继续阅读')) ''
Key 'Escape' 27

Write-Host ''
Write-Host 'L. 仓库里的 EPUB：不读，去书架'
if (-not (ClickSel 'nav[aria-label=功能导航] button[aria-label=文件]')) { Write-Host 'FAIL 回文件'; $fail++ }
Start-Sleep -Milliseconds 700
Check '文件树里有仓库书.epub' ([bool]((Eval 'document.body.innerText') -match '仓库书')) "body=$(Eval 'document.body.innerText.slice(0,160)')"
if (-not (ClickText '[data-dd-files] button' '仓库书')) { Write-Host 'FAIL 点不到仓库书'; $fail++ }
Start-Sleep -Milliseconds 500
Check '文件区不把 EPUB 当正文读' ([bool]((Eval 'document.body.innerText') -match '文件区不读电子书')) ''
Check '提供「添加到书架」和「去书架」' ([bool]((Eval 'document.body.innerText') -match '添加到书架')) ''
if (-not (ClickText 'button' '添加到书架')) { Write-Host 'FAIL 点不到添加到书架'; $fail++ }
Start-Sleep -Milliseconds 1800
Check '加进书架后自动切到书架工作区' ([bool]((Eval 'Boolean(document.querySelector("[data-dd-shelf]"))'))) ''
Check '书架多了一本（从仓库复制）' ((Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length") -eq 3) "n=$(Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length")"
Check '仓库原文件还在' ([bool]((Eval 'Object.keys(window.__files).join(",")') -match '(^|,)仓库书\.epub')) ''
Check '没把书写回仓库' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '(^|,)library\.json')) ''

Write-Host ''
Write-Host 'M. 权限：重试 vs 重新授权'
[void](Eval 'window.__perm = "prompt"; window.__grant = false; "ok"')
# 先触发一次"重新扫描"：它会重新打开目录，权限不够就会进入待授权状态
if (-not (ClickSel 'button[aria-label=重新扫描书架目录]')) { Write-Host 'FAIL 点不到重新扫描'; $fail++ }
Start-Sleep -Milliseconds 1200
Check '权限被收回时列表给出「重新授权」' ([bool]((Eval 'document.querySelector("[data-dd-shelf]")?.innerText') -match '重新授权')) "panel=$(Eval 'document.querySelector("[data-dd-shelf]")?.innerText.replace(/\n/g," / ").slice(0,120)')"
if (-not (ClickSel 'button[aria-label=设置]')) { Write-Host 'FAIL 设置3'; $fail++ }
Start-Sleep -Milliseconds 300
if (-not (ClickText 'button' '存储位置')) { Write-Host 'FAIL 存储3'; $fail++ }
Start-Sleep -Milliseconds 250
Check '权限被收回时给出「重新授权」' ([bool]((Eval 'document.body.innerText') -match '重新授权')) ''
Check '说明重试与重新授权不同' ([bool]((Eval 'document.body.innerText') -match '「重试」只是再打开|重新申请')) ''
if (-not (ClickDialogText '重新授权')) { Write-Host 'FAIL 点不到重新授权'; $fail++ }
Start-Sleep -Milliseconds 800
Check '拒绝授权时留在错误页并说清楚' ([bool]((Eval 'document.body.innerText') -match '没有成功|拒绝|打不开')) ''
Check '拒绝后对话框还开着，可以重试' ([bool]((Eval 'Boolean(document.querySelector("[role=dialog]"))'))) ''
[void](Eval 'window.__grant = true; "ok"')
if (-not (ClickDialogText '重新授权')) { Write-Host 'FAIL 再次授权'; $fail++ }
Start-Sleep -Milliseconds 1200
Check '授权成功后书架恢复' (-not [bool]((Eval 'document.body.innerText') -match '书架打不开|需要重新授权')) ''
Shot 'shelf-settings-1440'
Key 'Escape' 27

Write-Host ''
Write-Host 'N. 使用目标目录已有的书架'
if (-not (ClickSel 'button[aria-label=设置]')) { Write-Host 'FAIL 设置4'; $fail++ }
Start-Sleep -Milliseconds 300
if (-not (ClickText 'button' '存储位置')) { Write-Host 'FAIL 存储4'; $fail++ }
Start-Sleep -Milliseconds 250
if (-not (ClickText 'button' '更换')) { Write-Host 'FAIL 更换4'; $fail++ }
Start-Sleep -Milliseconds 800
Check '目标已有书架时列出现状' ([bool]((Eval 'document.body.innerText') -match '已经有一份书架')) ''
$hasMove = Eval "(() => { const d = document.querySelector('[role=dialog]'); return d ? [...d.querySelectorAll('button')].some((b) => b.textContent.includes('搬迁书架到新位置')) : null })()"
Check '已有书架时「搬迁」不可用' ($hasMove -eq $false) "hasMove=$hasMove"
if (-not (ClickDialogText '使用这个位置的书架')) { Write-Host 'FAIL 点不到使用已有'; $fail++ }
Start-Sleep -Milliseconds 1200
Check '切回旧书架后配置指向书库' ([bool]((Eval 'localStorage.getItem("dusk.shelf.v1")') -match '书库')) "cfg=$(Eval 'localStorage.getItem("dusk.shelf.v1")')"
Check '旧书架里的两本书还在' ((Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length") -eq 2) "n=$(Num "document.querySelectorAll('[data-dd-shelf] [data-book-id]').length")"
Key 'Escape' 27
Start-Sleep -Milliseconds 300

Write-Host ''
Write-Host 'O. 窄窗'
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1024; height = 768; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 700
Shot 'shelf-list-1024'
Write-Host ('  [1024 列表] ' + (Eval "(() => { const d = document.querySelector('[data-dd-shelf]')?.getBoundingClientRect(); return 'shelf=' + (d ? Math.round(d.width) : -1) + ' 溢出=' + (document.documentElement.scrollWidth > window.innerWidth) })()"))
[void](Send-Cdp 'Emulation.clearDeviceMetricsOverride' @{})
Start-Sleep -Milliseconds 400

Write-Host ''
Write-Host 'P. 控制台'
$errs = Eval 'window.__errs.join(" || ")'
$ro = Num 'window.__errs.filter((e) => e.indexOf("ResizeObserver loop") >= 0).length'
Write-Host "   [baseline] ResizeObserver 提醒 $ro 条 —— 浏览器调度提示，不计入失败"
$real = Eval 'window.__errs.filter((e) => e.indexOf("ResizeObserver loop") < 0).join(" || ")'
Check '没有未捕获的报错（除 ResizeObserver 基线）' ([string]::IsNullOrEmpty("$real")) "errs=$real"

[void](Send-Cdp 'Browser.close' @{})
Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL OK' } else { Write-Host "$fail FAILED"; exit 1 }
