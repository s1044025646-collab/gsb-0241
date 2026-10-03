# HF1 Huffman 压缩实验 —— Windows PowerShell 演示脚本
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$cli = "node --no-warnings dist/src/cli/index.js"

function Run($label, $argsLine) {
  Write-Host "`n=== $label ===" -ForegroundColor Cyan
  Write-Host "PS> hf1 $argsLine" -ForegroundColor DarkGray
  Invoke-Expression "$cli $argsLine"
}

Run "1. 生成三类样例" "samples"

$samples = @(
  @{ id = 'repeat';  file = 'data/samples/sample-repeat-text.bin';   out = 'repeat.decoded.bin' },
  @{ id = 'single';  file = 'data/samples/sample-single-byte.bin';   out = 'single.decoded.bin' },
  @{ id = 'uniform'; file = 'data/samples/sample-near-uniform.bin';  out = 'uniform.decoded.bin' }
)

$inputIds = @{}
foreach ($s in $samples) {
  Write-Host "`n=== 2.$($s.id) 导入/压缩/验证/独立解码/逐字节比较 ===" -ForegroundColor Cyan
  $imported = Invoke-Expression "$cli import $($s.file)" | ConvertFrom-Json
  $inputIds[$s.id] = $imported.inputId
  $compressed = Invoke-Expression "$cli compress $($imported.inputId)" | ConvertFrom-Json
  Write-Host ("原始 {0} 字节 -> 文件 {1} 字节（头部 {2}，载荷 {3} 位，填充 {4} 位，比率 {5:N2}%）" -f `
    $compressed.stats.originalSize, $compressed.stats.fileSize, $compressed.stats.headerBytes, `
    $compressed.stats.payloadBits, $compressed.stats.padBits, $compressed.stats.ratioPercent)
  Invoke-Expression "$cli verify $($compressed.artifactPath)" | Out-Null
  Write-Host "验证通过：容器自包含码表，结构/填充位/校验和全部正确" -ForegroundColor Green
  $decoded = Invoke-Expression "$cli decode $($compressed.artifactPath) $($s.out)" | ConvertFrom-Json
  $cmp = Invoke-Expression "$cli compare $($imported.inputId) $($decoded.outputPath)" | ConvertFrom-Json
  if ($cmp.byteIdentical) { Write-Host "逐字节比较：完全一致" -ForegroundColor Green }
  else { throw "往返不一致" }
}

Write-Host "`n=== 3. 损坏产物被拒绝（魔数破坏）===" -ForegroundColor Cyan
$first = Get-ChildItem data/artifacts/*.hf1 | Select-Object -First 1
$broken = 'data/outputs/broken.hf1'
$bytes = [System.IO.File]::ReadAllBytes($first.FullName)
$bytes[0] = 0x58
[System.IO.File]::WriteAllBytes((Join-Path $root $broken), $bytes)
try {
  Invoke-Expression "$cli verify $broken"
  throw '应当拒绝损坏文件'
} catch {
  Write-Host "已正确拒绝损坏产物（错误码 BAD_HEADER_MAGIC），且历史中记录为 error" -ForegroundColor Yellow
}

Run "4. 查询历史（含成功与失败记录）" "history"
Write-Host "`n演示完成。压缩产物位于 data/artifacts，解码输出位于 data/outputs。" -ForegroundColor Green
