param(
  [Parameter(Position = 0)]
  [ValidateSet('reset', 'refresh', 'destroy')]
  [string]$Command = 'reset'
)

$ErrorActionPreference = 'Stop'

$MOSRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$LabRoot = Join-Path $MOSRoot '.mos-smoke\hyperv-usb'
$VmName = 'mos-usb-smoke'
$DiskPath = Join-Path $LabRoot 'os.vhdx'
$BackupDiskPath = Join-Path $LabRoot 'backup.vhdx'
$IsoPath = Join-Path $LabRoot 'my-own-suite-installer.iso'
$HostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$HostsStartMarker = '# BEGIN MOS HYPERV USB SMOKE'
$HostsEndMarker = '# END MOS HYPERV USB SMOKE'
$DefaultDns01SmokeDomain = 'hyperv.diemernet.uk'

function Fail([string]$Message) {
  throw "[mos-smoke:hyperv-usb] $Message"
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
  if ($env:MOS_HYPERV_SWITCH) {
    $switch = Get-VMSwitch -Name $env:MOS_HYPERV_SWITCH -ErrorAction SilentlyContinue
    if (-not $switch) { Fail "Hyper-V switch '$env:MOS_HYPERV_SWITCH' does not exist." }
    return $switch
  }
  $switch = Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue
  if ($switch) { return $switch }
  $switch = Get-VMSwitch | Where-Object SwitchType -eq 'External' | Select-Object -First 1
  if ($switch) { return $switch }
  Fail 'No Default Switch or external Hyper-V switch is available. Set MOS_HYPERV_SWITCH to an existing switch.'
}

function Remove-LabVm {
  $vmNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $namedVm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
  if ($namedVm) { [void]$vmNames.Add($namedVm.Name) }

  # A harness rename can leave the same disposable VHDX attached to a VM with
  # an older name. Find ownership by the exact lab directory before deleting it.
  foreach ($vm in @(Get-VM)) {
    foreach ($drive in @(Get-VMHardDiskDrive -VMName $vm.Name -ErrorAction SilentlyContinue)) {
      if ($drive.Path -and [IO.Path]::GetFullPath($drive.Path).StartsWith("$LabRoot\", [StringComparison]::OrdinalIgnoreCase)) {
        [void]$vmNames.Add($vm.Name)
      }
    }
  }

  foreach ($name in $vmNames) {
    $vm = Get-VM -Name $name -ErrorAction SilentlyContinue
    if (-not $vm) { continue }
    if ($vm.State -ne 'Off') { Stop-VM -Name $name -TurnOff -Force }
    Remove-VM -Name $name -Force
  }
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

  $extraDomains = if ($env:MOS_HYPERV_EXTRA_HOST_DOMAINS) {
    $env:MOS_HYPERV_EXTRA_HOST_DOMAINS
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

# External packages are installed at runtime from a GitHub repository, so they have
# no folder under `apps/` for the scan below to find. Their hostnames come from the
# declaration in `scripts/smoke/external-lab-apps.cjs`, which applies the same
# `ext-` prefix the Suite Manager uses, so the lab and the runtime cannot disagree.
$script:ExternalLabRouteHostsCache = $null
function Get-ExternalLabRouteHosts {
  if ($null -ne $script:ExternalLabRouteHostsCache) { return $script:ExternalLabRouteHostsCache }
  $helper = Join-Path $MOSRoot 'scripts\smoke\external-lab-apps.cjs'
  if (-not (Test-Path -LiteralPath $helper)) { Fail "External lab app declaration '$helper' is missing." }
  $output = & node $helper
  if ($LASTEXITCODE -ne 0) { Fail 'Could not resolve external lab app hostnames.' }
  $script:ExternalLabRouteHostsCache = @($output | ForEach-Object { "$_".Trim().ToLowerInvariant() } | Where-Object { $_ })
  return $script:ExternalLabRouteHostsCache
}

function Get-SmokeHostNamesForDomain {
  param([string]$Domain)

  $names = [System.Collections.Generic.List[string]]::new()
  $names.Add("home.$Domain")
  foreach ($externalHost in @(Get-ExternalLabRouteHosts)) {
    if ($externalHost -match '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') {
      $names.Add("$externalHost.$Domain")
    }
    else {
      Write-Warning "[mos-smoke:hyperv-usb] Skipping invalid external lab hostname '$externalHost'."
    }
  }
  $appsRoot = Join-Path $MOSRoot 'apps'
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
        Write-Warning "[mos-smoke:hyperv-usb] Could not inspect app package manifest '$manifestPath'."
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
  $builder = Join-Path $MOSRoot 'scripts\smoke\build-hyperv-usb-iso.cjs'
  & node $builder
  if ($LASTEXITCODE -ne 0) { Fail 'USB installer ISO generation failed.' }
  if (-not (Test-Path -LiteralPath $IsoPath)) { Fail "USB installer ISO was not created at '$IsoPath'." }
}

function Get-BackupDiskSizeBytes {
  $sizeGb = 16
  if ($env:MOS_HYPERV_BACKUP_DISK_GB) {
    if (-not [int]::TryParse($env:MOS_HYPERV_BACKUP_DISK_GB, [ref]$sizeGb) -or $sizeGb -lt 4 -or $sizeGb -gt 256) {
      Fail 'MOS_HYPERV_BACKUP_DISK_GB must be a whole number from 4 to 256.'
    }
  }
  return $sizeGb * 1GB
}

function Set-LabVmRestartPolicy {
  # Hyper-V only allows changing automatic start/stop actions while the VM is
  # off. The default stop action (Save) breaks the lab across host restarts:
  # the Default Switch gets a new subnet on every host boot, and a resumed
  # guest keeps its DHCP lease for the old subnet, so nothing is reachable.
  # A clean shutdown/boot cycle re-leases on the current subnet.
  Set-VM -Name $VmName -AutomaticStopAction ShutDown -AutomaticStartAction StartIfRunning -AutomaticStartDelay 10
}

function Get-StackDomain {
  if ($env:MOS_STACK_DOMAIN) {
    return $env:MOS_STACK_DOMAIN.Trim().Trim('"').Trim("'")
  }

  # The lab deliberately ignores selfhost-installer.env here: its domain must
  # never match a real USB install (mos.home), or the hosts entries written by
  # this script would shadow the real server's DNS on this machine.
  return 'mos.hyperv'
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
  param(
    [string]$StackDomain,
    [int]$TimeoutMinutesOverride = 0,
    [string]$ProgressLabel = 'Installing'
  )

  $timeoutMinutes = 90
  if ($env:MOS_HYPERV_READY_TIMEOUT_MINUTES) {
    if (-not [int]::TryParse($env:MOS_HYPERV_READY_TIMEOUT_MINUTES, [ref]$timeoutMinutes) -or $timeoutMinutes -lt 1) {
      Fail 'MOS_HYPERV_READY_TIMEOUT_MINUTES must be a positive whole number.'
    }
  }
  if ($TimeoutMinutesOverride -gt 0) { $timeoutMinutes = $TimeoutMinutesOverride }

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
      Write-Host "[mos-smoke:hyperv-usb] $ProgressLabel ($elapsed/$timeoutMinutes min): $detail"
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
  Write-Host '[mos-smoke:hyperv-usb] USB installer smoke VM is ready.'
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
  Write-Host "[mos-smoke:hyperv-usb] Removed VM '$VmName' and its disposable lab artifacts."
  exit 0
}

if ($Command -eq 'refresh') {
  $vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
  if (-not $vm) {
    Fail "VM '$VmName' does not exist. Run 'npm run smoke:hyperv:reset' (destructive; builds a fresh lab) to create it."
  }

  if ($vm.State -eq 'Off') {
    Set-LabVmRestartPolicy
    Write-Host "[mos-smoke:hyperv-usb] Starting VM '$VmName'..."
    Start-VM -Name $VmName | Out-Null
  }
  elseif ($vm.State -ne 'Running') {
    Write-Host "[mos-smoke:hyperv-usb] Resuming VM '$VmName' from state '$($vm.State)'..."
    Start-VM -Name $VmName | Out-Null
  }

  $stackDomain = Get-StackDomain
  $probeMinutes = 5
  if ($env:MOS_HYPERV_REFRESH_PROBE_MINUTES) {
    if (-not [int]::TryParse($env:MOS_HYPERV_REFRESH_PROBE_MINUTES, [ref]$probeMinutes) -or $probeMinutes -lt 1) {
      Fail 'MOS_HYPERV_REFRESH_PROBE_MINUTES must be a positive whole number.'
    }
  }

  Write-Host "[mos-smoke:hyperv-usb] Probing Suite Manager readiness on *.$stackDomain..."
  $ip = $null
  try {
    $ip = Wait-ForSuiteManager -StackDomain $stackDomain -TimeoutMinutesOverride $probeMinutes -ProgressLabel 'Probing'
  }
  catch {
    # Typical after a host restart: the guest resumed from a saved state with a
    # DHCP lease for the previous Default Switch subnet. A guest reboot
    # re-leases on the current subnet.
    Write-Host "[mos-smoke:hyperv-usb] Suite Manager is unreachable; restarting the guest so it re-leases on the current switch subnet..."
    Stop-VM -Name $VmName -Force
    Set-LabVmRestartPolicy
    Start-VM -Name $VmName | Out-Null
    $ip = Wait-ForSuiteManager -StackDomain $stackDomain -ProgressLabel 'Rebooting'
  }

  Set-SmokeHostsEntries -Ip $ip -StackDomain $stackDomain
  $vm = Get-VM -Name $VmName
  if ($vm.AutomaticStopAction -ne 'ShutDown') {
    Write-Host "[mos-smoke:hyperv-usb] Note: automatic stop action is still '$($vm.AutomaticStopAction)'; the next refresh that stops the VM will switch it to ShutDown."
  }
  Show-Summary -Ip $ip -StackDomain $stackDomain
  exit 0
}

Write-Host "[mos-smoke:hyperv-usb] Removing any existing '$VmName' VM and lab artifacts..."
Remove-LabVm
Remove-LabArtifacts
Remove-SmokeHostsEntries

Write-Host '[mos-smoke:hyperv-usb] Building the canonical single-USB installer ISO...'
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
  Set-LabVmRestartPolicy
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
Write-Host "[mos-smoke:hyperv-usb] Waiting for Ubuntu installation and Suite Manager readiness on *.$stackDomain..."
$ip = Wait-ForSuiteManager -StackDomain $stackDomain
Set-SmokeHostsEntries -Ip $ip -StackDomain $stackDomain
Show-Summary -Ip $ip -StackDomain $stackDomain
