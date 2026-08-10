. (Join-Path $PSScriptRoot 'common.ps1')

Initialize-CortexDirectories
New-CortexEnvironment
Set-Location $script:RepositoryRoot

$existingMode = Get-CortexMode
if ($existingMode -eq 'docker') {
  if (-not (Test-DockerReady)) { throw 'Esta instalacao usa Docker, mas o Docker Desktop nao esta em execucao.' }
  $installMode = 'docker'
} elseif ($existingMode -eq 'native') {
  $installMode = 'native'
} elseif (Test-DockerReady) {
  $installMode = 'docker'
} else {
  $installMode = 'native'
}

if ($installMode -eq 'docker') {
  Write-Host 'Instalando com Docker Desktop...'
  & docker compose up -d --build
  if ($LASTEXITCODE -ne 0) { throw 'docker compose falhou.' }
  'docker' | Set-Content -Path $script:ModeFile -Encoding Ascii
} else {
  Write-Host 'Docker indisponivel; instalando no modo Node.js local...'
  Assert-NodeReady
  if ($existingMode -eq 'native') { & (Join-Path $PSScriptRoot 'stop.ps1') }
  & npm.cmd ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'npm ci falhou.' }
  & npm.cmd run check
  if ($LASTEXITCODE -ne 0) { throw 'A verificacao do projeto falhou.' }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'O build do projeto falhou.' }
  'native' | Set-Content -Path $script:ModeFile -Encoding Ascii
  & (Join-Path $PSScriptRoot 'start.ps1') -SkipHealthCheck
}

$healthUrl = Wait-CortexHealthy
Write-Host "Cortex instalado e funcionando: $healthUrl" -ForegroundColor Green
Start-Process "http://127.0.0.1:$(Get-CortexPort)/dashboard/"
