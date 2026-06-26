param(
  [Parameter(Position = 0)]
  [ValidateSet('reset', 'destroy', 'hosts')]
  [string]$Command = 'reset'
)

$ErrorActionPreference = 'Stop'

$V2Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$LabRoot = Join-Path $V2Root '.mos-smoke\hyperv-usb'
$VmName = 'mos-v2-usb-smoke'
$DiskPath = Join-Path $LabRoot 'os.vhdx'
$IsoPath = Join-Path $LabRoot 'my-own-suite-installer.iso'
$InstallerConfigPath = Join-Path $V2Root '..\deploy\self-host\autoinstall\installer-config\selfhost-installer.env'
$HostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$HostsStartMarker = '# BEGIN MOS V2 HYPERV USB SMOKE'
$HostsEndMarker = '# END MOS V2 HYPERV USB SMOKE'

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

function Remove-SmokeHostsEntries {
  if (-not (Test-Path -LiteralPath $HostsPath)) { return }
  $content = [IO.File]::ReadAllText($HostsPath)
  if (-not $content.Contains($HostsStartMarker)) { return }
  $pattern = "(?ms)^$([regex]::Escape($HostsStartMarker))\r?\n.*?^$([regex]::Escape($HostsEndMarker))\r?\n?"
  $updated = [regex]::Replace($content, $pattern, '').TrimEnd()
  [IO.File]::WriteAllText($HostsPath, "$updated`r`n", [Text.Encoding]::ASCII)
}

function Set-SmokeHostsEntries {
  param(
    [string]$Ip,
    [string]$StackDomain
  )
  Remove-SmokeHostsEntries
  $block = @(
    $HostsStartMarker,
    "$Ip home.$StackDomain",
    $HostsEndMarker
  ) -join "`r`n"
  [IO.File]::AppendAllText($HostsPath, "$block`r`n", [Text.Encoding]::ASCII)
  & ipconfig.exe /flushdns | Out-Null
}

function Update-SmokeHostsEntries {
  $vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
  if (-not $vm) { Fail "VM '$VmName' does not exist. Run the reset command first." }
  if ($vm.State -ne 'Running') { Fail "VM '$VmName' is $($vm.State), not Running. Start it or run the reset command first." }

  $stackDomain = Get-StackDomain
  Write-Host "[mos-v2-smoke:hyperv-usb] Discovering '$VmName' IPv4 and refreshing Windows hosts entry for home.$stackDomain..."
  $ip = Wait-ForSuiteManager -StackDomain $stackDomain
  Set-SmokeHostsEntries -Ip $ip -StackDomain $stackDomain
  Write-Host "[mos-v2-smoke:hyperv-usb] Updated Windows hosts entry and flushed DNS."
  Write-Host "  $ip home.$stackDomain"
  Write-Host "  MOS Home:   http://home.$stackDomain/"
  Write-Host "  Suite Mgr:  http://home.$stackDomain/suite-manager/"
}

function Build-InstallerIso {
  $builder = Join-Path $V2Root 'scripts\smoke\build-hyperv-usb-iso.cjs'
  & node $builder
  if ($LASTEXITCODE -ne 0) { Fail 'USB installer ISO generation failed.' }
  if (-not (Test-Path -LiteralPath $IsoPath)) { Fail "USB installer ISO was not created at '$IsoPath'." }
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
    $detail = if ($addresses.Count -eq 0) { 'waiting for installer networking' } else { "guest IPv4=$($addresses -join ', '); waiting for Suite Manager" }
    foreach ($ip in $addresses) {
      $previousErrorAction = $ErrorActionPreference
      try {
        $ErrorActionPreference = 'Continue'
        & curl.exe --fail --silent --show-error --max-time 4 --output NUL --resolve "${hostName}:80:$ip" $healthUrl 2>$null
        $curlExitCode = $LASTEXITCODE
      }
      finally { $ErrorActionPreference = $previousErrorAction }
      if ($curlExitCode -eq 0) { return $ip }
    }

    if ($detail -ne $lastDetail -or (Get-Date) -ge $nextReportAt) {
      $elapsed = [math]::Floor(((Get-Date) - $startedAt).TotalMinutes)
      Write-Host "[mos-v2-smoke:hyperv-usb] Installing ($elapsed/$timeoutMinutes min): $detail"
      $lastDetail = $detail
      $nextReportAt = (Get-Date).AddSeconds(30)
    }
    Start-Sleep -Seconds 5
  }

  Fail "Timed out after $timeoutMinutes minutes waiting for $healthUrl. Open the '$VmName' console in Hyper-V Manager to inspect installer/bootstrap errors."
}

function Show-Summary {
  param(
    [string]$Ip,
    [string]$StackDomain
  )
  $vm = Get-VM -Name $VmName
  $adapter = Get-VMNetworkAdapter -VMName $VmName
  $disk = Get-VMHardDiskDrive -VMName $VmName | Where-Object Path -eq $DiskPath
  $dvd = Get-VMDvdDrive -VMName $VmName | Where-Object Path -eq $IsoPath
  Write-Host ''
  Write-Host '[mos-v2-smoke:hyperv-usb] USB installer smoke VM is ready.'
  Write-Host "  VM:         $($vm.Name) ($($vm.State))"
  Write-Host "  Generation: $($vm.Generation)"
  Write-Host "  Switch:     $($adapter.SwitchName)"
  Write-Host "  Disk:       $($disk.Path)"
  Write-Host "  Installer:  $($dvd.Path)"
  Write-Host "  IPv4:       $Ip"
  Write-Host "  MOS Home:   http://home.$StackDomain/"
  Write-Host "  Suite Mgr:  http://home.$StackDomain/suite-manager/"
}

Assert-HyperV

if ($Command -eq 'destroy') {
  Remove-LabVm
  Remove-LabArtifacts
  Remove-SmokeHostsEntries
  Write-Host "[mos-v2-smoke:hyperv-usb] Removed VM '$VmName' and its disposable lab artifacts."
  exit 0
}

if ($Command -eq 'hosts') {
  Update-SmokeHostsEntries
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
try {
  New-VM -Name $VmName -Generation 2 -MemoryStartupBytes 2GB -VHDPath $DiskPath -SwitchName $switch.Name | Out-Null
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
