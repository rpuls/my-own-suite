param(
  [Parameter(Position = 0)]
  [ValidateSet('up', 'reset', 'destroy', 'render')]
  [string]$Command = 'render'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$V2Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$SmokeRoot = Join-Path $V2Root '.mos-smoke\hyperv'
$CacheRoot = Join-Path $V2Root '.mos-smoke\cache'
$StatePath = Join-Path $SmokeRoot 'state.json'
$VmName = 'mos-v2-smoke'
$ImageName = 'ubuntu-24.04-server-cloudimg-amd64-azure.vhd.tar.gz'
$ImageUrl = "https://cloud-images.ubuntu.com/releases/24.04/release-20260615/$ImageName"
$ImageSha256 = '99e8fc9be8fe4f805a1ca06349b21377f8d79ef8c02c44f89515ef6557b449b1'
$ArchivePath = Join-Path $CacheRoot $ImageName
$BaseDiskPath = Join-Path $CacheRoot 'ubuntu-24.04-hyperv-base.vhdx'
$DiskPath = Join-Path $SmokeRoot 'mos-v2-smoke.vhdx'
$SeedPath = Join-Path $SmokeRoot 'cidata.vhdx'

function Fail([string]$Message) {
  throw "[mos-v2-smoke:hyperv] $Message"
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-HyperV {
  if (-not (Test-Administrator)) {
    Fail 'Run this command from an Administrator PowerShell terminal.'
  }
  if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) {
    Fail 'Hyper-V PowerShell management tools are not installed.'
  }
}

function Get-SmokeSwitch {
  $requested = [Environment]::GetEnvironmentVariable('MOS_V2_HYPERV_SWITCH')
  if ($requested) {
    $switch = Get-VMSwitch -Name $requested -ErrorAction SilentlyContinue
    if (-not $switch) { Fail "Hyper-V switch '$requested' does not exist." }
    return $switch
  }
  $default = Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue
  if ($default) { return $default }
  $external = Get-VMSwitch | Where-Object SwitchType -eq 'External' | Select-Object -First 1
  if ($external) { return $external }
  Fail 'No Default Switch or external Hyper-V switch is available. Set MOS_V2_HYPERV_SWITCH to an existing switch.'
}

function Get-BaseVhd {
  New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
  if (Test-Path -LiteralPath $BaseDiskPath) { return $BaseDiskPath }

  if (-not (Test-Path -LiteralPath $ArchivePath)) {
    Write-Host "[mos-v2-smoke:hyperv] Downloading the pinned Ubuntu 24.04 cloud VHD (574 MB)..."
    & curl.exe -fL --retry 3 --output $ArchivePath $ImageUrl
    if ($LASTEXITCODE -ne 0) { Fail 'Ubuntu cloud image download failed.' }
  }

  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant()
  if ($actualHash -ne $ImageSha256) {
    Fail "Ubuntu cloud image checksum mismatch. Remove '$ArchivePath' and retry."
  }

  $extracted = Get-ChildItem -LiteralPath $CacheRoot -Filter '*.vhd' -File | Select-Object -First 1
  if (-not $extracted) {
    Write-Host '[mos-v2-smoke:hyperv] Extracting the Ubuntu cloud VHD...'
    & tar.exe -xzf $ArchivePath -C $CacheRoot
    if ($LASTEXITCODE -ne 0) { Fail 'Ubuntu cloud image extraction failed.' }
    $extracted = Get-ChildItem -LiteralPath $CacheRoot -Filter '*.vhd' -File | Select-Object -First 1
  }
  if (-not $extracted) { Fail 'The Ubuntu archive did not contain a VHD.' }

  Write-Host '[mos-v2-smoke:hyperv] Normalizing the fixed VHD and creating the reusable dynamic base...'
  $materializedPath = Join-Path $CacheRoot 'ubuntu-24.04-materialized.vhd'
  if (Test-Path -LiteralPath $materializedPath) { Remove-Item -LiteralPath $materializedPath -Force }
  $source = [IO.File]::Open($extracted.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $target = [IO.File]::Open($materializedPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $source.CopyTo($target, 8MB) }
    finally { $target.Dispose() }
  }
  finally { $source.Dispose() }
  Convert-VHD -Path $materializedPath -DestinationPath $BaseDiskPath -VHDType Dynamic
  Remove-Item -LiteralPath $extracted.FullName -Force
  Remove-Item -LiteralPath $materializedPath -Force
  (Get-Item -LiteralPath $BaseDiskPath).IsReadOnly = $true
  return $BaseDiskPath
}

function New-SeedDisk {
  param([string]$UserData)

  $seedSource = Join-Path $SmokeRoot 'seed'
  New-Item -ItemType Directory -Force -Path $seedSource | Out-Null
  [IO.File]::WriteAllText((Join-Path $seedSource 'user-data'), $UserData, [Text.UTF8Encoding]::new($false))
  Set-Content -LiteralPath (Join-Path $seedSource 'meta-data') -Value "instance-id: $([guid]::NewGuid())`nlocal-hostname: mos-v2-smoke`n" -Encoding ascii
  if (Test-Path -LiteralPath $SeedPath) { Remove-Item -LiteralPath $SeedPath -Force }

  New-VHD -Path $SeedPath -Dynamic -SizeBytes 64MB | Out-Null
  $mounted = Mount-VHD -Path $SeedPath -Passthru
  try {
    $disk = $mounted | Get-Disk
    Initialize-Disk -Number $disk.Number -PartitionStyle MBR | Out-Null
    $partition = New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter
    Format-Volume -Partition $partition -FileSystem FAT32 -NewFileSystemLabel CIDATA -Confirm:$false | Out-Null
    $drive = ($partition | Get-Volume).DriveLetter
    Copy-Item -LiteralPath (Join-Path $seedSource 'user-data') -Destination "${drive}:\user-data" -Force
    Copy-Item -LiteralPath (Join-Path $seedSource 'meta-data') -Destination "${drive}:\meta-data" -Force
  }
  finally {
    Dismount-VHD -Path $SeedPath
  }
}

function Remove-SmokeVm {
  $vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
  if ($vm) {
    if ($vm.State -ne 'Off') { Stop-VM -Name $VmName -TurnOff -Force }
    Remove-VM -Name $VmName -Force
  }
  foreach ($path in @($DiskPath, $SeedPath, $StatePath)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  }
  $seedSource = Join-Path $SmokeRoot 'seed'
  if (Test-Path -LiteralPath $seedSource) { Remove-Item -LiteralPath $seedSource -Recurse -Force }
}

function Get-GuestIpv4 {
  $addresses = (Get-VMNetworkAdapter -VMName $VmName).IPAddresses
  return $addresses | Where-Object { $_ -match '^\d{1,3}(?:\.\d{1,3}){3}$' -and $_ -notmatch '^169\.254\.' } | Select-Object -First 1
}

function Wait-ForReady {
  $deadline = (Get-Date).AddMinutes(30)
  while ((Get-Date) -lt $deadline) {
    $ip = Get-GuestIpv4
    if ($ip) {
      $hostName = "home.$ip.sslip.io"
      $statusUrl = "http://$hostName/suite-manager/api/setup/status"
      $previousErrorAction = $ErrorActionPreference
      try {
        $ErrorActionPreference = 'SilentlyContinue'
        $body = & curl.exe -fsS --max-time 5 --resolve "${hostName}:80:$ip" $statusUrl 2>$null
        $curlExitCode = $LASTEXITCODE
      }
      finally { $ErrorActionPreference = $previousErrorAction }
      if ($curlExitCode -eq 0) {
        try {
          $status = $body | ConvertFrom-Json
          if ($status.status -in @('needs-owner', 'signed-out')) {
            return [pscustomobject]@{ Ip = $ip; HomeUrl = "http://$hostName/"; SuiteManagerUrl = "http://$hostName/suite-manager/" }
          }
        }
        catch {}
      }
    }
    Write-Host '[mos-v2-smoke:hyperv] Waiting for VM networking and Suite Manager readiness...'
    Start-Sleep -Seconds 10
  }
  Fail 'Timed out waiting for the Hyper-V VM. Use Hyper-V Manager to inspect its console and cloud-init status.'
}

function Show-Summary($State) {
  Write-Host ""
  Write-Host '[mos-v2-smoke:hyperv] Hyper-V VM is ready.'
  Write-Host "  MOS Home:      $($State.homeUrl)"
  Write-Host "  Suite Manager: $($State.suiteManagerUrl)"
  Write-Host "  VM:            $($State.vmName)"
}

function Start-SmokeVm {
  Assert-HyperV
  $repoUrl = if ($env:MOS_V2_HYPERV_REPO_URL) { $env:MOS_V2_HYPERV_REPO_URL } else { 'https://github.com/rpuls/my-own-suite.git' }
  $repoRef = if ($env:MOS_V2_HYPERV_REPO_REF) { $env:MOS_V2_HYPERV_REPO_REF } else { 'feat/app-platform-v2-lab' }
  $existing = Get-VM -Name $VmName -ErrorAction SilentlyContinue
  if ($existing) {
    if (Test-Path -LiteralPath $StatePath) {
      Fail "VM '$VmName' already exists and is ready. Run smoke:hyperv:reset or smoke:hyperv:destroy."
    }
    Write-Host "[mos-v2-smoke:hyperv] Resuming readiness checks for incomplete VM '$VmName'..."
    if ($existing.State -eq 'Off') { Start-VM -Name $VmName | Out-Null }
    $ready = Wait-ForReady
    $switchName = (Get-VMNetworkAdapter -VMName $VmName).SwitchName
    $state = [ordered]@{
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
      homeUrl = $ready.HomeUrl
      ip = $ready.Ip
      repoRef = $repoRef
      repoUrl = $repoUrl
      suiteManagerUrl = $ready.SuiteManagerUrl
      switchName = $switchName
      vmName = $VmName
    }
    $state | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
    Show-Summary $state
    return
  }

  New-Item -ItemType Directory -Force -Path $SmokeRoot | Out-Null
  $switch = Get-SmokeSwitch
  $baseVhd = Get-BaseVhd
  $renderer = Join-Path $V2Root 'scripts\installers\render-bootstrap.cjs'
  $userData = & node $renderer --target cloud-init --front-door hyperv-smoke --repo-url $repoUrl --repo-ref $repoRef
  if ($LASTEXITCODE -ne 0) { Fail 'V2 cloud-init rendering failed.' }
  New-SeedDisk -UserData ($userData -join "`n")

  New-VHD -Path $DiskPath -ParentPath $baseVhd -Differencing | Out-Null
  New-VM -Name $VmName -Generation 2 -MemoryStartupBytes 2GB -VHDPath $DiskPath -SwitchName $switch.Name | Out-Null
  Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $true -MinimumBytes 1536MB -StartupBytes 2GB -MaximumBytes 4GB -Buffer 20
  Set-VMProcessor -VMName $VmName -Count 2
  Set-VMFirmware -VMName $VmName -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority
  Add-VMHardDiskDrive -VMName $VmName -ControllerType SCSI -Path $SeedPath
  Start-VM -Name $VmName | Out-Null

  $ready = Wait-ForReady
  $state = [ordered]@{
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    homeUrl = $ready.HomeUrl
    ip = $ready.Ip
    repoRef = $repoRef
    repoUrl = $repoUrl
    suiteManagerUrl = $ready.SuiteManagerUrl
    switchName = $switch.Name
    vmName = $VmName
  }
  $state | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
  Show-Summary $state
}

if ($Command -eq 'render') {
  [ordered]@{
    imageSha256 = $ImageSha256
    imageUrl = $ImageUrl
    note = 'Render-only Hyper-V smoke plan. No image was downloaded and no VM was changed.'
    statePath = $StatePath
    vmName = $VmName
  } | ConvertTo-Json
  exit 0
}

Assert-HyperV
if ($Command -eq 'destroy') {
  Remove-SmokeVm
  Write-Host '[mos-v2-smoke:hyperv] Destroy complete. The cached Ubuntu base image was retained.'
  exit 0
}
if ($Command -eq 'reset') { Remove-SmokeVm }
Start-SmokeVm
