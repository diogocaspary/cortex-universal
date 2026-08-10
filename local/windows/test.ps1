. (Join-Path $PSScriptRoot 'common.ps1')

if (-not (Test-Path $script:EnvironmentFile)) {
  throw 'Arquivo .env ausente. Execute INSTALAR-NO-WINDOWS.cmd.'
}

$tokenLine = Get-Content $script:EnvironmentFile | Where-Object { $_ -match '^CORTEX_API_TOKEN=' } | Select-Object -First 1
if (-not $tokenLine) { throw 'Token local nao encontrado.' }
$token = $tokenLine.Substring('CORTEX_API_TOKEN='.Length)
$headers = @{ Authorization = "Bearer $token" }
$port = Get-CortexPort
$baseUrl = "http://127.0.0.1:$port"

$health = Invoke-RestMethod -Uri "$baseUrl/readyz" -TimeoutSec 5
if ($health.status -ne 'ready') { throw 'O servico nao esta pronto.' }

$manifest = Invoke-RestMethod -Uri "$baseUrl/v1/manifest" -Headers $headers -TimeoutSec 10
$claimPath = Join-Path $script:RepositoryRoot 'examples\valid\claim.json'
$claim = Get-Content $claimPath -Raw
$validation = Invoke-RestMethod `
  -Uri "$baseUrl/v1/validate/json/claim" `
  -Method Post `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $claim `
  -TimeoutSec 10

if (-not $validation.valid) { throw 'O exemplo de claim nao passou na validacao.' }
Write-Host "Cortex $($manifest.version): API, autenticacao e validacao funcionando." -ForegroundColor Green
