. (Join-Path $PSScriptRoot 'common.ps1')

$port = Get-CortexPort
try {
  $result = Invoke-RestMethod -Uri "http://127.0.0.1:$port/readyz" -TimeoutSec 3
  if ($result.status -eq 'ready') {
    Write-Host "Cortex esta pronto. Painel: http://127.0.0.1:$port/dashboard/" -ForegroundColor Green
    exit 0
  }
} catch {
  Write-Host 'Cortex esta parado ou ainda nao ficou pronto.' -ForegroundColor Yellow
  exit 1
}
