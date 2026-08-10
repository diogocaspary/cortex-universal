Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:RuntimeDirectory = Join-Path $script:RepositoryRoot 'runtime'
$script:EnvironmentFile = Join-Path $script:RepositoryRoot '.env'
$script:ModeFile = Join-Path $script:RuntimeDirectory 'mode'
$script:PidFile = Join-Path $script:RuntimeDirectory 'cortex.pid'

function Initialize-CortexDirectories {
  New-Item -ItemType Directory -Force -Path $script:RuntimeDirectory | Out-Null
}

function Get-CortexEnvironmentValue([string]$Name) {
  if (-not (Test-Path $script:EnvironmentFile)) { return '' }
  $prefix = "$Name="
  $line = Get-Content $script:EnvironmentFile | Where-Object { $_.StartsWith($prefix) } | Select-Object -First 1
  if (-not $line) { return '' }
  return $line.Substring($prefix.Length)
}

function Set-CortexEnvironmentValue([string]$Name, [string]$Value) {
  $prefix = "$Name="
  $found = $false
  $lines = if (Test-Path $script:EnvironmentFile) { @(Get-Content $script:EnvironmentFile) } else { @() }
  $updated = @($lines | ForEach-Object {
    if ($_.StartsWith($prefix)) {
      if (-not $found) {
        $found = $true
        "$prefix$Value"
      }
    } else {
      $_
    }
  })
  if (-not $found) { $updated += "$prefix$Value" }
  $updated | Set-Content -Path $script:EnvironmentFile -Encoding Ascii
}

function New-CortexEnvironment {
  [string]$token = Get-CortexEnvironmentValue 'CORTEX_API_TOKEN'
  if ($token.Length -lt 32) {
    $bytes = New-Object byte[] 48
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
      $generator.GetBytes($bytes)
    } finally {
      $generator.Dispose()
    }
    $token = [Convert]::ToBase64String($bytes)
  }

  [string]$auditSecret = Get-CortexEnvironmentValue 'CORTEX_AUDIT_HMAC_SECRET'
  if ($auditSecret.Length -lt 32) {
    $auditBytes = New-Object byte[] 48
    $auditGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
      $auditGenerator.GetBytes($auditBytes)
    } finally {
      $auditGenerator.Dispose()
    }
    $auditSecret = [Convert]::ToBase64String($auditBytes)
  }

  # The one-click install is a loopback-only local profile. Production requires explicit tenants
  # or a signed identity gateway, which cannot be guessed by an installer.
  Set-CortexEnvironmentValue 'NODE_ENV' 'development'
  Set-CortexEnvironmentValue 'HOST' '127.0.0.1'
  if (-not (Get-CortexEnvironmentValue 'PORT')) { Set-CortexEnvironmentValue 'PORT' '8080' }
  Set-CortexEnvironmentValue 'CORTEX_API_TOKEN' $token
  Set-CortexEnvironmentValue 'CORTEX_AUDIT_HMAC_SECRET' $auditSecret
  if (-not (Get-CortexEnvironmentValue 'CORTEX_LOG_LEVEL')) { Set-CortexEnvironmentValue 'CORTEX_LOG_LEVEL' 'info' }
  if (-not (Get-CortexEnvironmentValue 'CORTEX_MAX_BODY_BYTES')) { Set-CortexEnvironmentValue 'CORTEX_MAX_BODY_BYTES' '1000000' }
  if (-not (Get-CortexEnvironmentValue 'CORTEX_MAX_RDF_QUADS')) { Set-CortexEnvironmentValue 'CORTEX_MAX_RDF_QUADS' '10000' }
  if (-not (Get-CortexEnvironmentValue 'CORTEX_RATE_LIMIT_MAX')) { Set-CortexEnvironmentValue 'CORTEX_RATE_LIMIT_MAX' '120' }
}

function Get-CortexPort {
  if (-not (Test-Path $script:EnvironmentFile)) { return 8080 }
  $line = Get-Content $script:EnvironmentFile | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1
  if (-not $line) { return 8080 }
  $value = $line.Substring(5)
  $port = 0
  if (-not [int]::TryParse($value, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw 'O valor PORT no arquivo .env e invalido.'
  }
  return $port
}

function Test-DockerReady {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  & docker info *> $null
  return $LASTEXITCODE -eq 0
}

function Assert-NodeReady {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Instale Docker Desktop ou Node.js 22.13+ antes de continuar.'
  }
  $major = [int](& node -p "Number(process.versions.node.split('.')[0])")
  if ($LASTEXITCODE -ne 0 -or $major -lt 22) {
    throw 'O modo nativo requer Node.js 22 ou superior.'
  }
  & node -e "require('node:sqlite')" 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw 'O modo nativo requer Node.js 22.13+ com node:sqlite.'
  }
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'npm nao foi encontrado junto com o Node.js.'
  }
}

function Wait-CortexHealthy {
  $port = Get-CortexPort
  $url = "http://127.0.0.1:$port/healthz"
  for ($attempt = 1; $attempt -le 45; $attempt++) {
    try {
      $result = Invoke-RestMethod -Uri $url -TimeoutSec 2
      if ($result.status -eq 'ok') { return $url }
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  throw "O Cortex nao respondeu em $url. Consulte os arquivos da pasta runtime."
}

function Get-CortexMode {
  if (Test-Path $script:ModeFile) {
    return (Get-Content $script:ModeFile -Raw).Trim()
  }
  return ''
}
