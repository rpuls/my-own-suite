const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Hyper-V USB smoke exposes a guarded two-command lifecycle', () => {
  const packageJson = require('../package.json');
  const hypervScripts = Object.keys(packageJson.scripts).filter((name) => name.startsWith('smoke:hyperv:'));
  assert.deepEqual(hypervScripts.sort(), ['smoke:hyperv:destroy', 'smoke:hyperv:reset']);

  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke', 'hyperv-usb-lab.ps1'), 'utf8');
  assert.match(script, /\[ValidateSet\('reset', 'destroy'\)\]/u);
  assert.match(script, /\$VmName = 'mos-v2-usb-smoke'/u);
  assert.match(script, /New-VHD .* -Dynamic -SizeBytes 64GB/u);
  assert.match(script, /\$BackupDiskPath = Join-Path \$LabRoot 'backup\.vhdx'/u);
  assert.match(script, /MOS_V2_HYPERV_BACKUP_DISK_GB/u);
  assert.match(script, /New-VHD -Path \$BackupDiskPath -Dynamic -SizeBytes \(Get-BackupDiskSizeBytes\)/u);
  assert.match(script, /New-VM .* -Generation 2/u);
  assert.match(script, /Add-VMHardDiskDrive -VMName \$VmName -Path \$BackupDiskPath/u);
  assert.match(script, /Add-VMDvdDrive .* -Path \$IsoPath -Passthru/u);
  assert.match(script, /Set-VMFirmware .* -BootOrder \$osDisk, \$dvd/u);
  assert.match(script, /Start-VM -Name \$VmName/u);
  assert.match(script, /Wait-ForSuiteManager/u);
  assert.match(script, /Get-NetNeighbor -AddressFamily IPv4/u);
  assert.match(script, /LinkLayerAddress/u);
  assert.match(script, /\$adapter\.MacAddress/u);
  assert.match(script, /# BEGIN MOS V2 HYPERV USB SMOKE/u);
  assert.match(script, /Get-SmokeHostNames/u);
  assert.match(script, /manifest\.json/u);
  assert.match(script, /ConvertFrom-Json/u);
  assert.match(script, /\$Ip \$_/u);
  assert.match(script, /App hosts:/u);
  assert.match(script, /Backup:/u);
  assert.match(script, /Set-SmokeHostsEntries -Ip \$ip -StackDomain \$stackDomain/u);
  assert.match(script, /Remove-SmokeHostsEntries/u);
  assert.match(script, /ipconfig\.exe \/flushdns/u);
  assert.match(script, /home\.\$StackDomain/u);
  assert.match(script, /\/suite-manager\/api\/setup\/status/u);
  assert.ok(script.indexOf('Remove-LabVm') < script.indexOf('Build-InstallerIso'));
  assert.ok(script.indexOf('Build-InstallerIso') < script.indexOf('New-VM -Name $VmName'));
  assert.ok(script.indexOf('Add-VMDvdDrive') < script.indexOf('Start-VM -Name $VmName'));
  assert.doesNotMatch(script, /Get-VM\s*\|/u);

  const builder = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke', 'build-hyperv-usb-iso.cjs'), 'utf8');
  assert.match(builder, /const smokeRepoRef = 'feat\/app-platform-v2-lab'/u);
  assert.match(builder, /render-hyperv-usb-seed\.cjs/u);
  assert.match(builder, /'--seed-dir', seedDir/u);
  assert.match(builder, /'--auto-boot', 'true'/u);

  const rootBuilder = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'selfhost-build-installer-iso.cjs'), 'utf8');
  const remaster = fs.readFileSync(path.join(__dirname, '..', '..', 'deploy', 'self-host', 'iso-builder', 'remaster-iso.sh'), 'utf8');
  assert.match(rootBuilder, /readArg\('auto-boot', 'false'\)/u);
  assert.match(rootBuilder, /readArg\('seed-dir'\)/u);
  assert.match(rootBuilder, /MOS_INSTALLER_AUTO_BOOT=\$\{autoBoot \? '1' : '0'\}/u);
  assert.match(remaster, /timeout = "3" if os\.environ\.get\("MOS_INSTALLER_AUTO_BOOT"\) == "1" else "-1"/u);
});
