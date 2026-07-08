param(
  [Parameter(Position = 0)]
  [ValidateSet('reset', 'destroy')]
  [string]$Command = 'reset'
)

$ErrorActionPreference = 'Stop'

$V2Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$LabRoot = Join-Path $V2Root '.mos-smoke\hyperv-usb'
$VmName = 'mos-v2-usb-smoke'
$DiskPath = Join-Path $LabRoot 'os.vhdx'
$BackupDiskPath = Join-Path $LabRoot 'backup.vhdx'
$IsoPath = Join-Path $LabRoot 'my-own-suite-installer.iso'
$InstallerConfigPath = Join-Path $V2Root '..\deploy\self-host\autoinstall\installer-config\selfhost-installer.env'
$HostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$HostsStartMarker = '# BEGIN MOS V2 HYPERV USB SMOKE'
$HostsEndMarker = '# END MOS V2 HYPERV USB SMOKE'
$DefaultDns01SmokeDomain = 'hyperv.diemernet.uk'

function Fail([string]$Message) {
  throw "[mos-v2-smoke:hyperv-usb] $Message"
}

function Assert-HyperV {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'Run this command from an Administrator PowerShell terminal.'
  }
  if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) {
    Fail 'Hyper-V PowerShell management tools are not installed.'
  }
}

function Get-LabSwitch {
  if ($env:MOS_V2_HYPERV_SWITCH) {
    $switch = Get-VMSwitch -Name $env:MOS_V2_HYPERV_SWITCH -ErrorAction SilentlyContinue
    if (-not $switch) { Fail "Hyper-V switch '$env:MOS_V2_HYPERV_SWITCH' does not exist." }
    return $switch
  }
  $switch = Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue
  if ($switch) { return $switch }
  $switch = Get-VMSwitch | Where-Object SwitchType -eq 'External' | Select-Object -First 1
  if ($switch) { return $switch }
  Fail 'No Default Switch or external Hyper-V switch is available. Set MOS_V2_HYPERV_SWITCH to an existing switch.'
}

function Remove-LabVm {
  $vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
  if (-not $vm) { return }
  if ($vm.State -ne 'Off') { Stop-VM -Name $VmName -TurnOff -Force }
  Remove-VM -Name $VmName -Force
}

function Remove-LabArtifacts {
  if (Test-Path -LiteralPath $LabRoot) {
    Remove-Item -LiteralPath $LabRoot -Recurse -Force
  }
}

function Get-SmokeHostDomains {
  param([string]$StackDomain)

  $domains = [System.Collections.Generic.List[string]]::new()
  $domains.Add($StackDomain)

  $extraDomains = if ($env:MOS_V2_HYPERV_EXTRA_HOST_DOMAINS) {
    $env:MOS_V2_HYPERV_EXTRA_HOST_DOMAINS
  }
  else {
    $DefaultDns01SmokeDomain
  }

  foreach ($domain in ($extraDomains -split ',')) {
    $normalized = $domain.Trim().Trim('.').ToLowerInvariant()
    if ($normalized -and $normalized -match '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$') {
      $domains.Add($normalized)
    }
  }

  return $domains | Select-Object -Unique
}

function Get-SmokeHostNamesForDomain {
  param([string]$Domain)

  $names = [System.Collections.Generic.List[string]]::new()
  $names.Add("home.$Domain")
  $appsRoot = Join-Path $V2Root 'apps'
  if (Test-Path -LiteralPath $appsRoot) {
    Get-ChildItem -LiteralPath $appsRoot -Directory | ForEach-Object {
      $manifestPath = Join-Path $_.FullName 'manifest.json'
      if (-not (Test-Path -LiteralPath $manifestPath)) { return }
      try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        foreach ($route in @($manifest.routes)) {
          if ($route.host -and "$($route.host)" -match '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') {
            $names.Add("$($route.host).$Domain")
          }
        }
      }
      catch {
        Write-Warning "[mos-v2-smoke:hyperv-usb] Could not inspect app package manifest '$manifestPath'."
      }
    }
  }
  return $names | Select-Object -Unique
}

function Get-SmokeHostNames {
  param([string]$StackDomain)

  $names = [System.Collections.Generic.List[string]]::new()
  foreach ($domain in @(Get-SmokeHostDomains -StackDomain $StackDomain)) {
    foreach ($name in @(Get-SmokeHostNamesForDomain -Domain $domain)) {
      $names.Add($name)
    }
  }
  return $names | Select-Object -Unique
}

function Remove-SmokeHostsEntries {
  if (-not (Test-Path -LiteralPath $HostsPath)) { return }
  $content = [IO.File]::ReadAllText($HostsPath)
  $stackDomain = Get-StackDomain
  $hostNames = @(Get-SmokeHostNames -StackDomain $stackDomain)
  $pattern = "(?ms)^$([regex]::Escape($HostsStartMarker))\r?\n.*?^$([regex]::Escape($HostsEndMarker))\r?\n?"
  $updated = [regex]::Replace($content, $pattern, '').TrimEnd()
  foreach ($hostName in $hostNames) {
    $hostPattern = "(?m)^\s*\S+\s+$([regex]::Escape($hostName))(\s|$).*\r?\n?"
    $updated = [regex]::Replace($updated, $hostPattern, '').TrimEnd()
  }
  [IO.File]::WriteAllText($HostsPath, "$updated`r`n", [Text.Encoding]::ASCII)
}

function Set-SmokeHostsEntries {
  param(
    [string]$Ip,
    [string]$StackDomain
  )
  Remove-SmokeHostsEntries
  $entries = @(Get-SmokeHostNames -StackDomain $StackDomain | ForEach-Object { "$Ip $_" })
  $block = (@($HostsStartMarker) + $entries + @($HostsEndMarker)) -join "`r`n"
  [IO.File]::AppendAllText($HostsPath, "$block`r`n", [Text.Encoding]::ASCII)
  & ipconfig.exe /flushdns | Out-Null
}

function Build-InstallerIso {
  $builder = Join-Path $V2Root 'scripts\smoke\build-hyperv-usb-iso.cjs'
  & node $builder
  if ($LASTEXITCODE -ne 0) { Fail 'USB installer ISO generation failed.' }
  if (-not (Test-Path -LiteralPath $IsoPath)) { Fail "USB installer ISO was not created at '$IsoPath'." }
}

function Get-BackupDiskSizeBytes {
  $sizeGb = 16
  if ($env:MOS_V2_HYPERV_BACKUP_DISK_GB) {
    if (-not [int]::TryParse($env:MOS_V2_HYPERV_BACKUP_DISK_GB, [ref]$sizeGb) -or $sizeGb -lt 4 -or $sizeGb -gt 256) {
      Fail 'MOS_V2_HYPERV_BACKUP_DISK_GB must be a whole number from 4 to 256.'
    }
  }
  return $sizeGb * 1GB
}

function Get-StackDomain {
  $line = Get-Content -LiteralPath $InstallerConfigPath |
    Where-Object { $_ -match '^\s*STACK_DOMAIN\s*=' } |
    Select-Object -Last 1
  if (-not $line) { return 'mos.home' }
  $value = ($line -split '=', 2)[1].Trim()
  return $value.Trim('"').Trim("'")
}

function Get-GuestIpv4Addresses {
  $adapter = Get-VMNetworkAdapter -VMName $VmName
  $reported = @($adapter.IPAddresses)
  $macAddress = $adapter.MacAddress -replace '[^0-9A-Fa-f]', ''
  $neighbors = if ($macAddress) {
    @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { ($_.LinkLayerAddress -replace '[^0-9A-Fa-f]', '') -eq $macAddress } |
      Select-Object -ExpandProperty IPAddress)
  }
  else { @() }

  $candidates = @($reported) + @($neighbors)
  return $candidates |
    Where-Object { $_ -match '^\d{1,3}(?:\.\d{1,3}){3}$' -and $_ -notmatch '^(127|169\.254)\.' } |
    Select-Object -Unique
}

function Wait-ForSuiteManager {
  param([string]$StackDomain)

  $timeoutMinutes = 90
  if ($env:MOS_V2_HYPERV_READY_TIMEOUT_MINUTES) {
    if (-not [int]::TryParse($env:MOS_V2_HYPERV_READY_TIMEOUT_MINUTES, [ref]$timeoutMinutes) -or $timeoutMinutes -lt 1) {
      Fail 'MOS_V2_HYPERV_READY_TIMEOUT_MINUTES must be a positive whole number.'
    }
  }

  $hostName = "home.$StackDomain"
  $healthUrl = "http://$hostName/suite-manager/api/setup/status"
  $homepageUrl = "http://$hostName/"
  $startedAt = Get-Date
  $deadline = $startedAt.AddMinutes($timeoutMinutes)
  $nextReportAt = $startedAt
  $lastDetail = ''

  while ((Get-Date) -lt $deadline) {
    $vm = Get-VM -Name $VmName
    if ($vm.State -eq 'Off') {
      Fail "VM '$VmName' powered off before Suite Manager became ready. Open its Hyper-V console to inspect the installer result."
    }

    $addresses = @(Get-GuestIpv4Addresses)
    $detail = if ($addresses.Count -eq 0) { 'waiting for installer networking' } else { "guest IPv4=$($addresses -join ', '); waiting for Suite Manager and Homepage" }
    foreach ($ip in $addresses) {
      $previousErrorAction = $ErrorActionPreference
      try {
        $ErrorActionPreference = 'Continue'
        & curl.exe --fail --silent --show-error --max-time 4 --output NUL --resolve "${hostName}:80:$ip" $healthUrl 2>$null
        $suiteManagerExitCode = $LASTEXITCODE
        if ($suiteManagerExitCode -eq 0) {
          & curl.exe --fail --silent --show-error --max-time 4 --output NUL --resolve "${hostName}:80:$ip" $homepageUrl 2>$null
          $homepageExitCode = $LASTEXITCODE
        }
        else {
          $homepageExitCode = 1
        }
      }
      finally { $ErrorActionPreference = $previousErrorAction }
      if ($suiteManagerExitCode -eq 0 -and $homepageExitCode -eq 0) { return $ip }
    }

    if ($detail -ne $lastDetail -or (Get-Date) -ge $nextReportAt) {
      $elapsed = [math]::Floor(((Get-Date) - $startedAt).TotalMinutes)
      Write-Host "[mos-v2-smoke:hyperv-usb] Installing ($elapsed/$timeoutMinutes min): $detail"
      $lastDetail = $detail
      $nextReportAt = (Get-Date).AddSeconds(30)
    }
    Start-Sleep -Seconds 5
  }

  Fail "Timed out after $timeoutMinutes minutes waiting for $healthUrl and $homepageUrl. Open the '$VmName' console in Hyper-V Manager to inspect installer/bootstrap errors."
}

function Show-Summary {
  param(
    [string]$Ip,
    [string]$StackDomain
  )
  $vm = Get-VM -Name $VmName
  $adapter = Get-VMNetworkAdapter -VMName $VmName
  $disk = Get-VMHardDiskDrive -VMName $VmName | Where-Object Path -eq $DiskPath
  $backupDisk = Get-VMHardDiskDrive -VMName $VmName | Where-Object Path -eq $BackupDiskPath
  $dvd = Get-VMDvdDrive -VMName $VmName | Where-Object Path -eq $IsoPath
  Write-Host ''
  Write-Host '[mos-v2-smoke:hyperv-usb] USB installer smoke VM is ready.'
  Write-Host "  VM:         $($vm.Name) ($($vm.State))"
  Write-Host "  Generation: $($vm.Generation)"
  Write-Host "  Switch:     $($adapter.SwitchName)"
  Write-Host "  Disk:       $($disk.Path)"
  Write-Host "  Backup:     $($backupDisk.Path)"
  Write-Host "  Installer:  $($dvd.Path)"
  Write-Host "  IPv4:       $Ip"
  Write-Host "  MOS Home:   http://home.$StackDomain/"
  Write-Host "  Suite Mgr:  http://home.$StackDomain/suite-manager/"
  Write-Host "  Host domains: $((Get-SmokeHostDomains -StackDomain $StackDomain) -join ', ')"
  Write-Host "  App hosts:  $((Get-SmokeHostNames -StackDomain $StackDomain | Where-Object { $_ -notlike 'home.*' }) -join ', ')"
}

Assert-HyperV

if ($Command -eq 'destroy') {
  Remove-LabVm
  Remove-LabArtifacts
  Remove-SmokeHostsEntries
  Write-Host "[mos-v2-smoke:hyperv-usb] Removed VM '$VmName' and its disposable lab artifacts."
  exit 0
}

Write-Host "[mos-v2-smoke:hyperv-usb] Removing any existing '$VmName' VM and lab artifacts..."
Remove-LabVm
Remove-LabArtifacts
Remove-SmokeHostsEntries

Write-Host '[mos-v2-smoke:hyperv-usb] Building the canonical single-USB installer ISO...'
Build-InstallerIso

$switch = Get-LabSwitch
New-VHD -Path $DiskPath -Dynamic -SizeBytes 64GB | Out-Null
New-VHD -Path $BackupDiskPath -Dynamic -SizeBytes (Get-BackupDiskSizeBytes) | Out-Null
try {
  New-VM -Name $VmName -Generation 2 -MemoryStartupBytes 2GB -VHDPath $DiskPath -SwitchName $switch.Name | Out-Null
  Add-VMHardDiskDrive -VMName $VmName -Path $BackupDiskPath
  Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $true -MinimumBytes 2GB -StartupBytes 2GB -MaximumBytes 4GB
  Set-VMProcessor -VMName $VmName -Count 2
  Set-VMFirmware -VMName $VmName -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority
  $dvd = Add-VMDvdDrive -VMName $VmName -Path $IsoPath -Passthru
  $osDisk = Get-VMHardDiskDrive -VMName $VmName | Where-Object Path -eq $DiskPath
  Set-VMFirmware -VMName $VmName -BootOrder $osDisk, $dvd
  Start-VM -Name $VmName | Out-Null
}
catch {
  Remove-LabVm
  if (Test-Path -LiteralPath $DiskPath) { Remove-Item -LiteralPath $DiskPath -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $BackupDiskPath) { Remove-Item -LiteralPath $BackupDiskPath -Force -ErrorAction SilentlyContinue }
  throw
}

$deadline = (Get-Date).AddSeconds(15)
do {
  $vm = Get-VM -Name $VmName
  if ($vm.State -eq 'Running') { break }
  Start-Sleep -Seconds 1
} while ((Get-Date) -lt $deadline)

$dvd = Get-VMDvdDrive -VMName $VmName | Where-Object Path -eq $IsoPath
if ($vm.State -ne 'Running' -or -not $dvd) {
  Fail "VM '$VmName' did not reach Running state with the installer ISO attached."
}

$stackDomain = Get-StackDomain
Write-Host "[mos-v2-smoke:hyperv-usb] Waiting for Ubuntu installation and Suite Manager readiness on *.$stackDomain..."
$ip = Wait-ForSuiteManager -StackDomain $stackDomain
Set-SmokeHostsEntries -Ip $ip -StackDomain $stackDomain
Show-Summary -Ip $ip -StackDomain $stackDomain
