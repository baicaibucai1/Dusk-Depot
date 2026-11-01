# `.board` 白板：文件区闭环 + 编辑 + 连接 + .note 引用 + PDF 图标。
# 用 CDP 驱动无头 Edge 真点按钮，不是"看着像"。
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
$root = 'C:\AI_Production\Dusk Depot'
$shots = Join-Path $root '.workbuddy\shots\2026-11-01'
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
      layout: { mode: 'stack', order: ['n1','n2'] },
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

Write-Host 'A. 文件树：.board 与 PDF 的图标'
$boardIcons = Num 'document.querySelectorAll("[data-dd-files] [data-icon=board]").length'
Check '白板行有专属图标' ($boardIcons -ge 1) "n=$boardIcons"
$pdfIcons = Num 'document.querySelectorAll("[data-dd-files] [data-icon=pdf]").length'
Check 'PDF 行有自己的图标（不是 file-type）' ($pdfIcons -ge 1) "n=$pdfIcons"
$legacyType = Num 'document.querySelectorAll("[data-dd-files] .lucide-file-type").length'
Check '不再用 Lucide file-type 冒充 PDF' ($legacyType -eq 0) "n=$legacyType"
$boardRow = Eval '[...document.querySelectorAll("[data-dd-files] button")].some((b) => (b.textContent||"").includes("项目.board"))'
Check '树里有 白板/项目.board' ([bool]$boardRow) ''

Write-Host 'B. 打开白板：编辑器而不是 JSON'
Check '点白板打开' (ClickText '项目.board') ''
Start-Sleep -Milliseconds 1500
Check '出现白板编辑器' ((Num 'document.querySelectorAll("[data-dd-board-scroll]").length') -eq 1) ''
$blockN = Num 'document.querySelectorAll("[data-dd-board-block]").length'
Check '两块都在' ($blockN -eq 2) "n=$blockN"
$lineN = Num 'document.querySelectorAll("[data-dd-board-links] path").length'
Check '连接线画出来了（1 条）' ($lineN -eq 1) "n=$lineN"
$titleVal = Eval 'document.querySelector("input[aria-label=白板标题]")?.value ?? ""'
Check '标题读的是文件里的 title' ($titleVal -eq '项目白板') "title=$titleVal"
$status = Eval 'document.querySelector("[data-dd-board-scroll]")?.closest("div.flex")?.parentElement?.querySelector("header span[aria-live]")?.textContent ?? ""'
Check '初始状态是已保存' ($status -eq '已保存') "status=$status"
# 键盘焦点：Tab 走一圈必须看得见焦点在哪（统一绿环，见 styles.css）
Key 'Tab' 'Tab' 9
Start-Sleep -Milliseconds 250
$focusRing = Eval '(() => { const el = document.activeElement; if (!el || el === document.body) return "none"; const cs = getComputedStyle(el); return el.tagName + "|" + cs.outlineStyle + "|" + cs.outlineWidth })()'
Check '键盘焦点画得出来（2px solid）' ([bool]("$focusRing" -match '\|solid\|2px')) "focus=$focusRing"
Shot 'board-editor-1440'

Write-Host 'C. 编辑块：只改这一块，改完真的落盘'
[void](Eval '(() => { const el = document.querySelector("[data-dd-board-block=n2] .dd-board-input"); if (!el) return false; el.focus(); const s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); s.addRange(r); return true })()')
[void](Send-Cdp 'Input.insertText' @{ text = '（已改）' })
Start-Sleep -Milliseconds 1200
$text2 = Eval 'window.__files["白板/项目.board"].text'
Check '磁盘上的块内容更新了' ([bool]("$text2" -match '已改')) ''
$linkKept = Eval 'JSON.parse(window.__files["白板/项目.board"].text).links.length'
Check '连接没有被编辑冲掉' ($linkKept -eq 1) "links=$linkKept"
$n1Kept = Eval 'JSON.parse(window.__files["白板/项目.board"].text).blocks.n1.content[0].text'
Check '其它块也没被动' ($n1Kept -eq '本周目标') "n1=$n1Kept"
$status2 = Eval 'document.querySelector("header span[aria-live]")?.textContent ?? ""'
Check '状态回到已保存' ($status2 -eq '已保存') "status=$status2"

Write-Host 'D. 撤销 / 重做'
[void](Eval 'document.querySelector("button[aria-label=撤销]").click()')
Start-Sleep -Milliseconds 900
$text3 = Eval 'window.__files["白板/项目.board"].text'
Check '撤销后磁盘上也没有那句话' (-not [bool]("$text3" -match '已改')) ''
[void](Eval 'document.querySelector("button[aria-label=重做]").click()')
Start-Sleep -Milliseconds 900
$text4 = Eval 'window.__files["白板/项目.board"].text'
Check '重做后又回来了' ([bool]("$text4" -match '已改')) ''

Write-Host 'E. 添加块 + 连接'
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "添加块"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 400
Check '菜单里有「待办」' (MenuItem '待办') ''
Start-Sleep -Milliseconds 600
$blockN2 = Num 'document.querySelectorAll("[data-dd-board-block]").length'
Check '块数变成 3' ($blockN2 -eq 3) "n=$blockN2"
$order = Eval '[...document.querySelectorAll("[data-dd-board-block]")].map((e) => e.dataset.ddBoardBlock).join(",")'
Check '新块加在末尾' ($order -eq 'n1,n2,n3') "order=$order"

Write-Host 'E2. 从文件树拖进来 = 引用（不复制）'
$before = Eval 'Object.keys(window.__files).filter((p) => p.startsWith(".dusk/")).length'
[void](Eval @'
(() => {
  const dt = new DataTransfer();
  dt.setData('text/plain', '素材/图.png');
  const el = document.querySelector('[data-dd-board-scroll]');
  if (!el) return false;
  el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  return true;
})()
'@)
Start-Sleep -Milliseconds 900
$refBlock = Eval '(() => { const d = JSON.parse(window.__files["白板/项目.board"].text); const b = d.blocks[d.layout.order[d.layout.order.length-1]]; return JSON.stringify({ type: b.type, src: b.src, source: b.source }) })()'
Check '落下来是一张引用卡片' ([bool]("$refBlock" -match '"source":"link"')) "block=$refBlock"
Check '引用的是那个仓库文件' ([bool]("$refBlock" -match '素材/图.png')) "block=$refBlock"
$after = Eval 'Object.keys(window.__files).filter((p) => p.startsWith(".dusk/")).length'
Check '没有复制出附件目录' ($after -eq $before) "before=$before after=$after"

Write-Host 'F. 块菜单：上移 / 复制'
[void](Eval '(() => { const b = document.querySelector("button[aria-label=\"块 n3 的菜单\"]"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 300
Check '菜单里有「上移」' (MenuItem '上移') ''
Start-Sleep -Milliseconds 500
$order2 = Eval '[...document.querySelectorAll("[data-dd-board-block]")].map((e) => e.dataset.ddBoardBlock).join(",")'
Check '上移把 n3 挪到了 n2 前面' ($order2 -eq 'n1,n3,n2,n4') "order=$order2"

Write-Host 'G. 建立连接'
[void](Eval '(() => { const b = document.querySelector("button[aria-label=\"块 n1 的菜单\"]"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 300
Check '菜单里有「连接到…」' (MenuItem '连接到…') ''
Start-Sleep -Milliseconds 400
$dlg = Num 'document.querySelectorAll("[role=dialog][aria-label=新建块间连接]").length'
Check '打开连接对话框' ($dlg -eq 1) "n=$dlg"
[void](Eval '(() => { const s = document.querySelector("[role=dialog] select"); if (!s) return false; s.value = s.options[1] ? s.options[1].value : s.value; s.dispatchEvent(new Event("change", { bubbles: true })); return true })()')
[void](Eval '(() => { const b = [...document.querySelectorAll("[role=dialog] button")].find((x) => (x.textContent||"").trim() === "建立连接"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 800
$linkN2 = Eval 'JSON.parse(window.__files["白板/项目.board"].text).links.length'
Check '磁盘上多了一条连接' ($linkN2 -eq 2) "links=$linkN2"
$lineN2 = Num 'document.querySelectorAll("[data-dd-board-links] path").length'
Check '画布上多了一条连接线' ($lineN2 -eq 2) "n=$lineN2"
$panel = Num 'document.querySelectorAll("[data-dd-board-link-row]").length'
Check '连接面板列出两条' ($panel -eq 2) "n=$panel"
Shot 'board-links-1440'

Write-Host 'G2. 关掉重开：块、顺序、连接都还在'
$orderBefore = Eval '[...document.querySelectorAll("[data-dd-board-block]")].map((e) => e.dataset.ddBoardBlock).join(",")'
[void](Eval '(() => { const b = [...document.querySelectorAll("button[aria-label]")].find((x) => (x.getAttribute("aria-label") || "").startsWith("关闭 项目.board")); if (!b) return false; b.click(); return true })()')
Start-Sleep -Milliseconds 700
Check '白板标签关掉了' ((Num 'document.querySelectorAll("[data-dd-board-scroll]").length') -eq 0) ''
[void](ClickText '项目.board')
Start-Sleep -Milliseconds 1500
$orderAfter = Eval '[...document.querySelectorAll("[data-dd-board-block]")].map((e) => e.dataset.ddBoardBlock).join(",")'
Check '重开后块的顺序一模一样' ($orderAfter -eq $orderBefore) "before=$orderBefore after=$orderAfter"
$linesAfter = Num 'document.querySelectorAll("[data-dd-board-links] path").length'
Check '重开后连接线也回来了' ($linesAfter -eq 2) "n=$linesAfter"
$textAfter = Eval 'document.querySelector("[data-dd-board-scroll]")?.innerText ?? ""'
Check '重开后正文就是改过的那份' ([bool]("$textAfter" -match '\（已改\）')) ''

Write-Host 'H. 保存失败：状态必须是失败，重试能成功'
$boardPath = '白板/项目.board'
[void](Eval "window.__failWrite = '$boardPath'; 'ok'")
[void](Eval '(() => { const el = document.querySelector("[data-dd-board-block=n2] .dd-board-input"); if (!el) return false; el.focus(); const s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); s.addRange(r); return true })()')
[void](Send-Cdp 'Input.insertText' @{ text = '失败测试' })
Start-Sleep -Milliseconds 1400
$errStatus = Eval 'document.querySelector("header span[aria-live]")?.textContent ?? ""'
Check '写盘失败时状态是「保存失败」' ($errStatus -eq '保存失败') "status=$errStatus"
$errBar = Num 'document.querySelectorAll("[role=alert]").length'
Check '出现错误条（带重试）' ($errBar -ge 1) "n=$errBar"
Shot 'board-save-error'
[void](Eval "window.__failWrite = null; 'ok'")
[void](Eval '(() => { const b = [...document.querySelectorAll("[role=alert] button")].find((x) => (x.textContent||"").includes("重试")); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 900
$status3 = Eval 'document.querySelector("header span[aria-live]")?.textContent ?? ""'
Check '重试后真的保存成功' ($status3 -eq '已保存') "status=$status3"
$savedText = Eval 'window.__files["白板/项目.board"].text'
Check '重试把改动写进去了' ([bool]("$savedText" -match '失败测试')) ''

Write-Host 'I. 改名：文件搬家 + 标签跟着换 + 内容还在'
Check '右键白板行' (RightClickRow '项目.board') ''
Start-Sleep -Milliseconds 300
Check '菜单里有重命名' (MenuItem '重命名') ''
Start-Sleep -Milliseconds 300
[void](Eval '(() => { const el = document.querySelector("[data-dd-files] input"); if (!el) return false; el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); return true })()')
[void](Eval '(() => { const el = document.querySelector("[data-dd-files] input"); if (!el) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; setter.call(el, "项目白板"); el.dispatchEvent(new Event("input", { bubbles: true })); return true })()')
Start-Sleep -Milliseconds 200
Key 'Enter' 'Enter' 13
Start-Sleep -Milliseconds 1200
$renamed = Eval 'Object.keys(window.__files).filter((p) => p.endsWith(".board")).join(",")'
Check '磁盘上换成新文件名' ($renamed -eq '白板/项目白板.board') "files=$renamed"
$gone = Eval '!("白板/项目.board" in window.__files)'
Check '旧文件没了' ([bool]$gone) ''
$tabText = Eval '[...document.querySelectorAll("header button[title]")].map((b) => b.getAttribute("title")).join("|")'
Check '标签页指向新路径' ([bool]("$tabText" -match '项目白板.board')) "tabs=$tabText"
$stillOpen = Num 'document.querySelectorAll("[data-dd-board-scroll]").length'
Check '白板还开着（没有因为改名关掉）' ($stillOpen -eq 1) "n=$stillOpen"
Start-Sleep -Milliseconds 1100
$titleInFile = Eval 'JSON.parse(window.__files["白板/项目白板.board"].text).title'
Check '文件里的标题跟着改名走了' ($titleInFile -eq '项目白板') "title=$titleInFile"
$titleBox = Eval 'document.querySelector("input[aria-label=白板标题]")?.value ?? ""'
Check '编辑器里的标题也换了' ($titleBox -eq '项目白板') "value=$titleBox"

Write-Host 'J. .note 的引用块：按 id 认，改名后仍然指向它'
Check '点开周会' (ClickText '周会') ''
Start-Sleep -Milliseconds 1600
$refText = Eval 'document.querySelector("[data-dd-flow-scroll]")?.innerText.replace(/\n+/g, " / ") ?? ""'
Check '引用块显示的是新名字（按 boardId 认出来的）' ([bool]("$refText" -match '项目白板')) "text=$refText"
Check '没有出现「白板找不到」' (-not [bool]("$refText" -match '白板找不到')) "text=$refText"
Shot 'note-boardref-1440'

Write-Host 'K. 从引用块打开 → 编辑 → 回笔记看到最新'
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "打开"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 1400
Check '引用块的「打开」进到了白板' ((Num 'document.querySelectorAll("[data-dd-board-scroll]").length') -ge 1) ''
[void](Eval '(() => { const el = document.querySelector("[data-dd-board-block=n2] .dd-board-input"); if (!el) return false; el.focus(); const s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); s.addRange(r); return true })()')
[void](Send-Cdp 'Input.insertText' @{ text = '（引用后改的）' })
Start-Sleep -Milliseconds 1100
[void](ClickText '周会')
Start-Sleep -Milliseconds 1600
$refText2 = Eval 'document.querySelector("[data-dd-flow-scroll]")?.innerText ?? ""'
Check '从笔记再看已是同一份最新数据' ([bool]("$refText2" -match '引用后改的')) ''

Write-Host 'L. 删除白板前：说清楚谁引用了它'
Write-Host ("  [diag] errs=" + (Eval 'window.__errs.join(" | ")'))
Write-Host ("  [diag] body=" + (Eval 'document.body.innerText.replace(/\n+/g, " / ").slice(0, 200)'))
Check '右键白板行（删除）' (RightClickRow '项目白板') ''
Start-Sleep -Milliseconds 300
Check '点删除' (MenuItem '删除') ''
Start-Sleep -Milliseconds 1400
$dlgText = Eval 'document.querySelector("[role=dialog][aria-label=删除白板]")?.innerText.replace(/\n+/g, " / ") ?? ""'
Check '确认框里列出引用' ([bool]("$dlgText" -match '有 1 篇笔记引用了它')) "text=$dlgText"
Check '确认框里没有「没有笔记引用」' (-not [bool]("$dlgText" -match '没有笔记引用')) ''
Shot 'board-delete-dialog'
[void](Eval '(() => { const b = [...document.querySelectorAll("[role=dialog] button")].find((x) => (x.textContent||"").trim() === "先不删"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 300
Check '取消后文件还在' ((Eval '"白板/项目白板.board" in window.__files') -eq $true) ''

Write-Host 'M. 删掉引用块 ≠ 删掉白板'
[void](ClickText '周会')
Start-Sleep -Milliseconds 1200
[void](Eval '(() => { const b = document.querySelector("button[aria-label=\"块 b2 的菜单\"]"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 300
Check '引用块菜单里有删除' (MenuItem '删除这个块') ''
Start-Sleep -Milliseconds 800
$refGone = Eval 'document.querySelectorAll("[data-block-id=b2]").length'
Check '笔记里引用块没了' ($refGone -eq 0) "n=$refGone"
Check '白板文件还在' ((Eval '"白板/项目白板.board" in window.__files') -eq $true) ''

Write-Host 'N. 删除白板：确认后文件真的消失'
[void](RightClickRow '项目白板')
Start-Sleep -Milliseconds 300
[void](MenuItem '删除')
Start-Sleep -Milliseconds 1400
$dlgText2 = Eval 'document.querySelector("[role=dialog][aria-label=删除白板]")?.innerText.replace(/\n+/g, " / ") ?? ""'
Check '没有引用时如实说没引用' ([bool]("$dlgText2" -match '没有笔记引用它')) "text=$dlgText2"
[void](Eval '(() => { const b = [...document.querySelectorAll("[role=dialog] button")].find((x) => (x.textContent||"").trim() === "删除白板"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 900
Check '磁盘上删掉了' ((Eval '"白板/项目白板.board" in window.__files') -eq $false) ''
$treeAfter = Eval '[...document.querySelectorAll("[data-dd-files] button")].map((b) => b.textContent.trim()).join("|")'
Check '树里也没有了' (-not [bool]("$treeAfter" -match '项目白板')) "tree=$treeAfter"
Check '笔记没被连累' ((Eval '"笔记/周会.note/meta.json" in window.__files') -eq $true) ''

Write-Host 'O. 新建白板'
[void](RightClickRow '白板')
Start-Sleep -Milliseconds 300
Check '文件夹菜单里有「新建白板（.board）」' (MenuItem '新建白板（.board）') ''
Start-Sleep -Milliseconds 900
# 新建后自动进入改名状态：先给它起个名字
[void](Eval '(() => { const el = document.querySelector("[data-dd-files] input"); if (!el) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; setter.call(el, "空板"); el.dispatchEvent(new Event("input", { bubbles: true })); return true })()')
Start-Sleep -Milliseconds 200
Key 'Enter' 'Enter' 13
Start-Sleep -Milliseconds 900
$newFiles = Eval 'Object.keys(window.__files).filter((p) => p.endsWith(".board")).join(",")'
Check '磁盘上建出了 空板.board' ($newFiles -eq '白板/空板.board') "files=$newFiles"
$newTree = Eval '[...document.querySelectorAll("[data-dd-files] button")].map((b) => b.textContent.trim()).join("|")'
Check '树里出现 空板.board' ([bool]("$newTree" -match '空板.board')) "tree=$newTree"
Check '新建的白板直接打开了编辑器' ((Num 'document.querySelectorAll("[data-dd-board-scroll]").length') -ge 1) ''
$empty = Eval 'document.querySelector("[data-dd-board-scroll]")?.innerText.includes("这块白板还是空的") ?? false'
Check '空白白板有明确提示' ([bool]$empty) ''

Write-Host 'P. PDF 图标：树 / 标签页 / 右栏'
Check '点开 PDF' (ClickText '文档.pdf') ''
Start-Sleep -Milliseconds 2200
$tabPdf = Num 'document.querySelectorAll("header [data-icon=pdf]").length'
Check '标签页里有 PDF 图标' ($tabPdf -ge 1) "n=$tabPdf"
$asidePdf = Num 'document.querySelectorAll("aside[aria-label=文件信息] [data-icon=pdf]").length'
Check '右栏文件信息里也有' ($asidePdf -ge 1) "n=$asidePdf"
$iconBox = Eval '(() => { const s = document.querySelector("aside[aria-label=文件信息] [data-icon=pdf]"); if (!s) return ""; const r = s.getBoundingClientRect(); return Math.round(r.width) + "x" + Math.round(r.height) })()'
Check '右栏图标 20×20（和别的文件类型一致）' ($iconBox -eq '20x20') "box=$iconBox"
Shot 'pdf-icon-fixed'

Write-Host 'R. 笔记里「新建白板并引用」'
[void](ClickText '周会')
Start-Sleep -Milliseconds 1400
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "添加块"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 400
Check '菜单里有「新建白板并引用」' (MenuItem '新建白板并引用') ''
Start-Sleep -Milliseconds 1400
$madeBoard = Eval 'Object.keys(window.__files).filter((p) => p.endsWith(".board")).join(",")'
Check '笔记旁边新建了一块白板' ([bool]("$madeBoard" -match '笔记/未命名.board')) "files=$madeBoard"
$refJson = Eval '(() => { const keys = Object.keys(window.__files).filter((p) => p.startsWith("笔记/周会.note/blocks/")); for (const k of keys) { try { const b = JSON.parse(window.__files[k].text); if (b.type === "boardref") return JSON.stringify({ path: b.path, boardId: b.boardId, file: k }) } catch {} } return "" })()'
Check '引用块写进了块文件' ([bool]$refJson) "ref=$refJson"
Check '没有被拽到空白板上（还停在笔记里）' (((Num 'document.querySelectorAll("[data-dd-flow-scroll]").length') -eq 1) -and ((Num 'document.querySelectorAll("[data-dd-board-scroll]").length') -eq 0)) ''
Shot 'note-new-board-ref'

Write-Host 'S. 引用失效 → 白板找不到 → 重新定位'
$ref = $refJson | ConvertFrom-Json
# 从界面上把被引用的那块白板删掉：这会同时更新索引，笔记里的引用必须立刻变"找不到"
[void](RightClickRow '未命名.board')
Start-Sleep -Milliseconds 300
[void](MenuItem '删除')
Start-Sleep -Milliseconds 1400
$dlgText3 = Eval 'document.querySelector("[role=dialog][aria-label=删除白板]")?.innerText.replace(/\n+/g, " / ") ?? ""'
Check '删被引用的白板时明确提示影响面' ([bool]("$dlgText3" -match '有 1 篇笔记引用了它')) "text=$dlgText3"
[void](Eval '(() => { const b = [...document.querySelectorAll("[role=dialog] button")].find((x) => (x.textContent||"").trim() === "删除白板"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 800
Check '被引用的白板真的删掉了' ((Eval "('$($ref.path)' in window.__files) ") -eq $false) ''
[void](ClickText '文档.pdf')
Start-Sleep -Milliseconds 900
[void](ClickText '周会')
Start-Sleep -Milliseconds 1600
$lostText = Eval 'document.querySelector("[data-dd-flow-scroll]")?.innerText ?? ""'
Check '失效时明说「白板找不到」' ([bool]("$lostText" -match '白板找不到')) "text=$lostText"
Check '没有偷偷显示旧内容' (-not [bool]("$lostText" -match '这块白板还是空的')) ''
[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "重新定位"); if (b) b.click(); return true })()')
Start-Sleep -Milliseconds 500
$pick = Num 'document.querySelectorAll("[role=dialog][aria-label=重新定位白板引用]").length'
Check '打开重新定位选择器' ($pick -eq 1) "n=$pick"
[void](Eval '(() => { const d = document.querySelector("[role=dialog][aria-label=重新定位白板引用]"); if (!d) return false; const b = [...d.querySelectorAll("button")].find((x) => (x.textContent || "").includes("空板")); if (!b) return false; b.click(); return true })()')
Start-Sleep -Milliseconds 1000
$refJson2 = Eval '(() => { const keys = Object.keys(window.__files).filter((p) => p.startsWith("笔记/周会.note/blocks/")); for (const k of keys) { try { const b = JSON.parse(window.__files[k].text); if (b.type === "boardref") return JSON.stringify({ path: b.path, boardId: b.boardId }) } catch {} } return "" })()'
Check '重新定位把引用指到了新白板' ([bool]("$refJson2" -match '空板.board')) "ref=$refJson2"
$fixedText = Eval 'document.querySelector("[data-dd-flow-scroll]")?.innerText ?? ""'
Check '卡片不再显示找不到' (-not [bool]("$fixedText" -match '白板找不到')) ''

Write-Host 'T. 同一文件重复打开：复用已有标签'
[void](RightClickRow '空板.board')
Start-Sleep -Milliseconds 300
Check '菜单里有「在新标签页打开」' (MenuItem '在新标签页打开') ''
Start-Sleep -Milliseconds 900
$tabN = Num '[...document.querySelectorAll("header button[title]")].filter((b) => (b.getAttribute("title") || "").endsWith("空板.board")).length'
Check '打开一次只有一个标签' ($tabN -eq 1) "n=$tabN"
[void](RightClickRow '空板.board')
Start-Sleep -Milliseconds 300
[void](MenuItem '在新标签页打开')
Start-Sleep -Milliseconds 700
$tabN2 = Num '[...document.querySelectorAll("header button[title]")].filter((b) => (b.getAttribute("title") || "").endsWith("空板.board")).length'
Check '再打开一次还是那个标签（不重复）' ($tabN2 -eq 1) "n=$tabN2"

Write-Host 'T2. 右侧分栏：白板在第二栏也能编辑'
[void](RightClickRow '空板.board')
Start-Sleep -Milliseconds 300
Check '菜单里有「在右侧分栏打开」' (MenuItem '在右侧分栏打开') ''
Start-Sleep -Milliseconds 1200
$panes = Num 'document.querySelectorAll("main").length'
Check '分成两栏' ($panes -eq 2) "panes=$panes"
$boardPanes = Num 'document.querySelectorAll("[data-dd-board-scroll]").length'
Check '两栏里都能看到白板' ($boardPanes -ge 1) "n=$boardPanes"
[void](Eval '(() => { const bs = [...document.querySelectorAll("button[aria-label=关掉这一栏]")]; if (bs.length) bs[bs.length - 1].click(); return true })()')
Start-Sleep -Milliseconds 700
$panes2 = Num 'document.querySelectorAll("main").length'
Check '关掉右栏后回到一栏' ($panes2 -eq 1) "panes=$panes2"

Write-Host 'U. 移动到另一个文件夹'
[void](RightClickRow '空板.board')
Start-Sleep -Milliseconds 300
Check '菜单里有「移动到…」' (MenuItem '移动到…') ''
Start-Sleep -Milliseconds 400
$moveDlg = Num 'document.querySelectorAll("[role=dialog][aria-label=移动到]").length'
Check '打开移动对话框' ($moveDlg -eq 1) "n=$moveDlg"
[void](Eval '(() => { const d = document.querySelector("[role=dialog][aria-label=移动到]"); if (!d) return false; const b = [...d.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "素材"); if (!b) return false; b.click(); return true })()')
Start-Sleep -Milliseconds 1200
$moved = Eval 'Object.keys(window.__files).filter((p) => p.endsWith(".board")).join(",")'
Check '白板搬到了 素材/ 下' ([bool]("$moved" -match '素材/空板.board')) "files=$moved"
Check '标签页也跟过去了' ([bool](Eval '[...document.querySelectorAll("header button[title]")].some((b) => (b.getAttribute("title") || "").endsWith("素材/空板.board"))')) ''

Write-Host 'V. 窄窗口：白板不横向溢出'
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1024; height = 768; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 700
$overflow = Eval 'document.documentElement.scrollWidth - document.documentElement.clientWidth'
Check '1024 宽没有横向溢出' ($overflow -le 0) "overflow=$overflow"
$stillThere = Num 'document.querySelectorAll("[data-dd-board-scroll]").length'
Check '白板还在（没有被挤没）' ($stillThere -ge 1) "n=$stillThere"
Shot 'board-1024'
[void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1440; height = 900; deviceScaleFactor = 1; mobile = $false })
Start-Sleep -Milliseconds 500

Write-Host 'Q. 没有运行时报错'
$errs = Eval 'window.__errs.join(" | ")'
Check '控制台没有未捕获错误' (-not [bool]$errs) "errs=$errs"

Write-Host ''
Write-Host "通过 $script:pass / $($script:pass + $script:fail)"
if ($script:fail -gt 0) { Write-Host "失败 $script:fail"; exit 1 }

$ws.Dispose()
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
