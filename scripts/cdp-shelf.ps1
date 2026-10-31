param([string]$Url = 'http://127.0.0.1:5184/')
# 书架 / EPUB 阅读器 · 浏览器路径验收
#
# 假目录：第一次 showDirectoryPicker 给仓库，之后给「书库」——
# 书架和仓库在同一个假文件系统里但前缀不同，能验"书架不写仓库"。
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
$badB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:TEMP\dd-shelf-epub\损坏.epub"))
$drmB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:TEMP\dd-shelf-epub\加密.epub"))

$STUB = @"
(() => {
  window.__files = {}; window.__dirs = new Set(['']); window.__log = []; window.__errs = [];
  window.__picked = 0;
  const enc = new TextEncoder();
  function put(p, text) {
    window.__files[p] = { text: text };
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) window.__dirs.add(parts.slice(0, i).join('/'));
  }
  function b64(s) {
    const bin = atob(s); const out = new Uint8Array(bin.length);
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
      if (!(full in window.__files) && !(opts && opts.create)) throw new DOMException('nf', 'NotFoundError');
      return {
        async getFile() {
          const f = window.__files[full];
          if (!f) throw new DOMException('nf', 'NotFoundError');
          const data = f.text !== undefined ? enc.encode(f.text) : b64(f.b64);
          return new File([data], n);
        },
        async createWritable() {
          const chunks = [];
          return {
            async write(d) {
              if (d instanceof Blob) chunks.push(new Uint8Array(await d.arrayBuffer()));
              else chunks.push(enc.encode(String(d)));
            },
            async close() {
              let total = 0;
              for (const c of chunks) total += c.length;
              const all = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) { all.set(c, off); off += c.length; }
              const text = new TextDecoder('utf-8').decode(all);
              const round = enc.encode(text);
              let same = round.length === all.length;
              if (same) for (let i = 0; i < all.length; i++) if (round[i] !== all[i]) { same = false; break; }
              if (same) {
                window.__files[full] = { text: text };
              } else {
                let bin = '';
                for (let i = 0; i < all.length; i++) bin += String.fromCharCode(all[i]);
                window.__files[full] = { b64: btoa(bin) };
              }
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
  window.showDirectoryPicker = async () => {
    window.__picked += 1;
    return window.__picked === 1 ? mk('') : mk('书库');
  };
  put('笔记.md', '# 笔记\n\n仓库里的东西。\n');
  const ce = console.error.bind(console);
  console.error = function () { window.__errs.push(Array.from(arguments).map(String).join(' ')); ce.apply(null, arguments) };
  window.addEventListener('error', (e) => window.__errs.push('error: ' + String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => window.__errs.push('reject: ' + String(e.reason)));
  return 'stubbed';
})();
"@

[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 2600
Check '假目录装上了' ((Eval $STUB) -eq 'stubbed') ''
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("选择文件夹")).click()')
Start-Sleep -Milliseconds 2200

Write-Host ''
Write-Host 'A. 书架入口'
Check '左侧有「书架」' ((Num 'document.querySelectorAll("nav[aria-label=功能导航] button").length') -ge 3) ''
if (-not (ClickSel 'nav[aria-label=功能导航] button[aria-label=书架]')) { Write-Host 'FAIL 点不到书架'; $fail++ }
Start-Sleep -Milliseconds 700
Check '进入书架工作区' ([bool]((Eval 'document.body.innerText') -match '先给书架选个位置')) ''
Check '还没建书架清单（没偷偷写仓库）' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match 'library.json')) ''

Write-Host ''
Write-Host 'B. 选书架目录'
if (-not (ClickText 'button' '选一个文件夹')) { Write-Host 'FAIL 点不到选文件夹'; $fail++ }
Start-Sleep -Milliseconds 1200
Check '书架位置独立于仓库（书库/）' ([bool]((Eval 'window.__picked') -eq 2)) "picked=$(Eval 'window.__picked')"
Check '空书架欢迎页' ([bool]((Eval 'document.body.innerText') -match '书架还是空的')) ''

Write-Host ''
Write-Host 'C. 拖入 EPUB（浏览器分支）'
$drop = Eval @"
(() => {
  const bin = atob('$bookB64');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], '三体.epub', { type: 'application/epub+zip' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const zone = document.querySelector('[data-drop-zone="shelf-welcome"]');
  if (!zone) return 'no-zone';
  zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'dropped';
})()
"@
Check '拖放事件发出去了' ($drop -eq 'dropped') "res=$drop"
$imported = WaitFor 'Boolean(window.__files["书库/三体.epub"]) && Boolean(window.__files["书库/library.json"])' 15000
Check '书复制进了书架目录' $imported "files=$(Eval 'Object.keys(window.__files).join(",")')"
Check '书没进仓库' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '^三体.epub')) ''

$libRaw = Eval 'window.__files["书库/library.json"]?.text || ""'
Check '清单记了书名/作者/大小' ([bool](($libRaw -match '三体') -and ($libRaw -match '刘慈欣'))) "lib=$libRaw"
Check '清单带封面缩略图（data URL）' ([bool]($libRaw -match 'data:image/jpeg;base64')) ''
Check '列表里出现这本书' ((Num "document.querySelectorAll('[data-dd-shelf] li > button[data-book-id]').length") -eq 1) "n=$(Num "document.querySelectorAll('[data-dd-shelf] li > button[data-book-id]').length")"
Check '列表显示作者' ([bool]((Eval 'document.querySelector("[data-dd-shelf]")?.textContent') -match '刘慈欣')) ''

Shot 'shelf-list-1440'
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1024; height = 768; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 600
Shot 'shelf-list-1024'
Write-Host ('  [1024 列表] ' + (Eval "(() => { const d = document.querySelector('[data-dd-shelf]')?.getBoundingClientRect(); return 'shelf=' + (d ? Math.round(d.width) : -1) + ' 溢出=' + (document.documentElement.scrollWidth > window.innerWidth) })()"))
[void](Send-Cdp 'Emulation.clearDeviceMetricsOverride' @{})
Start-Sleep -Milliseconds 400

Write-Host ''
Write-Host 'D. 重复 / 损坏 / DRM'
$dup = Eval @"
(() => {
  const bin = atob('$bookB64');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], '三体（另一个名字）.epub', { type: 'application/epub+zip' }));
  const zone = document.querySelector('[data-drop-zone="shelf-list"]');
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'ok';
})()
"@
Start-Sleep -Milliseconds 1200
Check '同一本书不重复入库（按内容判）' ((Num "document.querySelectorAll('[data-dd-shelf] li > button[data-book-id]').length") -eq 1) "n=$(Num "document.querySelectorAll('[data-dd-shelf] li > button[data-book-id]').length")"
Check '提示"已在书架中"' ([bool]((Eval 'document.body.innerText') -match '已在书架中')) ''

$bad = Eval @"
(() => {
  const bin = atob('$badB64'); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], '损坏.epub', { type: 'application/epub+zip' }));
  document.querySelector('[data-drop-zone="shelf-list"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'ok';
})()
"@
Start-Sleep -Milliseconds 1500
Check '坏文件没进书架' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '损坏.epub')) ''
Check '坏文件给了提示' ([bool]((Eval 'document.body.innerText') -match '不是标准 EPUB|打不开')) ''

$drm = Eval @"
(() => {
  const bin = atob('$drmB64'); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], '加密.epub', { type: 'application/epub+zip' }));
  document.querySelector('[data-drop-zone="shelf-list"]').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'ok';
})()
"@
Start-Sleep -Milliseconds 1500
Check 'DRM 书没入库' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '加密.epub')) ''
Check 'DRM 提示说清楚' ([bool]((Eval 'document.body.innerText') -match 'DRM')) ''

Write-Host ''
Write-Host 'E. 阅读'
if (-not (ClickText '[data-dd-shelf] li button' '三体')) { Write-Host 'FAIL 点不到书'; $fail++ }
$ready = WaitFor 'Boolean(document.querySelector("[data-dd-reader] iframe"))' 12000
Check '阅读器渲染出 iframe' $ready ''
Start-Sleep -Milliseconds 900
$body = Eval 'document.querySelector("[data-dd-reader] iframe")?.contentDocument?.body?.innerText ?? ""'
Check '正文里有第一章' ([bool]($body -match '地球往事')) "body=$($body.Substring(0,[Math]::Min(80,$body.Length)))"
Check '右栏有目录' ([bool]((Eval 'document.querySelector("[aria-label=书籍目录与书签]")?.textContent') -match '第一章')) ''
Check '右栏有进度百分比' ([bool]((Eval 'document.querySelector("[aria-label=书籍目录与书签]")?.textContent') -match '未开始|%')) ''

$cfiBefore = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books[0].cfi || "" } catch { return "" } })()'
Key 'ArrowRight' 39
Start-Sleep -Milliseconds 1400
$cfiAfter = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books[0].cfi || "" } catch { return "" } })()'
Check '翻页后进度记下来了（CFI）' ([bool]($cfiAfter -match 'epubcfi')) "cfi=$cfiAfter"
$pct = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books[0].percent || 0 } catch { return -1 } })()'
Check '百分比也在 0..1 内' ([bool]([double]$pct -ge 0 -and [double]$pct -le 1)) "pct=$pct"

Shot 'shelf-reader-1440'
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1024; height = 768; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 700
Shot 'shelf-reader-1024'
Write-Host ('  [1024 阅读] ' + (Eval "(() => { const m = document.querySelector('main'); const r = m?.getBoundingClientRect(); const f = document.querySelector('[data-dd-reader] iframe'); return 'main=' + (r ? Math.round(r.width) : -1) + ' iframe=' + (f ? Math.round(f.getBoundingClientRect().width) : -1) + ' 溢出=' + (document.documentElement.scrollWidth > window.innerWidth) })()"))
[void](Send-Cdp 'Emulation.clearDeviceMetricsOverride' @{})
Start-Sleep -Milliseconds 500

Write-Host ''
Write-Host 'F. 书签'
if (-not (ClickSel 'button[aria-label=加书签]')) { Write-Host 'FAIL 点不到加书签'; $fail++ }
Start-Sleep -Milliseconds 900
$marks = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books[0].bookmarks.length } catch { return -1 } })()'
Check '书签写进了清单' ([bool]($marks -eq 1)) "n=$marks"
if (ClickText '[aria-label=书籍目录与书签] button' '书签') { } else { Write-Host 'FAIL 点不到书签页签'; $fail++ }
Start-Sleep -Milliseconds 400
Check '书签列表有那一条' ([bool]((Eval 'document.querySelector("[aria-label=书籍目录与书签]")?.textContent') -match '第一章|第二章|当前位置')) ''

Write-Host ''
Write-Host 'G. 关闭重开（恢复位置）'
if (-not (ClickSel 'button[aria-label=返回书架]')) { Write-Host 'FAIL 点不到返回书架'; $fail++ }
Start-Sleep -Milliseconds 600
Check '回到书架列表' ((Num "document.querySelectorAll('[data-dd-shelf] li > button[data-book-id]').length") -eq 1) 
if (-not (ClickText '[data-dd-shelf] li button' '三体')) { Write-Host 'FAIL 再点不开书'; $fail++ }
[void](WaitFor 'Boolean(document.querySelector("[data-dd-reader] iframe"))' 10000)
Start-Sleep -Milliseconds 900
$cfiNow = Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books[0].cfi || "" } catch { return "" } })()'
Check '重开还是上次的 CFI' ($cfiNow -eq $cfiAfter) "now=$cfiNow was=$cfiAfter"

Write-Host ''
Write-Host 'H. 删除（确认 + 删文件）'
if (-not (ClickSel 'button[aria-label=返回书架]')) { Write-Host 'FAIL 点不到返回书架（删除前）'; $fail++ }
Start-Sleep -Milliseconds 500
$menu = Eval @'
(() => {
  const b = document.querySelector('[data-dd-shelf] li button');
  if (!b) return 'no';
  const r = b.getBoundingClientRect();
  b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));
  return 'ok';
})()
'@
Start-Sleep -Milliseconds 350
Check '右键菜单有「在资源管理器中查看」' ([bool]((Eval 'document.body.innerText') -match '在资源管理器中查看')) ''
Check 'FSA 下它是灰的（拿不到真实路径）' ((Eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('在资源管理器中查看')); return b ? b.disabled : null })()") -eq $true) ''
if (ClickText 'button' '复制书架内相对路径') { } else { Write-Host 'FAIL 点不到复制路径'; $fail++ }
Start-Sleep -Milliseconds 250

$menu2 = Eval @'
(() => {
  const b = document.querySelector('[data-dd-shelf] li button');
  const r = b.getBoundingClientRect();
  b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 20 }));
  return 'ok';
})()
'@
Start-Sleep -Milliseconds 300
if (ClickText 'button' '从书架删除') { } else { Write-Host 'FAIL 点不到删除'; $fail++ }
Start-Sleep -Milliseconds 350
Check '删除前有确认（带文件名）' ([bool]((Eval 'document.body.innerText') -match '从书架删除《三体》')) ''
if (ClickText 'button' '删除') { } else { Write-Host 'FAIL 确认删除点不到'; $fail++ }
Start-Sleep -Milliseconds 900
Check '书文件真的删了' (-not [bool]((Eval 'Object.keys(window.__files).join(",")') -match '书库/三体.epub')) ''
Check '清单里也没了' ((Eval '(() => { try { return JSON.parse(window.__files["书库/library.json"].text).books.length } catch { return -1 } })()') -eq 0) ''
Check '列表回到空状态' ([bool]((Eval 'document.body.innerText') -match '书架还是空的')) ''

Write-Host ''
Write-Host 'I. 设置里的书架位置'
if (-not (ClickSel 'button[aria-label=设置]')) { Write-Host 'FAIL 点不到设置'; $fail++ }
Start-Sleep -Milliseconds 400
if (ClickText 'button' '存储位置') { } else { Write-Host 'FAIL 点不到设置里的书架'; $fail++ }
Start-Sleep -Milliseconds 300
Check '设置里显示书架路径' ([bool]((Eval 'document.body.innerText') -match '书架位置')) ''
Shot 'shelf-settings-1440'
Check '浏览器下"打开文件夹"是禁用的' ((Eval "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('打开书架文件夹')); return b ? b.disabled : null })()") -eq $true) ''
Key 'Escape' 27

Write-Host ''
Write-Host 'J. 控制台'
$errs = Eval 'window.__errs.join(" || ")'
Check '没有未捕获的报错' ([string]::IsNullOrEmpty("$errs")) "errs=$errs"

[void](Send-Cdp 'Browser.close' @{})
Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL OK' } else { Write-Host "$fail FAILED"; exit 1 }
