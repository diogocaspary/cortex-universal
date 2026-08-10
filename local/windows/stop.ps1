. (Join-Path $PSScriptRoot 'common.ps1')

$mode = Get-CortexMode
Set-Location $script:RepositoryRoot

if ($mode -eq 'docker') {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker nao foi encontrado.'
  }
  & docker compose down
  if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel parar o container.' }
} elseif ($mode -eq 'native') {
  if (-not (Test-Path $script:PidFile)) {
    Write-Host 'Cortex ja esta parado.'
    return
  }
  $cortexPid = [int](Get-Content $script:PidFile -Raw)
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $cortexPid" -ErrorAction SilentlyContinue
  if ($processInfo -and $processInfo.CommandLine -match 'dist[\\/]server\.js') {
    Stop-Process -Id $cortexPid
  } elseif ($processInfo) {
    throw "O PID $cortexPid pertence a outro programa; nada foi encerrado."
  }
  Remove-Item $script:PidFile -Force
} else {
  Write-Host 'Instalacao local nao encontrada.'
  return
}

Write-Host 'Cortex parado com seguranca.' -ForegroundColor Green
