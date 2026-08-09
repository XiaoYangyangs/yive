[CmdletBinding()]
param(
  [string]$TaskName = "Yive Desktop Relay",
  [string]$EnvFile = "$env:USERPROFILE\.config\yive\desktop-relay.env",
  [string]$RepoDir = "",
  [ValidateSet("auto", "scheduled-task", "startup-folder")]
  [string]$InstallMode = "auto",
  [switch]$SkipRelayCheck,
  [switch]$SkipRuntimeCheck,
  [switch]$RunNow
)

$ErrorActionPreference = "Stop"

if (-not $RepoDir) {
  if ($PSScriptRoot) {
    $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  } else {
    $RepoDir = (Get-Location).Path
  }
}

$scriptPath = Join-Path $RepoDir "deploy\run-windows-desktop-relay.ps1"
if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "Cannot find $scriptPath"
}

function Quote-CmdArgument {
  param([string]$Value)
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Get-RelayPowerShellArguments {
  return @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Quote-CmdArgument -Value $scriptPath),
    "-EnvFile",
    (Quote-CmdArgument -Value $EnvFile),
    "-RepoDir",
    (Quote-CmdArgument -Value $RepoDir)
  ) -join " "
}

function Install-StartupFolderLauncher {
  $startupDir = [Environment]::GetFolderPath("Startup")
  if (-not $startupDir) {
    throw "Cannot resolve the current user's Startup folder."
  }
  New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
  $launcherPath = Join-Path $startupDir "Yive Desktop Relay.cmd"
  $arguments = Get-RelayPowerShellArguments
  $content = @(
    "@echo off",
    "start ""Yive Desktop Relay"" /min powershell.exe $arguments"
  ) -join "`r`n"
  Set-Content -LiteralPath $launcherPath -Value ($content + "`r`n") -Encoding ASCII
  Write-Host "Installed Startup folder launcher: $launcherPath"
  Write-Host "Config file: $EnvFile"
  Write-Host "Repo dir: $RepoDir"
  if ($RunNow) {
    Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WorkingDirectory $RepoDir -WindowStyle Hidden
    Write-Host "Started desktop relay supervisor from Startup folder launcher settings."
  }
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
  $envDir = Split-Path -Parent $EnvFile
  New-Item -ItemType Directory -Path $envDir -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $RepoDir "deploy\windows-desktop-relay.env.example") -Destination $EnvFile -Force
  throw "Created $EnvFile. Edit YIVE_RELAY_SERVER and YIVE_RELAY_TOKEN, then run this installer again."
}

$checkArgs = @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  $scriptPath,
  "-EnvFile",
  $EnvFile,
  "-RepoDir",
  $RepoDir,
  "-Check"
)
if ($SkipRelayCheck) {
  $checkArgs += "-SkipRelayCheck"
}
if ($SkipRuntimeCheck) {
  $checkArgs += "-SkipRuntimeCheck"
}

& powershell.exe @checkArgs

if ($InstallMode -eq "startup-folder") {
  Install-StartupFolderLauncher
  return
}

try {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument (Get-RelayPowerShellArguments)
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

  Write-Host "Installed scheduled task: $TaskName"
  Write-Host "Config file: $EnvFile"
  Write-Host "Repo dir: $RepoDir"

  if ($RunNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started scheduled task: $TaskName"
  }
} catch {
  if ($InstallMode -eq "scheduled-task") {
    throw
  }
  Write-Host "Scheduled task install failed; falling back to the current user's Startup folder."
  Write-Host $_.Exception.Message
  Install-StartupFolderLauncher
}
