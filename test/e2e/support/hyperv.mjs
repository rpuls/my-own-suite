import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

// The guest's address as the host knows it: what the guest's integration service
// reports first, then what the switch has seen from the adapter's MAC.
export async function vmAddress(name) {
  const script = `$adapter = Get-VMNetworkAdapter -VMName '${name.replaceAll("'", "''")}' | Select-Object -First 1
$mac = $adapter.MacAddress -replace '(..)(?!$)', '$1-'
$seen = Get-NetNeighbor -LinkLayerAddress $mac -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Unreachable' } | ForEach-Object { $_.IPAddress }
(@($adapter.IPAddresses) + @($seen)) -join ' '`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
  return stdout.split(/\s+/u).find((item) => IPV4.test(item)) || null;
}
