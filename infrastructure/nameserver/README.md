# Easy Door nameserver

MOS serves each app on its own subdomain, which is a browser-origin isolation boundary. On an
ordinary LAN nothing resolves those names, so an owner who finishes an install has no way in unless
they run their own resolver. This box is the second door: a public authoritative nameserver that
answers queries for names encoding the server's **LAN** address, so
`seafile.192-168-123-45.local.myownsuite.org` resolves to `192.168.123.45` on any device with no
configuration by the owner.

The first door — one wildcard `*.mos.home` rule in the owner's own Pi-hole, AdGuard, Unbound or
OpenWRT — does not involve this box, does not depend on it, and keeps working if it disappears.

## What the box actually does

It runs one stateless process. There is no database, no API, no zone-editing token, and nothing on
it ever writes. Given a query name, the address is already in the name; the server does string
matching and returns it. Two consequences follow, and both are the point:

- Rebuilding it is recreating it. There is nothing to back up and nothing to restore.
- A second node is a byte-identical copy. No zone transfers, no replication, no shared state.

**Only RFC1918 addresses are answered.** `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16` resolve;
every other encoded address is NXDOMAIN. This is not tidiness, it is the security control. Software
in this category (sslip.io and its imitators) resolves *any* encoded address, which under a brand
domain is an open redirector: an attacker hosts a phishing page on their own public server and hands
out `login.203-0-113-9.local.myownsuite.org`, a URL that reads as `myownsuite.org` and survives the
"does this domain look right?" check a careful person makes. Restricting to private space removes
the vector, because an attacker would need the victim already on their LAN, where they have better
options anyway.

Queries for names outside the zone are REFUSED. This is authoritative-only and is not a resolver.

## Why CoreDNS rather than sslip.io

sslip.io is purpose-built for exactly this and would otherwise win. It loses on the paragraph above:
it resolves any encoded address by design, so the RFC1918 restriction means forking and maintaining
Go code — which is the cost the whole stateless approach was chosen to avoid. In CoreDNS the same
restriction is three regexes in a config file, reviewable by anyone who can read a regex.

CoreDNS also brings `bufsize 512` and the RFC 8482 `any` plugin, which together are most of the
amplification hardening, and a metrics endpoint for the day abuse becomes a question.

## Files

Everything that decides the box's behaviour is here and is injected at create time by cloud-init.
Nothing is configured by hand on the server; a change here plus a rebuild is the only edit path.

| File | Lands at | Purpose |
| --- | --- | --- |
| `Corefile` | `/etc/coredns/Corefile` | The zone, the RFC1918 match, the answer synthesis |
| `zones/local.myownsuite.org.zone` | `/etc/coredns/zones/` | Apex SOA/NS, and the SOA that makes NXDOMAIN negative-cacheable |
| `coredns.service` | `/etc/systemd/system/` | Unprivileged unit, `CAP_NET_BIND_SERVICE` only |
| `nftables-ratelimit.conf` | `/etc/nftables.d/` | Per-source rate limits |
| `verify.cjs` | — | The acceptance checks, run from a workstation |

The provisioner is `scripts/nameserver.cjs`; run it with no arguments for the command list.
`node scripts/nameserver.cjs render` prints the exact cloud-init payload without touching the API or
creating anything.

## The two records in the parent zone

`myownsuite.org` is on Cloudflare. The delegated zone needs exactly these, added once, by hand, both
DNS-only (grey cloud — proxying a nameserver is meaningless):

```
ns1.myownsuite.org      A    <reserved-ip>
local.myownsuite.org    NS   ns1.myownsuite.org
```

The nameserver is named in the **parent** zone, not inside the zone it serves. `ns1.myownsuite.org`
is correct and `ns1.local.myownsuite.org` is not: a nameserver whose own name lives inside its own
zone is a circular dependency that has to be broken with glue records, and keeping it in the parent
avoids the problem rather than managing it.

Nothing writes to the Cloudflare zone again, by any automation, ever. That is why no MOS component
holds a DNS-editing token for it.

## Rebuild from scratch

This is the scenario the box is designed for. The Reserved IP is what makes it cheap: it stays
allocated when the Droplet is destroyed, so the NS record in Cloudflare never changes and there is no
propagation to wait out.

```bash
node scripts/nameserver.cjs status     # what exists now
node scripts/nameserver.cjs destroy    # deletes droplet and firewall, keeps the reserved IP
node scripts/nameserver.cjs plan       # what apply would create, and what it costs
node scripts/nameserver.cjs apply      # recreates, then reattaches the same reserved IP
node scripts/nameserver.cjs verify     # acceptance checks against the live address
```

`apply` is idempotent and finds existing resources by the `mos-nameserver` tag, so running it after a
partial failure completes the missing pieces rather than duplicating anything. It waits for the
Droplet to get networking, then reattaches the Reserved IP. cloud-init takes a few minutes after
that; `verify` is the signal that it finished.

A Reserved IP is free while it is assigned to a Droplet. Unassigned it costs $5.00/month
($0.01/hour), so destroying the Droplet and leaving the address parked for weeks is a real if small
cost — a rebuild is a free hold only when it is prompt.

Provisioning reads `DIGITALOCEAN_ACCESS_TOKEN` from the environment, or from `.mos-nameserver.env`,
or from the existing `.mos-smoke/digitalocean.env`. All three are git-ignored.

### Settings the provisioner uses

`s-1vcpu-1gb` ($6/mo) in `ams3` on `ubuntu-24-04-x64`. The $4/512 MB tier is deliberately not used:
this gates user access, and 512 MB is tight for Ubuntu with unattended-upgrades running. The region
is EU jurisdiction and close to home, which fits the privacy posture.

The DO Cloud Firewall allows UDP/53 and TCP/53 from anywhere and SSH only from the address the
provisioner detected when it ran.

On a dynamic ISP address that rule goes stale, which is expected and is not a lockout. SSH is
key-only — the Droplet was created with an SSH key and never had password authentication — so the
firewall is a second layer, not the authentication. When you need a shell and the rule has aged out:

```bash
node scripts/nameserver.cjs ssh-open
```

That re-detects where you are and rewrites the rule. It talks to the DigitalOcean API rather than the
box, so it works no matter how stale the rule is, and DigitalOcean's recovery console bypasses the
firewall entirely as a last resort. Set `MOS_NS_SSH_SOURCE` only if you ever have a fixed address.

## Verifying

```bash
node infrastructure/nameserver/verify.cjs <reserved-ip>              # the box itself
node infrastructure/nameserver/verify.cjs 1.1.1.1 --via-resolver     # the public delegation
```

The checks cover the encoded address resolving under any app label, every RFC1918 range including
both edges of `172.16/12`, public addresses returning NXDOMAIN, a name that exists returning NODATA
rather than NXDOMAIN for AAAA, the apex SOA, and recursion being refused. The equivalent with `dig`:

```bash
dig @<reserved-ip> seafile.192-168-123-45.local.myownsuite.org +short   # -> 192.168.123.45
dig @<reserved-ip> login.203-0-113-9.local.myownsuite.org +short      # must be empty
dig @<reserved-ip> google.com                                         # must be REFUSED
```

### Testing a config change before it ships

Run the real CoreDNS against the real files first. This catches a broken regex on a laptop instead of
on the box that gates user access:

```bash
docker run -d --name mos-ns-test -p 127.0.0.1:15353:53/udp -p 127.0.0.1:15353:53/tcp \
  -v "$PWD/infrastructure/nameserver:/etc/coredns:ro" \
  coredns/coredns:1.14.6 -conf /etc/coredns/Corefile

node infrastructure/nameserver/verify.cjs 127.0.0.1:15353
docker rm -f mos-ns-test
```

Port 5353 is reserved by Windows, hence 15353.

## Operating it

**Updating CoreDNS.** The binary is pinned by version and SHA-256 in `scripts/nameserver.cjs` and is
not managed by apt, so `unattended-upgrades` will never move it. Bump both constants, then rebuild.
The OS itself does patch automatically.

**Reboots are manual.** `Unattended-Upgrade::Automatic-Reboot` is off. While this is the only
nameserver, an unattended 4am reboot is an outage for every owner using this door. That inverts once
a second node exists.

**Watch the bandwidth, not the uptime.** Anything answering on UDP/53 is a reflection target.
Included transfer is 1 TB and overage is about $0.01/GB, so abuse arrives as a bill rather than an
outage. Set a DigitalOcean bandwidth alert on the Droplet; that alert is how you find out.

Amplification is already capped: answers are one A record, `bufsize 512` prevents large EDNS0
responses, `any` answers QTYPE=ANY minimally, and nftables caps requests per source address.
Per-source limiting is the right shape here because reflection spoofs the *victim's* address as the
source, so the cap bounds what this box can be made to send at any one target. CoreDNS has no
response-rate-limiting plugin in a stock build; if that stops being enough, the upgrade is a custom
build with the external `rrl` plugin.

**Query logging is off, and that is a commitment, not a default.** The `log` plugin is deliberately
absent. Because every app is a distinct name, query logs would reveal which apps an install runs and
when — see the limitation below. `errors` logs failures only, and the Prometheus endpoint on
`127.0.0.1:9153` carries counts by zone, type and rcode, never names.

## Adding a second nameserver

Purely additive. No install and no URL ever changes:

```
ns2.myownsuite.org      A    <reserved-ip-2>
local.myownsuite.org    NS   ns2.myownsuite.org
```

Resolvers use both and fail over on their own. Put it in a **different region** — `ams3` plus `fra1`
— because two Droplets in one region survive a dead Droplet, not a dead region, and an outage here
means owners cannot reach their own suite. Run `apply` with `MOS_NS_NAME=mos-ns2` and
`MOS_NS_REGION=fra1`; it is the same payload from the same files.

One nameserver is acceptable for beta because this is a subdomain delegation MOS controls, not a
registrar delegation, so the two-nameserver minimum does not apply.

## Known limitations

These are documented rather than fixed, and each has a home elsewhere in the roadmap.

**DNS-rebinding protection refuses these answers.** Fritz!Box, OpenWRT, pfSense, Pi-hole and AdGuard
ship it on, and it exists precisely to stop public names resolving into private space. Mostly it hits
owners who would take the first door anyway; Fritz!Box is the painful exception. The success screen
needs a diagnostic that detects the failure and offers the other door, rather than showing a dead
link.

Measured on the maintainer's own network the day the zone went live, and worth repeating elsewhere
before anything depends on it. The gateway resolves ordinary names and returns this zone's SOA, so it
reaches the nameserver fine — it just strips the A record pointing into private space. A phone on the
same wifi loaded `http://<lan-ip>:8080` instantly and failed on the identical URL by name, which
isolates the failure to the lookup and nothing else. That network is the hostile case rather than the
typical one, so the sample says the failure is real, not how common it is.

**Whether it works differs per device on one network, so the check cannot run on the server.** On the
same phone, two browsers disagreed — one resolved the name and one did not, most likely because
iCloud Private Relay routes lookups away from the router. Android's Private DNS does the same. So MOS
cannot test reachability once on the box and report a verdict; the probe has to run in the browser
the owner is actually holding.

**The name encodes the LAN IP, so a DHCP change breaks every saved bookmark.** A DHCP reservation has
to be a step in the flow, not advice at the end of it. Worth having MOS notice its own address
changed and surface the new URL on the console and in Suite Manager.

**Query metadata reveals the app inventory.** Every distinct app subdomain is queried separately, so
whoever operates this zone can see which apps an install runs and roughly when they are used. This
cannot be engineered away while public DNS is the mechanism. The answer is the no-log commitment
above, stated in the privacy policy and in the sovereignty document.

**No HTTPS yet, and that is not a regression.** Own-hardware installs serve plain HTTP at
`home.mos.home` today. Two things stand in the way, and the second is the harder one. Certificates
need a Public Suffix List entry to escape Let's Encrypt's 50-certificates-per-registered-domain
limit, and the PSL guidelines explicitly decline beta-stage projects. And a LAN box is not publicly
reachable, so HTTP-01 and TLS-ALPN-01 cannot work and DNS-01 is the only challenge left — but DNS-01
writes a `_acme-challenge` TXT record, and this zone is stateless by design with no writable path and
no credential that could edit it. Certificates therefore need something that holds per-install
challenge state: either a full registry, or an `acme-dns`-style responder whose only job is TXT
challenges under per-install credentials. Deliberately out of scope here; tracked in **H8**.
