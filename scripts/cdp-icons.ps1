# 验文件树图标：文件夹 / md 记号 / 按扩展名分（txt/png/ts/json/zip）
param([string]$Url = 'http://localhost:5184/')
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddicon-' + [guid]::NewGuid().ToString('N'))
$port = Get-Random -Minimum 9400 -Maximum 9800
$proc = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', "--user-data-dir=$profile", "--remote-debugging-port=$port",
  '--window-size=1200,800', 'about:blank'
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
  window.__files = {
    '一篇笔记.md': '# 笔记\n\n正文\n',
    '另一篇.md': '# 另一篇\n',
    '项目/子目录/更深.md': '# 深\n',
  };
  const enc = new TextEncoder();
  function mk(path) {
    const name = path.split('/').pop() || '库';
    const h = { kind: 'directory', name };
    const def = (k, v) => Object.defineProperty(h, k, { value: v, enumerable: false });
    def('values', async function* () {
      for (const p of Object.keys(window.__files)) {
        const segs = p.split('/');
        const dir = segs.slice(0, -1).join('/');
        if (dir !== path) continue;
        yield { name: segs[segs.length - 1], kind: 'file' };
      }
      // 目录：从路径里推
      if (path === '') yield { name: '项目', kind: 'directory' };
    });
    def('getDirectoryHandle', async (n) => mk(path ? path + '/' + n : n));
    def('getFileHandle', async (n) => {
      const full = path ? path + '/' + n : n;
      if (!(full in window.__files)) throw new DOMException('no', 'NotFoundError');
      return {
        async getFile() { return new File([enc.encode(window.__files[full])], n) },
        async createWritable() { return { async write() {}, async close() {} } },
      };
    });
    def('removeEntry', async () => {});
    def('queryPermission', async () => 'granted');
    def('requestPermission', async () => 'granted');
    return h;
  }
  window.showDirectoryPicker = async () => mk('');
})();
'@

Start-Sleep -Milliseconds 1000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })
[void](Send-Cdp 'Page.navigate' @{ url = $Url })
Start-Sleep -Milliseconds 3500
[void](Eval 'window.__errs = []; window.addEventListener("error", (e) => window.__errs.push(String(e.message || e.error)))')
[void](Eval $STUB)
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("选择文件夹")).click()')
Start-Sleep -Milliseconds 2200

$cls = Eval '(() => [...new Set([...document.querySelectorAll("[data-dd-files] svg")].map((s) => s.getAttribute("class") || "own"))].join(" | "))()'
Write-Host "树里的图标 class: $cls"

Check 'md 用项目自己的 M↓ 记号（非 lucide）' ([bool](Eval '[...document.querySelectorAll("[data-dd-files] svg:not(.lucide)")].length > 0')) ''
Check '文件夹用 lucide-folder / folder-open' ([int](Eval 'document.querySelectorAll(".lucide-folder, .lucide-folder-open").length') -ge 1) "n=$(Eval 'document.querySelectorAll(".lucide-folder, .lucide-folder-open").length')"
Check '文件夹展开时是 folder-open' ([int](Eval 'document.querySelectorAll(".lucide-folder-open").length') -ge 1) "n=$(Eval 'document.querySelectorAll(".lucide-folder-open").length')"
Check '文件名字不带后缀' ([bool](Eval '![...document.querySelectorAll("[data-dd-files] button")].some((b) => /\.(md|txt|png|ts|json|zip)$/.test((b.textContent || "").trim())))')) ''

$errs = Eval 'window.__errs.length'
Check '没有 JS 报错' ("$errs" -eq '0') "errs=$errs"

Write-Host ''
if ($script:fail -eq 0) { Write-Host 'icons: 全部通过' } else { Write-Host "icons: $script:fail 条没过"; exit 1 }
