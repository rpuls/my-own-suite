param(
    [string]$SeedSource = ".\deploy\self-host\autoinstall\generated",
    [string]$DiskPath = ".\deploy\self-host\autoinstall\cidata.vhdx",
    [int]$SizeMB = 32
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $SeedSource)) {
    throw "Seed source folder not found: $SeedSource"
}

$userDataPath = Join-Path $SeedSource "user-data"
$metaDataPath = Join-Path $SeedSource "meta-data"

if (-not (Test-Path $userDataPath)) {
    throw "Missing user-data file in $SeedSource"
}

if (-not (Test-Path $metaDataPath)) {
    throw "Missing meta-data file in $SeedSource"
}

$resolvedDiskPath = [System.IO.Path]::GetFullPath($DiskPath)
$resolvedSeedSource = [System.IO.Path]::GetFullPath($SeedSource)

if (Test-Path $resolvedDiskPath) {
    Remove-Item -LiteralPath $resolvedDiskPath -Force
}

New-VHD -Path $resolvedDiskPath -Dynamic -SizeBytes ($SizeMB * 1MB) | Out-Null
$vhd = Mount-VHD -Path $resolvedDiskPath -Passthru

try {
    $disk = $vhd | Get-Disk
    Initialize-Disk -Number $disk.Number -PartitionStyle MBR | Out-Null
    $partition = New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter
    Format-Volume -Partition $partition -FileSystem FAT32 -NewFileSystemLabel CIDATA -Confirm:$false | Out-Null

    $driveLetter = ($partition | Get-Volume).DriveLetter
    if (-not $driveLetter) {
        throw "Failed to determine drive letter for the seed disk."
    }

    Copy-Item -LiteralPath $userDataPath -Destination "${driveLetter}:\user-data" -Force
    Copy-Item -LiteralPath $metaDataPath -Destination "${driveLetter}:\meta-data" -Force
}
finally {
    Dismount-VHD -Path $resolvedDiskPath
}

Write-Host "Created seed disk: $resolvedDiskPath"
Write-Host "Attach this VHDX to the VM as a second disk before booting the Ubuntu installer."
