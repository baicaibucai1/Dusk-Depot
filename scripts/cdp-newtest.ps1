# 用 new test 文件夹里的真实内容，验证：树/篇数/相对链接跳转/任务勾选
param([string]$Url = 'http://localhost:5183/')
$ErrorActionPreference = 'Stop'
$root = 'C:\AI_Production\测试\new test'

# 把磁盘上的真文件读成 JSON，塞给假句柄
$map = [ordered]@{}
Get-ChildItem $root -Recurse -File | Where-Object { $_.Name -ne '.zzq' } | ForEach-Object {
  $rel = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
  $map[$rel] = [IO.File]::ReadAllText($_.FullName, [Text.Encoding]::UTF8)
}
$json = ($map | ConvertTo-Json -Compress)

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddnt-' + [guid]::NewGuid().ToString('N'))
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
  if ($r.result.exceptionDetails) { return 'EXC: ' + $r.result.exceptionDetails.exception.description }
  return $r.result.result.value
}
$fail = 0
function Check([string]$name, $ok, [string]$detail) {
  if ($ok) { Write-Host "  ok  $name" }
  else { Write-Host "FAIL  $name  $detail"; $script:fail++ }
}

$STUB = @'
(() => {
  window.__files = __JSON__;
  const enc = new TextEncoder();
  function split(p) { return p.split('/').filter(Boolean) }
  function kids(path) {
    const dirs = new Map(); const files = new Map();
    const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v) };
    for (const p of Object.keys(window.__files)) {
      const segs = split(p);
      const dir = segs.slice(0, -1).join('/');
      push(files, dir, segs[segs.length - 1]);
      let cur = '';
      for (let i = 0; i < segs.length - 1; i++) {
        cur = cur ? cur + '/' + segs[i] : segs[i];
        push(dirs, dir === '' ? '' : segs.slice(0, i).join('/'), segs[i]);
        if (i === segs.length - 2) dirs.set(dir, dirs.get(dir) || []);
      }
    }
    return { dirs: ds(path), files: files.get(path) || [] };
  }
  function ds(path) {
    const out = new Set();
    for (const p of Object.keys(window.__files)) {
      const segs = split(p);
      let cur = '';
      for (let i = 0; i < segs.length - 1; i++) {
        cur = cur ? cur + '/' + segs[i] : segs[i];
        const parent = segs.slice(0, i).join('/');
        if (parent === path) out.add(segs[i]);
      }
    }
    return [...out];
  }
  function mk(path) {
    const name = path.split('/').pop() || 'new test';
    const h = { kind: 'directory', name };
    const def = (k, v) => Object.defineProperty(h, k, { value: v, enumerable: false });
    def('values', async function* () {
      const k = kids(path);
      for (const d of k.dirs) yield { name: d, kind: 'directory' };
      for (const f of k.files) yield { name: f, kind: 'file' };
    });
    def('getDirectoryHandle', async (n) => mk(path ? path + '/' + n : n));
    def('getFileHandle', async (n) => {
      const full = path ? path + '/' + n : n;
      if (!(full in window.__files)) throw new DOMException('no', 'NotFoundError');
      return {
        async getFile() { return new File([enc.encode(window.__files[full])], n) },
        async createWritable() {
          let buf = '';
          return {
            async write(d) { buf += d instanceof Blob ? await d.text() : String(d) },
            async close() { window.__files[full] = buf },
          };
        },
      };
    });
    def('removeEntry', async () => {});
    def('queryPermission', async () => 'granted');
    def('requestPermission', async () => 'granted');
    return h;
  }
  window.showDirectoryPicker = async () => mk('');
})();
'@ -replace '__JSON__', $json

Start-Sleep -Milliseconds 1200
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })
[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 3500
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error)))')
[void](Eval $STUB)
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("选择文件夹")).click()')
Start-Sleep -Milliseconds 2500

Write-Host "首页 → 选文件夹后：$((Eval 'document.body.innerText.slice(0, 60).replace(/\n/g, " / ")'))"
Check '进入编辑器' ([int](Eval 'document.querySelectorAll(".cm-editor").length') -eq 1) ''
Check '篇数 = 7' ((Eval 'document.querySelector("[data-dd-files] .font-mono").textContent.trim()') -eq '7 篇') "got=$(Eval 'document.querySelector("[data-dd-files] .font-mono").textContent.trim()')"
Check '三个文件夹都在树上' ([int](Eval '[...document.querySelectorAll("[data-dd-files] .row, [data-dd-files] button")].filter((b) => /^(项目|素材|日记)$/.test(b.textContent.trim())).length') -ge 3) ""

# 打开 日记/2026-10-29.md，切阅读模式，双击 ../开始这里.md
[void](Eval '(() => { const all = [...document.querySelectorAll("[data-dd-files] button")]; const f = all.find((b) => b.textContent.trim() === "2026-10-29.md"); if (f) f.click(); return 1 })()')
Start-Sleep -Milliseconds 700
Check '打开日记篇' ((Eval 'document.querySelector("[data-active-path]").getAttribute("data-active-path")') -eq '日记/2026-10-29.md') "got=$(Eval 'document.querySelector("[data-active-path]").getAttribute("data-active-path")')"

[void](Eval '(() => { const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "阅读"); if (b) b.click(); return 1 })()')
Start-Sleep -Milliseconds 800
$linkText = Eval '(() => { const a = [...document.querySelectorAll("[data-dd-doc] a")].find((x) => x.textContent.includes("开始这里")); return a ? a.textContent.trim() : "none" })()'
Write-Host "找到链接: $linkText"
[void](Eval '(() => { const a = [...document.querySelectorAll("[data-dd-doc] a")].find((x) => x.textContent.includes("开始这里")); if (!a) return "no"; a.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); return "ok" })()')
Start-Sleep -Milliseconds 800
Check '双击 ../开始这里.md 跳转成功' ((Eval 'document.querySelector("[data-active-path]").getAttribute("data-active-path")') -eq '开始这里.md') "got=$(Eval 'document.querySelector("[data-active-path]").getAttribute("data-active-path")')"

$errs = Eval 'window.__errs.length'
Check '没有 JS 报错' ("$errs" -eq '0') "errs=$errs $(Eval 'window.__errs.join(" | ")')"

Write-Host ''
if ($script:fail -eq 0) { Write-Host 'new-test: 全部通过' } else { Write-Host "new-test: $script:fail 条没过"; exit 1 }
