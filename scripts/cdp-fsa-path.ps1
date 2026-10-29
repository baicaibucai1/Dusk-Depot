# 用假目录句柄模拟"选文件夹"：验证 pickRepo → adopt → 进编辑器这条路径本身是否通。
# 这只证明应用逻辑，不证明系统选择器。
param([string]$Url = 'http://localhost:5183/')
$url = $Url
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path $env:TEMP ('ddfsa-' + [guid]::NewGuid().ToString('N'))
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

Start-Sleep -Milliseconds 1000
[void](Send-Cdp 'Runtime.enable' @{})
[void](Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true })

# 假目录：两个 md + 一个子目录。接口齐到 fsaHost 用得上的程度。
$STUB = @'
(() => {
  window.__log = [];
  const files = {
    '开始这里.md': '# 开始这里\n\n用假句柄测 FSA 路径。\n\n- [x] 能进编辑器\n- [ ] 能保存\n',
    '语法.md': '# 语法\n\n**粗体**、`码`\n',
    '项目/周计划.md': '# 周计划\n\n- [ ] 一件小事\n',
  };
  const dirs = new Set(['项目']);
  const enc = new TextEncoder();
  function walk() {
    const top = new Map();
    for (const [p] of Object.entries(files)) {
      const [d, n] = p.includes('/') ? [p.split('/')[0], p.split('/')[1]] : ['', p];
      if (!top.has(d)) top.set(d, []);
      top.get(d).push(n);
    }
    return top;
  }
  function mk(path) {
    const top = walk();
    const name = path.split('/').pop() || '库';
    const h = { kind: 'directory', name };
    const def = (k, v) => Object.defineProperty(h, k, { value: v, enumerable: false });
    def('values', async function* () {
      const kids = top.get(path) || [];
      for (const n of kids) {
        const isDir = dirs.has(path ? path + '/' + n : n);
        yield { name: n, kind: isDir ? 'directory' : 'file' };
      }
    });
    def('getDirectoryHandle', async (n) => mk(path ? path + '/' + n : n));
    def('getFileHandle', async (n) => {
      const full = path ? path + '/' + n : n;
      if (!(full in files)) throw new DOMException('not found', 'NotFoundError');
      return {
        async getFile() { return new File([enc.encode(files[full])], n) },
        async createWritable() {
          let buf = '';
          return {
            async write(d) { buf += d instanceof Blob ? await d.text() : String(d) },
            async close() { files[full] = buf; window.__log.push('write:' + full) },
          };
        },
      };
    });
    def('removeEntry', async () => { window.__log.push('remove') });
    def('queryPermission', async () => 'granted');
    def('requestPermission', async () => 'granted');
    return h;
  }
  window.showDirectoryPicker = async () => { window.__log.push('picker'); return mk('') };
})();
'@
[void](Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = $STUB })
[void](Send-Cdp 'Page.navigate' @{ url = $url })
Start-Sleep -Milliseconds 3500
# headless 下 addScriptToEvaluateOnNewDocument 不生效，页面加载后直接装（应用在点击时才读 showDirectoryPicker）
[void](Eval $STUB)
Write-Host "stub 状态: log=$((Eval 'Array.isArray(window.__log)')) picker=$((Eval 'String(window.showDirectoryPicker).slice(0, 30)'))"

Check '首页在选择仓库界面' ([bool](Eval 'document.body.innerText.includes("选一个文件夹当仓库")')) ''
[void](Eval '[...document.querySelectorAll("button")].find((b) => b.textContent.includes("选择文件夹")).click()')
Start-Sleep -Milliseconds 2000

$body = Eval 'document.body.innerText.slice(0, 400).replace(/\n/g, " / ")'
Write-Host "界面: $body"
Check '点选择文件夹后进入了编辑器' ([int](Eval 'document.querySelectorAll(".cm-editor").length') -eq 1) "cm=$(Eval 'document.querySelectorAll(".cm-editor").length')"
Check '树里是假目录的两篇 + 子目录' ([int](Eval 'document.querySelectorAll("[data-dd-files] button").length') -ge 2) "rows=$(Eval 'document.querySelectorAll("[data-dd-files] button").length')"
Check '篇数 = 2（假目录根下只有两篇）' ((Eval 'document.querySelector("[data-dd-files] .font-mono").textContent.trim()') -eq '2 篇') "got=$(Eval 'document.querySelector("[data-dd-files] .font-mono").textContent.trim()')"
Check '没有停留在仓库选择页' ([bool](Eval '!document.body.innerText.includes("选一个文件夹当仓库")')) ''
$stage = Eval 'window.__log.join(",")'
Write-Host "stub log: $stage"

Write-Host ''
if ($script:fail -eq 0) { Write-Host 'fsa-path: 应用侧这条路径是通的' } else { Write-Host "fsa-path: $script:fail 条没过"; exit 1 }
