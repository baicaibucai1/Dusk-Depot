param([string]$Url = 'http://localhost:5183/')
# 图片 / PDF 预览 · 交互验收
#
# 用一个假目录句柄塞进真实 PNG 和两页 PDF，走的是 host.read(字节) → Blob → 查看器 这条路。
$ErrorActionPreference = 'Stop'
$url = $Url
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddpv-' + [guid]::NewGuid().ToString('N'))
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
$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}
function ClickRow([string]$text) {
  $r = Eval "(() => { const b = [...document.querySelectorAll('[data-dd-files] button')].find((x) => x.textContent.trim() === '$text'); if (!b) return ''; const q = b.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
  if ($r -eq '') { return $false }
  $p = $r.Split(',')
  Click ([double]$p[0] + 20) ([double]$p[1] + [double]$p[3] / 2)
  return $true
}
$shots = Join-Path $PSScriptRoot '..\.workbuddy\shots\2026-10-31'
New-Item -ItemType Directory -Force -Path $shots | Out-Null
function Shot([string]$name) {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
  [IO.File]::WriteAllBytes((Join-Path $shots "$name.png"), [Convert]::FromBase64String($r.result.data))
  Write-Host "  shot $name"
}
function ClickIn([string]$scope, [string]$label) {
  return (Eval "(() => { const root = document.querySelector('$scope'); if (!root) return false; const b = [...root.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === '$label'); if (!b) return false; b.click(); return true })()")
}

Start-Sleep -Milliseconds 1000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

$root = 'C:\AI_Production\Dusk Depot'
$pngB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$root\示例库\素材\示例图片.png"))
$pdfB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$root\示例库\素材\示例文档.pdf"))
$badB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('not an image'))

$STUB = @"
(() => {
  window.__blob = { made: 0, freed: 0 };
  const co = URL.createObjectURL.bind(URL);
  const ro = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (b) => { window.__blob.made++; return co(b) };
  URL.revokeObjectURL = (u) => { window.__blob.freed++; return ro(u) };

  window.__log = [];
  const files = {
    '笔记.md': { text: '# 笔记\n\n还是能编辑的。\n' },
    '素材/图.png': { b64: '$pngB64' },
    '素材/文档.pdf': { b64: '$pdfB64' },
    '素材/坏图.png': { b64: '$badB64' },
  };
  const enc = new TextEncoder();
  function bytesOf(p) {
    const f = files[p];
    if (f.text !== undefined) return enc.encode(f.text);
    const bin = atob(f.b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function mk(path) {
    const h = { kind: 'directory', name: path ? path.split('/').pop() : '库' };
    const def = (k, v) => Object.defineProperty(h, k, { value: v, enumerable: false });
    def('values', async function* () {
      if (path === '') {
        yield { name: '笔记.md', kind: 'file' };
        yield { name: '素材', kind: 'directory' };
      } else if (path === '素材') {
        yield { name: '图.png', kind: 'file' };
        yield { name: '文档.pdf', kind: 'file' };
        yield { name: '坏图.png', kind: 'file' };
      }
    });
    def('getDirectoryHandle', async (n) => mk(path ? path + '/' + n : n));
    def('getFileHandle', async (n) => {
      const full = path ? path + '/' + n : n;
      if (!(full in files)) throw new DOMException('not found', 'NotFoundError');
      return {
        async getFile() { return new File([bytesOf(full)], n) },
        async createWritable() {
          let buf = '';
          return {
            async write(d) { buf += d instanceof Blob ? await d.text() : String(d) },
            async close() { files[full] = { text: buf }; window.__log.push('write:' + full) },
          };
        },
      };
    });
    def('removeEntry', async (n) => { delete files[path ? path + '/' + n : n] });
    def('queryPermission', async () => 'granted');
    def('requestPermission', async () => 'granted');
    return h;
  }
  window.showDirectoryPicker = async () => mk('');
  return 'stubbed';
})();
"@

[void](Send-Cdp 'Page.navigate' @{ url = $url })
Start-Sleep -Milliseconds 2800
$stub = Eval $STUB
Check '假目录装上了' ("$stub" -eq 'stubbed') "res=$stub"
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("选择文件夹")).click()')
Start-Sleep -Milliseconds 2500
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error))); "ok"')

Write-Host 'A. 文件树：md / 图片 / PDF 各归各类'
$rows = Eval '[...document.querySelectorAll("[data-dd-files] button")].map((b) => b.textContent.trim()).filter(Boolean).join("|")'
Check '树里有笔记、图、文档' ([bool](($rows -match '笔记') -and ($rows -match '图') -and ($rows -match '文档'))) "rows=$rows"
$imgIcons = Num 'document.querySelectorAll("[data-dd-files] .lucide-file-image").length'
$pdfIcons = Num 'document.querySelectorAll("[data-dd-files] .lucide-file-type").length'
Check '图片用 file-image 图标' ($imgIcons -ge 1) "n=$imgIcons"
Check 'PDF 用独立图标（file-type）' ($pdfIcons -ge 1) "n=$pdfIcons"

Write-Host 'B. 打开图片：尺寸、缩放、适应'
Check '点「图」打开图片' (ClickRow '图.png') ''
Start-Sleep -Milliseconds 1000
$imgN = Num 'document.querySelectorAll("[data-dd-image]").length'
Check '出现图片查看器' ($imgN -eq 1) "n=$imgN"
$imgText = Eval 'document.querySelector("[data-dd-image]") ? document.querySelector("[data-dd-image]").innerText.replace(/\n/g, " / ") : "none"'
Check '工具条显示格式和尺寸' ([bool](($imgText -match 'PNG') -and ($imgText -match '480 × 270'))) "text=$imgText"
$natW = Num 'document.querySelector("[data-dd-image] img") ? document.querySelector("[data-dd-image] img").naturalWidth : -1'
Check '图片真的解出来了（naturalWidth=480）' ($natW -eq 480) "w=$natW"

[void](ClickIn '[data-dd-image]' '放大'); Start-Sleep -Milliseconds 400
$z1 = Eval 'document.querySelector("[data-dd-image]").innerText.replace(/\n/g, " / ")'
Check '放大后百分比 > 100%' ([bool]($z1 -match '1[2-9][0-9]%|[2-9][0-9][0-9]%')) "text=$z1"
[void](ClickIn '[data-dd-image]' '实际大小'); Start-Sleep -Milliseconds 400
$z2 = Eval 'document.querySelector("[data-dd-image]").innerText.replace(/\n/g, " / ")'
Check '实际大小 = 100%' ([bool]($z2 -match '100%')) "text=$z2"
[void](ClickIn '[data-dd-image]' '适应窗口'); Start-Sleep -Milliseconds 400
$z3 = Eval 'document.querySelector("[data-dd-image]").innerText.replace(/\n/g, " / ")'
Check '回到适应窗口' ([bool]($z3 -match '适应')) "text=$z3"

Write-Host 'B2. Markdown 编辑器高度（DocPane 容器改过 flex，别把编辑器压塌）'
if (-not (ClickRow '笔记')) { Write-Host 'FAIL 点不到笔记'; $fail++ }
Start-Sleep -Milliseconds 1400
$cmH = Num "Math.round(document.querySelector('.cm-editor')?.getBoundingClientRect().height ?? 0)"
Check 'CodeMirror 撑满内容区（> 400）' ($cmH -gt 400) "h=$cmH"
Shot 'md-1440'

Write-Host 'C. 打开 PDF：连续多页、页码、文本层'
Check '点「文档」打开 PDF' (ClickRow '文档.pdf') ''
Start-Sleep -Milliseconds 2600
$pdfN = Num 'document.querySelectorAll("[data-dd-pdf]").length'
Check '出现 PDF 查看器' ($pdfN -eq 1) "n=$pdfN"
$pdfText = Eval 'document.querySelector("[data-dd-pdf]") ? document.querySelector("[data-dd-pdf]").innerText.replace(/\n/g, " / ") : "none"'
Check '页码显示 1 / 2' ([bool]($pdfText -match '1 / 2')) "text=$pdfText"
$pageBoxes = Num 'document.querySelectorAll("[data-dd-pdf] [data-page-no]").length'
Check '两页排在同一条滚动流里（不是单页翻）' ($pageBoxes -eq 2) "n=$pageBoxes"
$cw = Num 'document.querySelectorAll("[data-dd-pdf] [data-page-no=\"1\"] canvas")[0]?.width ?? 0'
Check '第 1 页 canvas 画出来了（宽 > 100）' ($cw -gt 100) "w=$cw"
$spans = Num 'document.querySelectorAll("[data-dd-pdf-text] span").length'
Check '文本层有字（可选）' ($spans -ge 1) "n=$spans"
$sel = Eval '(() => { const box = document.querySelector("[data-dd-pdf-text]"); if (!box) return ""; const r = document.createRange(); r.selectNodeContents(box); const s = getSelection(); s.removeAllRanges(); s.addRange(r); const t = s.toString(); s.removeAllRanges(); return t })()'
Check '文本真的能选中（selection 非空）' ([bool]("$sel" -match '\S')) "sel=$sel"

# 选中整页文字：文本层的位置/字号必须和 canvas 严丝合缝
$selInfo = Eval @'
(() => {
  const tb = document.querySelector('[data-page-no="1"] .dd-pdf-text');
  const c = document.querySelector('[data-page-no="1"] canvas');
  if (!tb || !c) return 'none';
  const r = document.createRange();
  r.selectNodeContents(tb);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  const cr = c.getBoundingClientRect();
  const tr = tb.getBoundingClientRect();
  const sp = tb.querySelector('span');
  const sr = sp ? sp.getBoundingClientRect() : null;
  const cs = sp ? getComputedStyle(sp) : null;
  return JSON.stringify({
    canvas: [Math.round(cr.width), Math.round(cr.height)],
    textLayer: [Math.round(tr.width), Math.round(tr.height)],
    span: sr ? [Math.round(sr.left - cr.left), Math.round(sr.top - cr.top), Math.round(sr.width), Math.round(sr.height)] : null,
    font: cs ? cs.fontSize : '',
    fontHeight: sp ? sp.style.getPropertyValue('--font-height') : '',
    tsf: getComputedStyle(tb).getPropertyValue('--total-scale-factor'),
  });
})()
'@
Write-Host ('   [select] ' + $selInfo)
$fontOk = Eval @'
(() => {
  const tb = document.querySelector('[data-page-no="1"] .dd-pdf-text');
  const sp = tb.querySelector('span');
  if (!sp) return 'no-span';
  const cs = getComputedStyle(sp);
  const h = parseFloat(sp.style.getPropertyValue('--font-height')) || 0;
  const tsf = parseFloat(cs.getPropertyValue('--total-scale-factor')) || 1;
  const fs = parseFloat(cs.fontSize) || 0;
  return JSON.stringify({ want: Math.round(h * tsf * 100) / 100, got: fs, ok: Math.abs(fs - h * tsf) < 0.5 });
})()
'@
Write-Host ('   [font] ' + $fontOk)
$f = $fontOk | ConvertFrom-Json
Check '文本层字号跟页面字号一致（不是默认 16px）' ($f.ok -eq $true) "want=$($f.want) got=$($f.got)"
Check '选中的字块高度接近字形高度' ([bool]([double]$f.got -gt 24)) "size=$($f.got)"

Shot 'pdf-pages-1440'

Write-Host 'C2. 滚轮滚动 → 第 2 页自己滚进来，页码跟着走'
$diag = Eval "(() => { const el = document.querySelector('[data-dd-pdf]').lastElementChild; if (!el) return 'none'; const q = el.getBoundingClientRect(); return el.tagName + '.' + el.className + ' | sh=' + el.scrollHeight + ' ch=' + el.clientHeight + ' top=' + el.scrollTop + ' ov=' + getComputedStyle(el).overflowY + ' rect=' + Math.round(q.left) + ',' + Math.round(q.top) + ',' + Math.round(q.width) + ',' + Math.round(q.height) })()"
Write-Host ('   [diag] ' + $diag)

$r = Eval "(() => { const el = document.querySelector('[data-dd-pdf]').lastElementChild; const q = el.getBoundingClientRect(); return q.left + ',' + q.top + ',' + q.width + ',' + q.height })()"
$p = $r.Split(',')
$mx = [double]$p[0] + [double]$p[2] / 2
$my = [double]$p[1] + [double]$p[3] / 2
[void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseMoved'; x = $mx; y = $my; button = 'none' })
for ($i = 0; $i -lt 4; $i++) {
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseWheel'; x = $mx; y = $my; deltaX = 0; deltaY = 420 })
  Start-Sleep -Milliseconds 160
}
Start-Sleep -Milliseconds 2200
$scrolled = Num "Math.round(document.querySelector('[data-dd-pdf]').lastElementChild.scrollTop)"
Check '滚轮能把长页滚下去（scrollTop > 0）' ($scrolled -gt 40) "top=$scrolled"
$pdfText2 = Eval 'document.querySelector("[data-dd-pdf]").innerText.replace(/\n/g, " / ")'
Check '滚到第 2 页时页码变 2 / 2' ([bool]($pdfText2 -match '2 / 2')) "text=$pdfText2"
$lt = Eval 'document.querySelector("[data-page-no=\"2\"] [data-dd-pdf-text]")?.textContent ?? "none"'
Check '第 2 页文本层跟着渲染' ([bool]($lt -match 'Page 2')) "text=$lt"

Write-Host 'C3. 缩放：适合宽度 / 放大 / 滑块 / 100%'
[void](ClickIn '[data-dd-pdf]' '实际大小'); Start-Sleep -Milliseconds 1400
$w1 = Num 'Math.round(document.querySelector("[data-page-no=\"2\"] canvas")?.getBoundingClientRect().width ?? 0)'
[void](ClickIn '[data-dd-pdf]' '放大'); Start-Sleep -Milliseconds 1600
$w2 = Num 'Math.round(document.querySelector("[data-page-no=\"2\"] canvas")?.getBoundingClientRect().width ?? 0)'
Check '放大后画布变宽' ($w2 -gt $w1) "$w1 → $w2"

$slider = Eval @'
(() => {
  const el = document.querySelector('.dd-range');
  if (!el) return 'no-slider';
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(el, '60');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()
'@
Start-Sleep -Milliseconds 1600
$w3 = Num 'Math.round(document.querySelector("[data-page-no=\"2\"] canvas")?.getBoundingClientRect().width ?? 0)'
$zoomText = Eval 'document.querySelector("[data-dd-pdf]").innerText.replace(/\n/g, " / ")'
Check '滑块能缩到 60%' (($slider -eq 'ok') -and [bool]($zoomText -match '60%')) "res=$slider text=$zoomText"
Check '滑块缩放真的改变了画布宽度' ($w3 -lt $w2) "$w2 → $w3"
Shot 'pdf-zoom-60'

[void](ClickIn '[data-dd-pdf]' '适合宽度'); Start-Sleep -Milliseconds 1500
$pdfText3 = Eval 'document.querySelector("[data-dd-pdf]").innerText.replace(/\n/g, " / ")'
$wFit = Num 'Math.round(document.querySelector("[data-page-no=\"2\"] canvas")?.getBoundingClientRect().width ?? 0)'
Check '回到适合宽度' ([bool]($pdfText3 -match '适合')) "text=$pdfText3"
Check '适合宽度下画布宽度回到容器内' ($wFit -gt $w3) "$w3 → $wFit"
Shot 'pdf-pages-fit'

Write-Host 'C4. 窄窗（1024×768）'
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1024; height = 768; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 800
Check '1024 下整页没有横向溢出' ((Eval 'document.documentElement.scrollWidth <= window.innerWidth') -eq $true) "sw=$(Eval 'document.documentElement.scrollWidth') vw=$(Eval 'window.innerWidth')"
Check '1024 下滑块还在工具栏里' ((Num 'document.querySelectorAll("[data-dd-pdf] .dd-range").length') -eq 1) ''
$toolbar = Eval "(() => { const t = document.querySelector('[data-dd-pdf]').firstElementChild; const q = t.getBoundingClientRect(); const last = t.lastElementChild.getBoundingClientRect(); return Math.round(q.right - last.right) })()"
Check '1024 下缩放按钮没被挤出工具栏' ([int]$toolbar -ge 0) "rightGap=$toolbar"
Shot 'pdf-1024'
[void](Send-Cdp 'Emulation.clearDeviceMetricsOverride' @{})
Start-Sleep -Milliseconds 500

Write-Host 'D. 标签页：图片与 PDF 各占一个，切换内容对得上'
$r = Eval '(() => { const b = [...document.querySelectorAll("[data-dd-files] button")].find((x) => x.textContent.includes("图.png")); if (!b) return ""; const q = b.getBoundingClientRect(); return q.left + "," + q.top })()'
if ($r -ne '') {
  $p = $r.Split(',')
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mousePressed'; x = [double]$p[0] + 20; y = [double]$p[1] + 10; button = 'right'; clickCount = 1 })
  [void](Send-Cdp 'Input.dispatchMouseEvent' @{ type = 'mouseReleased'; x = [double]$p[0] + 20; y = [double]$p[1] + 10; button = 'right'; clickCount = 1 })
  Start-Sleep -Milliseconds 500
  [void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "在新标签页打开"); if (b) b.click(); return 1 })()')
  Start-Sleep -Milliseconds 900
}
$tabs = Num 'document.querySelector("main header div.overflow-x-auto").children.length'
Check '图片进了第二个标签' ($tabs -ge 2) "tabs=$tabs"
[void](Eval '(() => { const ts = [...document.querySelector("main header div.overflow-x-auto").children]; const t = ts.find((d) => d.textContent.includes("文档")); if (t) t.querySelector("button").click(); return 1 })()')
Start-Sleep -Milliseconds 1200
$pdfN2 = Num 'document.querySelectorAll("[data-dd-pdf]").length'
Check '切到 PDF 标签 → 显示 PDF' ($pdfN2 -eq 1) "n=$pdfN2"
[void](Eval '(() => { const ts = [...document.querySelector("main header div.overflow-x-auto").children]; const t = ts.find((d) => d.textContent.includes("图.png")); if (t) t.querySelector("button").click(); return 1 })()')
Start-Sleep -Milliseconds 1200
$imgN2 = Num 'document.querySelectorAll("[data-dd-image]").length'
Check '切回图片标签 → 显示图片' ($imgN2 -eq 1) "n=$imgN2"

Write-Host 'E. 快速连续切换：不串内容、不漏 Blob URL'
$madeBefore = Num 'window.__blob.made'
$freedBefore = Num 'window.__blob.freed'
foreach ($i in 1..4) {
  [void](ClickRow '图.png')
  [void](ClickRow '文档.pdf')
}
[void](ClickRow '图.png')
Start-Sleep -Milliseconds 1400
$imgEnd = Num 'document.querySelectorAll("[data-dd-image]").length'
$pdfEnd = Num 'document.querySelectorAll("[data-dd-pdf]").length'
Check '连切之后停在最后点的那张图' (($imgEnd -eq 1) -and ($pdfEnd -eq 0)) "image=$imgEnd pdf=$pdfEnd"
$made = (Num 'window.__blob.made') - $madeBefore
$freed = (Num 'window.__blob.freed') - $freedBefore
Check "Blob URL 收支平衡（新建 $made / 释放 $freed）" (($made - $freed) -le 2) "made=$made freed=$freed"

Write-Host 'F. 右栏：图片显示文件信息，不显示大纲/反链'
$asideLabel = Eval 'document.querySelector("aside") ? document.querySelector("aside").getAttribute("aria-label") : "none"'
Check '右栏标题是「文件信息」' ("$asideLabel" -eq '文件信息') "aside=$asideLabel"
$hasBacklink = Eval 'document.body.innerText.includes("引用这篇的")'
Check '右栏没有大纲/关系内容' (-not [bool]$hasBacklink) ''

Write-Host 'G. Markdown 仍然能编辑'
[void](ClickRow '笔记')
Start-Sleep -Milliseconds 1000
$cmN = Num 'document.querySelectorAll(".cm-editor").length'
Check '回到 md → 编辑器挂载' ($cmN -eq 1) "cm=$cmN"
[void](Eval '(() => { const v = window.__dd_view; if (!v) return 0; v.focus(); return 1 })()')
Start-Sleep -Milliseconds 250
$len1 = Num 'window.__dd_view.state.doc.length'
[void](Send-Cdp 'Input.insertText' @{ text = '还能写' })
Start-Sleep -Milliseconds 600
$len2 = Num 'window.__dd_view.state.doc.length'
Check 'md 里打字进得去' ($len2 -gt $len1) "$len1 → $len2"

Write-Host 'H. 坏图 / 窄窗口'
[void](ClickRow '坏图.png')
Start-Sleep -Milliseconds 1000
$badText = Eval 'document.querySelector("[data-dd-image]") ? document.querySelector("[data-dd-image]").innerText.replace(/\n/g, " / ") : "none"'
Check '坏图给出可读的错误' ([bool]($badText -match '打不开|不是一张')) "text=$badText"
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1024; height = 768; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 800
$overflow = Eval 'document.documentElement.scrollWidth <= window.innerWidth + 1'
Check '1024×768：无横向溢出' ([bool]$overflow) "scroll=$(Eval 'document.documentElement.scrollWidth')"
$btnW = Num '(() => { const b = document.querySelector("[data-dd-image] button[aria-label=适应窗口]"); return b ? Math.round(b.getBoundingClientRect().width) : -1 })()'
Check '窄窗口下缩放按钮还在' ($btnW -gt 0) "w=$btnW"
[void](Send-Cdp 'Emulation.clearDeviceMetricsOverride' @{})

$wroteAsset = Eval 'window.__log.some((l) => l.includes("图.png") || l.includes("文档.pdf"))'
Check '图片 / PDF 没有被写回（没有 write 记录）' (-not [bool]$wroteAsset) "log=$(Eval 'window.__log.join(",")')"

$errs = Eval 'window.__errs ? window.__errs.join(" | ") : ""'
$errN = Num 'window.__errs ? window.__errs.length : 0'
Check '零 JS 报错' ($errN -eq 0) "errs=$errs"

Write-Host ''
if ($fail -eq 0) { Write-Host 'ALL PASS' } else { Write-Host "FAILED: $fail" }

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
