$ErrorActionPreference = 'Stop'
$bt = [char]96   # `
$root = 'C:\AI_Production\测试'
$out = 'C:\AI_Production\Dusk Depot\src\ui\demo.ts'

# 根目录所有示例 .md 都进种子
$mdFiles = @{}
Get-ChildItem $root -File -Filter '*.md' | ForEach-Object { $mdFiles[$_.Name] = (Get-Content $_.FullName -Raw) }
$welcome = $mdFiles['开始这里.md']

$noteDir = Join-Path $root '示例-块笔记.note'
$entries = [ordered]@{}
Get-ChildItem $noteDir -Recurse -File | ForEach-Object {
  $rel = '示例-块笔记.note/' + $_.FullName.Substring((Resolve-Path $noteDir).Path.Length + 1).Replace('\', '/')
  $entries[$rel] = (Get-Content $_.FullName -Raw)
}

function Esc-Template([string]$s) {
  # JS 模板字符串里要转义：反斜杠、反引号、${
  $s2 = $s.Replace([string]'\', [string]'\\')
  $s2 = $s2.Replace([string]$bt, '\' + $bt)
  return $s2.Replace('${', '\${')
}

$demoImg = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root '附件\示例图.png')))

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('/*')
$lines.Add(' * 出厂示例：两篇 + 一张图。')
$lines.Add(' *')
$lines.Add(' * ⚠️ 这是"没有仓库"时用的内存种子（?vault=memory），跟真实仓库里的示例保持同一份内容。')
$lines.Add(' */')
$lines.Add("import type { FileMap } from '../core/model/library'")
$lines.Add('')
$lines.Add('export const CURRENT = ''开始这里.md''')
$lines.Add('')
$lines.Add('export const SEED: FileMap = {')
foreach ($name in ($mdFiles.Keys | Sort-Object)) {
  $key = if ($name -eq '开始这里.md') { '开始这里.md' } else { $name }
  $lines.Add("  '$key': $bt" + (Esc-Template $mdFiles[$name]) + "$bt,")
}
foreach ($k in $entries.Keys) {
  $lines.Add("  '$k': $bt" + (Esc-Template $entries[$k]) + "$bt,")
}
$lines.Add("  '附件/示例图.png': '" + [char]0 + "b64:$demoImg',")
$lines.Add('}')
$lines.Add('')

Set-Content -Path $out -Value ($lines -join "`n") -NoNewline -Encoding utf8
Write-Output 'seed ok'
