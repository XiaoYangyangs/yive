[CmdletBinding()]
param(
  [string]$EnvFile = "$env:USERPROFILE\.config\yive\desktop-relay.env",
  [string]$RepoDir = "",
  [string]$YiveCommand = "pnpm",
  [string]$RuntimePort,
  [string]$RelayServer,
  [string]$RelayToken,
  [string]$DeviceId,
  [string]$RuntimeUrl,
  [string]$LocalRequestTimeoutMs,
  [string]$MobileUrl,
  [string]$StatusFile,
  [int]$RestartDelaySeconds = 3,
  [switch]$ManageRuntime,
  [switch]$SkipRelayCheck,
  [switch]$SkipRuntimeCheck,
  [switch]$Check
)

$ErrorActionPreference = "Stop"

function Import-YiveEnvFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }
    $parts = $trimmed.Split("=", 2)
    if ($parts.Count -ne 2) {
      continue
    }
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($name) {
      Set-Item -Path "Env:$name" -Value $value
    }
  }
}

function Resolve-Setting {
  param(
    [string]$Explicit,
    [string]$EnvName,
    [string]$Default
  )
  if ($Explicit) {
    return $Explicit
  }
  $envValue = [Environment]::GetEnvironmentVariable($EnvName)
  if ($envValue) {
    return $envValue
  }
  return $Default
}

function Start-YiveProcess {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory
  )

  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Host "[$stamp] starting $Name"
  if ($env:OS -eq "Windows_NT" -and $FilePath -notmatch '[\\/]') {
    return Start-Process -FilePath "cmd.exe" -ArgumentList (@("/d", "/s", "/c", $FilePath) + $ArgumentList) -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru
  }
  return Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru
}

function Test-YiveCommand {
  param([string]$Command)
  if ($Command -match '[\\/]') {
    return Test-Path -LiteralPath $Command
  }
  return $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function ConvertTo-RelayHttpUrl {
  param([string]$Value)
  $trimmed = $Value.Trim().TrimEnd("/")
  if (-not $trimmed) {
    throw "Relay server URL cannot be empty."
  }
  if ($trimmed -match '^[a-z][a-z0-9+.-]*://') {
    return $trimmed
  }
  $authority = ($trimmed -split '[/?#]', 2)[0]
  $host = ($authority -split '@')[-1] -replace ':\d+$', ''
  $host = $host.TrimStart("[").TrimEnd("]")
  $useHttp = $host -eq "localhost" -or
    $host.StartsWith("127.") -or
    $host.StartsWith("10.") -or
    $host.StartsWith("192.168.") -or
    ($host -match '^172\.(1[6-9]|2\d|3[0-1])\.') -or
    ($host -match '^\d{1,3}(\.\d{1,3}){3}$')
  if ($useHttp) {
    return "http://$trimmed"
  }
  return "https://$trimmed"
}

function Invoke-RelayJson {
  param(
    [string]$Url,
    [hashtable]$Headers = @{}
  )
  try {
    return Invoke-RestMethod -Uri $Url -Headers $Headers -Method Get -TimeoutSec 10
  } catch {
    throw "Relay request failed: $Url ($($_.Exception.Message))"
  }
}

function Test-RelayRemoteConfig {
  param(
    [string]$ServerUrl,
    [string]$Token,
    [string]$DeviceId
  )

  $normalizedServerUrl = ConvertTo-RelayHttpUrl -Value $ServerUrl
  $health = Invoke-RelayJson -Url "$normalizedServerUrl/health"
  if ($health.ok -ne $true -or $health.service -ne "hive-relay") {
    throw "Relay health response is not a Yive Relay service."
  }
  if ($health.protocol_version -and [int]$health.protocol_version -gt 1) {
    throw "Relay protocol v$($health.protocol_version) is newer than this desktop client supports."
  }

  $devices = Invoke-RelayJson -Url "$normalizedServerUrl/devices" -Headers @{
    Authorization = "Bearer $Token"
  }
  if ($null -eq $devices.desktops -or $null -eq $devices.mobiles) {
    throw "Relay devices response is invalid."
  }

  Write-Host "Relay remote check: ok"
  Write-Host "Relay health: $($health.service) protocol v$($health.protocol_version)"
  Write-Host "Relay devices: $(@($devices.desktops).Count) desktop, $(@($devices.mobiles).Count) mobile"
  Write-Host "Relay desktop id to use: $DeviceId"
}

function Test-LocalRuntimeConfig {
  param(
    [string]$RuntimeUrl
  )

  try {
    $response = Invoke-WebRequest -Uri "$($RuntimeUrl.TrimEnd('/'))/api/ui/session" -Method Get -TimeoutSec 10 -UseBasicParsing
  } catch {
    throw "Local Yive runtime check failed: $RuntimeUrl ($($_.Exception.Message)). Start local yive or set YIVE_RELAY_MANAGE_RUNTIME=1."
  }

  if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
    throw "Local Yive runtime check failed: $RuntimeUrl returned HTTP $($response.StatusCode)."
  }

  Write-Host "Local runtime check: ok"
}

function Write-DesktopRelayStatus {
  param(
    [string]$Path,
    [string]$Phase,
    [string]$Message,
    [string]$RelayServer,
    [string]$DeviceId,
    [string]$RuntimeUrl,
    [string]$LocalRequestTimeoutMs,
    [bool]$ManageRuntime,
    [System.Diagnostics.Process]$RuntimeProcess,
    [System.Diagnostics.Process]$ConnectProcess
  )

  if (-not $Path) {
    return
  }

  $runtimeStatus = "external"
  $runtimePid = $null
  $runtimeExitCode = $null
  if ($null -ne $RuntimeProcess) {
    $runtimePid = $RuntimeProcess.Id
    if ($RuntimeProcess.HasExited) {
      $runtimeStatus = "exited"
      $runtimeExitCode = $RuntimeProcess.ExitCode
    } else {
      $runtimeStatus = "running"
    }
  } elseif ($ManageRuntime) {
    $runtimeStatus = "not_started"
  }

  $connectStatus = "not_started"
  $connectPid = $null
  $connectExitCode = $null
  if ($null -ne $ConnectProcess) {
    $connectPid = $ConnectProcess.Id
    if ($ConnectProcess.HasExited) {
      $connectStatus = "exited"
      $connectExitCode = $ConnectProcess.ExitCode
    } else {
      $connectStatus = "running"
    }
  }

  $payload = [ordered]@{
    updated_at = (Get-Date).ToUniversalTime().ToString("o")
    phase = $Phase
    message = $Message
    relay_server = $RelayServer
    device_id = $DeviceId
    runtime_url = $RuntimeUrl
    local_request_timeout_ms = [int]$LocalRequestTimeoutMs
    manage_runtime = $ManageRuntime
    runtime = [ordered]@{
      status = $runtimeStatus
      pid = $runtimePid
      exit_code = $runtimeExitCode
    }
    relay_connect = [ordered]@{
      status = $connectStatus
      pid = $connectPid
      exit_code = $connectExitCode
    }
  }

  $statusDir = Split-Path -Parent $Path
  if ($statusDir) {
    New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
  }
  $tempPath = "$Path.tmp"
  $json = $payload | ConvertTo-Json -Depth 5
  if ($PSVersionTable.PSVersion.Major -ge 7) {
    $json | Set-Content -LiteralPath $tempPath -Encoding utf8NoBOM
  } else {
    [System.IO.File]::WriteAllText($tempPath, $json, [System.Text.UTF8Encoding]::new($false))
  }
  Move-Item -LiteralPath $tempPath -Destination $Path -Force
}

Import-YiveEnvFile -Path $EnvFile

if (-not $RepoDir) {
  if ($PSScriptRoot) {
    $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  } else {
    $RepoDir = (Get-Location).Path
  }
}

$runtimePortValue = Resolve-Setting -Explicit $RuntimePort -EnvName "YIVE_RUNTIME_PORT" -Default "3001"
$relayServerValue = Resolve-Setting -Explicit $RelayServer -EnvName "YIVE_RELAY_SERVER" -Default ""
$relayTokenValue = Resolve-Setting -Explicit $RelayToken -EnvName "YIVE_RELAY_TOKEN" -Default ""
$deviceIdValue = Resolve-Setting -Explicit $DeviceId -EnvName "YIVE_RELAY_DEVICE_ID" -Default $env:COMPUTERNAME
$runtimeUrlValue = Resolve-Setting -Explicit $RuntimeUrl -EnvName "YIVE_RELAY_RUNTIME_URL" -Default "http://127.0.0.1:$runtimePortValue"
$localRequestTimeoutMsValue = Resolve-Setting -Explicit $LocalRequestTimeoutMs -EnvName "YIVE_RELAY_LOCAL_REQUEST_TIMEOUT_MS" -Default "15000"
$mobileUrlValue = Resolve-Setting -Explicit $MobileUrl -EnvName "YIVE_MOBILE_URL" -Default $relayServerValue
$statusFileValue = Resolve-Setting -Explicit $StatusFile -EnvName "YIVE_RELAY_STATUS_FILE" -Default "$env:USERPROFILE\.config\yive\desktop-relay-status.json"
$manageRuntimeValue =
  $ManageRuntime -or [Environment]::GetEnvironmentVariable("YIVE_RELAY_MANAGE_RUNTIME") -eq "1"

if (-not (Test-Path -LiteralPath $RepoDir)) {
  throw "RepoDir does not exist: $RepoDir"
}

if (-not (Test-Path -LiteralPath (Join-Path $RepoDir "src\cli\hive.ts"))) {
  throw "RepoDir does not look like a Yive source checkout: $RepoDir"
}

if (-not (Test-YiveCommand -Command $YiveCommand)) {
  throw "Cannot find YiveCommand '$YiveCommand'. Install pnpm or pass -YiveCommand with a valid executable."
}

if (-not $relayServerValue -or -not $relayTokenValue -or $relayTokenValue -eq "change-me") {
  throw "Set YIVE_RELAY_SERVER and YIVE_RELAY_TOKEN in $EnvFile before starting the desktop relay."
}

if (-not ($runtimePortValue -as [int])) {
  throw "YIVE_RUNTIME_PORT must be a number, got '$runtimePortValue'."
}

if (-not $deviceIdValue) {
  throw "YIVE_RELAY_DEVICE_ID cannot be empty."
}

if (-not $runtimeUrlValue) {
  throw "YIVE_RELAY_RUNTIME_URL cannot be empty."
}

if (-not ($localRequestTimeoutMsValue -as [int]) -or [int]$localRequestTimeoutMsValue -le 0) {
  throw "YIVE_RELAY_LOCAL_REQUEST_TIMEOUT_MS must be a positive integer, got '$localRequestTimeoutMsValue'."
}

[Environment]::SetEnvironmentVariable("YIVE_RELAY_SERVER", $relayServerValue, "Process")
[Environment]::SetEnvironmentVariable("YIVE_RELAY_TOKEN", $relayTokenValue, "Process")
[Environment]::SetEnvironmentVariable("YIVE_RELAY_DEVICE_ID", $deviceIdValue, "Process")
[Environment]::SetEnvironmentVariable("YIVE_RELAY_RUNTIME_URL", $runtimeUrlValue, "Process")
[Environment]::SetEnvironmentVariable("YIVE_RELAY_LOCAL_REQUEST_TIMEOUT_MS", $localRequestTimeoutMsValue, "Process")
if ($mobileUrlValue) {
  [Environment]::SetEnvironmentVariable("YIVE_MOBILE_URL", $mobileUrlValue, "Process")
}

$runtimeArgs = @("tsx", "src/cli/hive.ts", "--port", $runtimePortValue)
$connectArgs = @(
  "tsx",
  "src/cli/hive.ts",
  "connect",
  "--server",
  $relayServerValue,
  "--device-id",
  $deviceIdValue,
  "--runtime",
  $runtimeUrlValue,
  "--local-request-timeout-ms",
  $localRequestTimeoutMsValue,
  "--require-runtime"
)
if ($mobileUrlValue) {
  $connectArgs += @("--mobile-url", $mobileUrlValue)
}

Write-Host "Yive desktop runtime: http://127.0.0.1:$runtimePortValue"
Write-Host "Yive relay server: $relayServerValue"
Write-Host "Yive relay device: $deviceIdValue"
Write-Host "Yive local request timeout: ${localRequestTimeoutMsValue}ms"
Write-Host "Yive runtime management: $(if ($manageRuntimeValue) { 'managed' } else { 'external' })"
Write-Host "Yive desktop relay status: $statusFileValue"

if ($Check) {
  $skipRemote = $SkipRelayCheck -or [Environment]::GetEnvironmentVariable("YIVE_RELAY_SKIP_REMOTE_CHECK") -eq "1"
  $skipRuntime =
    $SkipRuntimeCheck -or
    [Environment]::GetEnvironmentVariable("YIVE_RELAY_SKIP_RUNTIME_CHECK") -eq "1" -or
    $manageRuntimeValue
  if ($skipRemote) {
    Write-Host "Relay remote check: skipped"
  } else {
    Test-RelayRemoteConfig -ServerUrl $relayServerValue -Token $relayTokenValue -DeviceId $deviceIdValue
  }
  if ($skipRuntime) {
    Write-Host "Local runtime check: skipped"
  } else {
    Test-LocalRuntimeConfig -RuntimeUrl $runtimeUrlValue
  }
  Write-Host "Yive desktop relay check: ok"
  Write-Host "Config file: $EnvFile"
  Write-Host "Repo dir: $RepoDir"
  Write-Host "Runtime URL: $runtimeUrlValue"
  Write-Host "Local request timeout: ${localRequestTimeoutMsValue}ms"
  Write-Host "Mobile URL: $mobileUrlValue"
  Write-Host "Yive command: $YiveCommand"
  Write-Host "Runtime management: $(if ($manageRuntimeValue) { 'managed' } else { 'external' })"
  Write-Host "Status file: $statusFileValue"
  Write-Host "Relay token: configured"
  Write-DesktopRelayStatus -Path $statusFileValue -Phase "checked" -Message "Desktop relay configuration check passed." -RelayServer $relayServerValue -DeviceId $deviceIdValue -RuntimeUrl $runtimeUrlValue -LocalRequestTimeoutMs $localRequestTimeoutMsValue -ManageRuntime $manageRuntimeValue -RuntimeProcess $null -ConnectProcess $null
  return
}

$runtimeProcess = $null
$connectProcess = $null

try {
  while ($true) {
    if ($manageRuntimeValue) {
      if ($null -eq $runtimeProcess -or $runtimeProcess.HasExited) {
        if ($null -ne $runtimeProcess) {
          $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
          Write-Host "[$stamp] runtime exited with $($runtimeProcess.ExitCode); restarting in ${RestartDelaySeconds}s"
          Start-Sleep -Seconds $RestartDelaySeconds
        }
        $runtimeProcess = Start-YiveProcess -Name "runtime" -FilePath $YiveCommand -ArgumentList $runtimeArgs -WorkingDirectory $RepoDir
        Write-DesktopRelayStatus -Path $statusFileValue -Phase "runtime_started" -Message "Runtime process started." -RelayServer $relayServerValue -DeviceId $deviceIdValue -RuntimeUrl $runtimeUrlValue -LocalRequestTimeoutMs $localRequestTimeoutMsValue -ManageRuntime $manageRuntimeValue -RuntimeProcess $runtimeProcess -ConnectProcess $connectProcess
      }
    }

    if ($null -eq $connectProcess -or $connectProcess.HasExited) {
      if ($null -ne $connectProcess) {
        $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Write-Host "[$stamp] relay-connect exited with $($connectProcess.ExitCode); restarting in ${RestartDelaySeconds}s"
        Start-Sleep -Seconds $RestartDelaySeconds
      }
      $connectProcess = Start-YiveProcess -Name "relay-connect" -FilePath $YiveCommand -ArgumentList $connectArgs -WorkingDirectory $RepoDir
      Write-DesktopRelayStatus -Path $statusFileValue -Phase "relay_connect_started" -Message "Relay connect process started." -RelayServer $relayServerValue -DeviceId $deviceIdValue -RuntimeUrl $runtimeUrlValue -LocalRequestTimeoutMs $localRequestTimeoutMsValue -ManageRuntime $manageRuntimeValue -RuntimeProcess $runtimeProcess -ConnectProcess $connectProcess
    }

    Write-DesktopRelayStatus -Path $statusFileValue -Phase "running" -Message "Desktop relay supervisor is running." -RelayServer $relayServerValue -DeviceId $deviceIdValue -RuntimeUrl $runtimeUrlValue -LocalRequestTimeoutMs $localRequestTimeoutMsValue -ManageRuntime $manageRuntimeValue -RuntimeProcess $runtimeProcess -ConnectProcess $connectProcess
    Start-Sleep -Seconds 2
  }
} finally {
  Write-DesktopRelayStatus -Path $statusFileValue -Phase "stopping" -Message "Desktop relay supervisor is stopping." -RelayServer $relayServerValue -DeviceId $deviceIdValue -RuntimeUrl $runtimeUrlValue -LocalRequestTimeoutMs $localRequestTimeoutMsValue -ManageRuntime $manageRuntimeValue -RuntimeProcess $runtimeProcess -ConnectProcess $connectProcess
  foreach ($process in @($runtimeProcess, $connectProcess)) {
    if ($null -ne $process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Write-DesktopRelayStatus -Path $statusFileValue -Phase "stopped" -Message "Desktop relay supervisor stopped." -RelayServer $relayServerValue -DeviceId $deviceIdValue -RuntimeUrl $runtimeUrlValue -LocalRequestTimeoutMs $localRequestTimeoutMsValue -ManageRuntime $manageRuntimeValue -RuntimeProcess $runtimeProcess -ConnectProcess $connectProcess
}
