#Requires -Version 5.1
<#
.SYNOPSIS
  Bakes a My Own Suite disk image: one machine, built once, written byte-for-byte
  to every target instead of running an OS installer on each one.

.DESCRIPTION
  Stages run in order and can be run individually while iterating.

    seed     render the autoinstall seed for the bake VM
    iso      remaster the Ubuntu installer ISO around that seed
    bake     install and provision inside a Hyper-V VM, then finalize and power off
    verify   boot a throwaway copy of the baked disk and report its address
    convert  turn the baked disk into a raw .img and report what finalize recorded
    clean    remove the VMs and the working disks

  Hyper-V runs the bake because it is the only hardware-accelerated hypervisor
  here; Docker Desktop on this host has no /dev/kvm, so QEMU would emulate and the
  bake would take hours. The conversion runs in a container instead of using
  Convert-VHD, because mounting a VHD on the host needs Administrator and reading
  a VHDX with qemu-img does not.
#>
param(
  [ValidateSet('all', 'seed', 'iso', 'bake', 'verify', 'convert', 'inspect', 'clean')]
  [string]$Stage = 'all',
  [int]$DiskSizeGB = 16,
  [int]$MemoryGB = 6,
  [int]$Cpus = 4,
  [int]$BakeTimeoutMinutes = 120,
  # Free space at the end of the filesystem is unwritten, so it compresses to
  # nothing and costs the download almost nothing. Being stingy here only buys a
  # brick if mos-grow-root ever fails to expand on the target.
  [int]$SlackMB = 1024,
  [string]$RepoRef = 'staging',
  [switch]$DebugBake
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WorkRoot = Join-Path $PSScriptRoot '.work'
$SeedDir = Join-Path $WorkRoot 'seed'
$IsoPath = Join-Path $WorkRoot 'bake-installer.iso'
$BakeDiskPath = Join-Path $WorkRoot 'bake.vhdx'
$VerifyDiskPath = Join-Path $WorkRoot 'verify.vhdx'
$OutputDir = Join-Path $WorkRoot 'out'
$VmName = 'mos-image-bake'
$VerifyVmName = 'mos-image-verify'
$ToolingImage = 'mos-image-tools:local'

function Say([string]$Message) { Write-Host "[mos-image] $Message" }
function Fail([string]$Message) { throw "[mos-image] $Message" }

# Windows PowerShell turns anything a native command writes to stderr into a
# terminating error under ErrorActionPreference=Stop. Docker, npm and qemu-img all
# report progress there, so exit code is the only trustworthy verdict.
function Invoke-Native([string]$FailureMessage, [scriptblock]$Command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command }
  finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { Fail $FailureMessage }
}

function Assert-HyperV {
  if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) {
    Fail 'Hyper-V PowerShell management tools are not installed.'
  }
  try { Get-VM -ErrorAction Stop | Out-Null }
  catch {
    Fail @'
This session cannot manage Hyper-V. Run from an Administrator PowerShell, or grant
standing access once (Administrator terminal, then sign out and back in):

  Add-LocalGroupMember -Group "Hyper-V Administrators" -Member "$env:USERNAME"
'@
  }
}

function Get-BakeSwitch {
  if ($env:MOS_HYPERV_SWITCH) {
    $configured = Get-VMSwitch -Name $env:MOS_HYPERV_SWITCH -ErrorAction SilentlyContinue
    if (-not $configured) { Fail "Hyper-V switch '$env:MOS_HYPERV_SWITCH' does not exist." }
    return $configured
  }
  $default = Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue
  if ($default) { return $default }
  $external = Get-VMSwitch | Where-Object SwitchType -eq 'External' | Select-Object -First 1
  if ($external) { return $external }
  Fail 'No Default Switch or external Hyper-V switch is available. Set MOS_HYPERV_SWITCH.'
}

function Remove-BakeVm([string]$Name) {
  $vm = Get-VM -Name $Name -ErrorAction SilentlyContinue
  if (-not $vm) { return }
  if ($vm.State -ne 'Off') { Stop-VM -Name $Name -TurnOff -Force }
  Remove-VM -Name $Name -Force
}

function Invoke-Seed {
  Say 'Rendering the bake seed.'
  New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null
  $env:MOS_IMAGE_REPO_REF = $RepoRef
  if ($DebugBake) { $env:MOS_IMAGE_BAKE_DEBUG = '1' } else { $env:MOS_IMAGE_BAKE_DEBUG = '0' }
  $renderer = Join-Path $PSScriptRoot 'render-bake-seed.cjs'
  Invoke-Native 'Seed rendering failed.' { & node $renderer }
}

function Invoke-Iso {
  if (-not (Test-Path (Join-Path $SeedDir 'user-data'))) { Fail 'No seed found. Run the seed stage first.' }
  Say 'Remastering the installer ISO around the bake seed.'
  Push-Location $RepoRoot
  try {
    # --auto-boot: the published ISO waits at the GRUB menu forever on purpose, so
    # a person choosing to erase their disk has to say so. Nobody is watching a bake.
    Invoke-Native 'ISO build failed.' {
      & npm run installer:usb -- --seed-dir $SeedDir --output-iso $IsoPath --auto-boot=true
    }
  }
  finally { Pop-Location }
}

function Invoke-Bake {
  Assert-HyperV
  if (-not (Test-Path $IsoPath)) { Fail 'No bake ISO found. Run the iso stage first.' }

  Remove-BakeVm $VmName
  foreach ($stale in @($BakeDiskPath, $VerifyDiskPath)) {
    if (Test-Path $stale) { Remove-Item $stale -Force }
  }

  $switch = Get-BakeSwitch
  Say "Creating the bake VM on switch '$($switch.Name)' with a ${DiskSizeGB} GB disk."
  New-VHD -Path $BakeDiskPath -SizeBytes ($DiskSizeGB * 1GB) -Dynamic | Out-Null

  New-VM -Name $VmName -Generation 2 -MemoryStartupBytes 2GB `
    -VHDPath $BakeDiskPath -SwitchName $switch.Name | Out-Null
  # Dynamic, so the bake still starts on a host that is already running other VMs
  # and grows into the headroom when there is any. `npm ci` is the peak.
  Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $true `
    -MinimumBytes 1GB -StartupBytes 2GB -MaximumBytes ($MemoryGB * 1GB)
  Set-VMProcessor -VMName $VmName -Count $Cpus
  Set-VM -Name $VmName -AutomaticCheckpointsEnabled $false
  Set-VMFirmware -VMName $VmName -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority
  $dvd = Add-VMDvdDrive -VMName $VmName -Path $IsoPath -Passthru
  $osDisk = Get-VMHardDiskDrive -VMName $VmName | Where-Object Path -eq $BakeDiskPath
  # Disk first: it is empty now so firmware falls through to the DVD, and once the
  # install lands the same order boots it without anyone ejecting the ISO.
  Set-VMFirmware -VMName $VmName -BootOrder $osDisk, $dvd

  Say 'Starting the bake. It installs Ubuntu, runs the MOS bootstrap, finalizes, then powers itself off.'
  Say "Watch it with: vmconnect.exe localhost $VmName"
  Start-VM -Name $VmName

  $started = Get-Date
  $deadline = $started.AddMinutes($BakeTimeoutMinutes)
  while ((Get-VM -Name $VmName).State -ne 'Off') {
    if ((Get-Date) -gt $deadline) {
      Fail "The bake did not finish within $BakeTimeoutMinutes minutes. Inspect it with: vmconnect.exe localhost $VmName"
    }
    Start-Sleep -Seconds 20
  }

  $minutes = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
  Remove-VM -Name $VmName -Force
  Say "The bake VM powered off after $minutes minutes. Run the convert stage to read what finalize recorded."
}

function Invoke-Verify {
  Assert-HyperV
  $imageName = "my-own-suite-$RepoRef.img"
  if (-not (Test-Path (Join-Path $OutputDir $imageName))) { Fail 'No image found. Run the convert stage first.' }

  Remove-BakeVm $VerifyVmName
  if (Test-Path $VerifyDiskPath) { Remove-Item $VerifyDiskPath -Force }

  # Converted from the published .img rather than from bake.vhdx, so this tests the
  # artifact after the filesystem shrink and GPT rewrite, which is where a
  # boot-breaking mistake would actually live.
  Say 'Converting the published image to a throwaway VHDX.'
  Invoke-Native 'Could not build the image tooling container.' {
    & docker build -t $ToolingImage $PSScriptRoot
  }
  Invoke-Native 'Could not convert the image for verification.' {
    & docker run --rm -v "${WorkRoot}:/work" $ToolingImage `
      qemu-img convert -f raw -O vhdx "/work/out/$imageName" /work/verify.vhdx
  }
  # Deliberately larger than the image, because that is the only realistic case:
  # nobody installs onto a disk exactly the size of the download. It also makes
  # this a real test of mos-grow-root rather than a boot with nothing to grow.
  Resize-VHD -Path $VerifyDiskPath -SizeBytes 40GB
  Say 'Booting it on a 40 GB disk.'

  $switch = Get-BakeSwitch
  New-VM -Name $VerifyVmName -Generation 2 -MemoryStartupBytes 4GB `
    -VHDPath $VerifyDiskPath -SwitchName $switch.Name | Out-Null
  Set-VMProcessor -VMName $VerifyVmName -Count 2
  Set-VM -Name $VerifyVmName -AutomaticCheckpointsEnabled $false
  Set-VMFirmware -VMName $VerifyVmName -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority
  Start-VM -Name $VerifyVmName

  Say 'Waiting for it to report an address (up to 5 minutes).'
  $deadline = (Get-Date).AddMinutes(5)
  $address = $null
  while ((Get-Date) -lt $deadline) {
    $address = (Get-VMNetworkAdapter -VMName $VerifyVmName).IPAddresses |
      Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
    if ($address) { break }
    Start-Sleep -Seconds 10
  }

  Say ''
  if ($address) {
    Say "It booted and took the address $address."
    Say "Open http://$address/suite-manager/ to confirm Suite Manager answers."
  }
  else {
    Say 'No address reported. Hyper-V only sees one if the guest runs the KVP daemon,'
    Say 'so this is not proof of failure. Look at the console instead:'
  }
  Say "  vmconnect.exe localhost $VerifyVmName"
}

function Invoke-Convert {
  if (-not (Test-Path $BakeDiskPath)) { Fail 'No baked disk found. Run the bake stage first.' }
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

  Say 'Building the image tooling container.'
  Invoke-Native 'Could not build the image tooling container.' {
    & docker build -t $ToolingImage $PSScriptRoot
  }

  $imageName = "my-own-suite-$RepoRef.img"
  Say 'Converting the baked disk to a raw image.'
  Invoke-Native 'Image conversion failed.' {
    & docker run --rm -v "${WorkRoot}:/work" $ToolingImage `
      extract-image.sh /work/bake.vhdx "/work/out/$imageName"
  }

  # Privileged only to attach a loop device for resize2fs.
  Say 'Shrinking to the actual contents and compressing.'
  Invoke-Native 'Image shrink failed.' {
    & docker run --rm --privileged -v "${WorkRoot}:/work" $ToolingImage `
      shrink-image.sh "/work/out/$imageName" $SlackMB
  }

  Say ''
  Say "Image ready: $(Join-Path $OutputDir $imageName)"
  Say ''
  Say 'Write it to a USB stick with balenaEtcher, boot the target machine from it,'
  Say 'and type YES when it asks which disk to erase.'
}

function Invoke-Inspect {
  $imageName = "my-own-suite-$RepoRef.img"
  if (-not (Test-Path (Join-Path $OutputDir $imageName))) { Fail 'No image found. Run the convert stage first.' }

  Invoke-Native 'Could not build the image tooling container.' {
    & docker build -t $ToolingImage $PSScriptRoot
  }
  # Privileged only to attach a loop device; the mount itself is read-only.
  Invoke-Native 'Inspection failed.' {
    & docker run --rm --privileged -v "${WorkRoot}:/work" $ToolingImage `
      inspect-image.sh "/work/out/$imageName"
  }
}

function Invoke-Clean {
  Assert-HyperV
  Remove-BakeVm $VmName
  Remove-BakeVm $VerifyVmName
  foreach ($path in @($BakeDiskPath, $VerifyDiskPath)) {
    if (Test-Path $path) { Remove-Item $path -Force }
  }
  Say 'Removed the bake and verify VMs and their disks. The built image is untouched.'
}

switch ($Stage) {
  'seed' { Invoke-Seed }
  'iso' { Invoke-Iso }
  'bake' { Invoke-Bake }
  'verify' { Invoke-Verify }
  'convert' { Invoke-Convert }
  'inspect' { Invoke-Inspect }
  'clean' { Invoke-Clean }
  'all' {
    Invoke-Seed
    Invoke-Iso
    Invoke-Bake
    Invoke-Convert
    Invoke-Verify
  }
}
