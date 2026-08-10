param([switch]$SkipHealthCheck)

. (Join-Path $PSScriptRoot 'common.ps1')

Initialize-CortexDirectories
New-CortexEnvironment
$mode = Get-CortexMode
Set-Location $script:RepositoryRoot

if ($mode -eq 'docker') {
  if (-not (Test-DockerReady)) { throw 'Docker Desktop nao esta em execucao.' }
  & docker compose up -d
  if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel iniciar o container.' }
} elseif ($mode -eq 'native') {
  Assert-NodeReady
  if (-not (Test-Path (Join-Path $script:RepositoryRoot 'dist\server.js'))) {
    throw 'Build ausente. Execute INSTALAR-NO-WINDOWS.cmd novamente.'
  }
  if (Test-Path $script:PidFile) {
    $oldPid = [int](Get-Content $script:PidFile -Raw)
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction SilentlyContinue
    if ($processInfo -and $processInfo.CommandLine -match 'dist[\\/]server\.js') {
      Write-Host "Cortex ja esta em execucao (PID $oldPid)."
      if (-not $SkipHealthCheck) { Wait-CortexHealthy | Out-Null }
      return
    } elseif ($processInfo) {
      throw "O PID $oldPid pertence a outro programa; nada foi iniciado."
    }
    Remove-Item $script:PidFile -Force
  }

  $stdout = Join-Path $script:RuntimeDirectory 'cortex.log'
  $stderr = Join-Path $script:RuntimeDirectory 'cortex-error.log'
  $process = Start-Process -FilePath 'node' `
    -ArgumentList @('--env-file=.env', 'dist/server.js') `
    -WorkingDirectory $script:RepositoryRoot `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru
  $process.Id | Set-Content -Path $script:PidFile -Encoding Ascii
} else {
  throw 'Instalacao nao encontrada. Execute INSTALAR-NO-WINDOWS.cmd.'
}

if (-not $SkipHealthCheck) {
  Wait-CortexHealthy | Out-Null
  Write-Host "Cortex iniciado. Painel: http://127.0.0.1:$(Get-CortexPort)/dashboard/" -ForegroundColor Green
}
