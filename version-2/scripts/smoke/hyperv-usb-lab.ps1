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
$IsoPath = Join-Path $LabRoot 'my-own-suite-installer.iso'
$InstallerConfigPath = Join-Path $V2Root '..\deploy\self-host\autoinstall\installer-config\selfhost-installer.env'

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
  return (Get-VMNetworkAdapter -VMName $VmName).IPAddresses |
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

  $hostName = "suite-manager.$StackDomain"
  $healthUrl = "http://$hostName/healthz"
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
  Write-Host "  Suite Mgr:  http://suite-manager.$StackDomain/setup/"
  Write-Host "  Homepage:   http://homepage.$StackDomain/"
}

Assert-HyperV

if ($Command -eq 'destroy') {
  Remove-LabVm
  Remove-LabArtifacts
  Write-Host "[mos-v2-smoke:hyperv-usb] Removed VM '$VmName' and its disposable lab artifacts."
  exit 0
}

Write-Host "[mos-v2-smoke:hyperv-usb] Removing any existing '$VmName' VM and lab artifacts..."
Remove-LabVm
Remove-LabArtifacts

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
Show-Summary -Ip $ip -StackDomain $stackDomain
