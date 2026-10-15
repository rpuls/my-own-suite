# ACME responder

An own-hardware MOS box serves its Easy Door, `home.192-168-68-123.local.myownsuite.org`, with a
certificate every browser trusts. The box is on a LAN, so the CA cannot reach it and DNS-01 is the
only challenge left, which needs a TXT record at
`_acme-challenge.192-168-68-123.local.myownsuite.org`. The Easy Door zone holds no state and nothing
can write to it, so it answers that one name with a CNAME into this box's zone,
`192-168-68-123.acme.myownsuite.org`. This box holds the token there for ten minutes.

## What the box does

- **CoreDNS** is authoritative for `acme.myownsuite.org`, serving one zone file and reloading it
  within two seconds of a change. The apex carries an A record for the box itself, so the API name
  needs no record in the parent zone.
- **The responder** (`responder.cjs`, dependency-free Node) answers the acme-dns `/update` call that
  Caddy's stock `caddy-dns/acmedns` module makes, and writes the token into the zone file. The zone
  file is its only state; a rebuild loses only tokens that were minutes from expiring.
- **Caddy** (Ubuntu's package) terminates TLS for `https://acme.myownsuite.org` with HTTP-01.
- **nftables** caps DNS queries and new API connections per source.

```
POST /update   X-Api-User / X-Api-Key ignored
{ "subdomain": "192-168-68-123", "txt": "<43-char base64url token>" }
-> 200 { "txt": "<token>" }
```

`/register` does not exist. The name is shared by every box on that LAN address, so a credential
would prove nothing and would be state to back up and leak.

## Rules it enforces

| Rule | Why |
| --- | --- |
| `subdomain` is a dashed RFC1918 address, the same ranges as the Easy Door zone | The responder can never prove control of any other name |
| `txt` is exactly 43 base64url characters | The only value ACME asks for |
| Up to 8 live tokens per name, 10 minutes each, oldest evicted | Households on one LAN address renew independently and must not knock each other's token out |
| TXT TTL and negative TTL 30 s | A resolver never caches a stale answer past the next order |
| 20 updates per source per hour, 20,000 live tokens overall | A box makes a handful of calls per issuance |
| No request log | Not the source, the name or the token. The journal gets failures and hourly counts |

## Files

Everything is injected by cloud-init; a change here plus a rebuild is the only edit path.

| File | Lands at |
| --- | --- |
| `Corefile` | `/etc/coredns/Corefile` |
| `coredns.service` | `/etc/systemd/system/` |
| `responder.cjs`, `responder-core.cjs`, `../../shared/easy-door.cjs` | `/opt/mos-acme/` (same relative layout) |
| `mos-acme-responder.service` | `/etc/systemd/system/` |
| `Caddyfile` | `/etc/caddy/Caddyfile` |
| `nftables-ratelimit.conf` | `/etc/nftables.d/` |
| `verify.cjs` | run from a workstation |

## The two records in the parent zone

Added once, by hand, in Cloudflare, DNS only:

```
ns-acme.myownsuite.org   A    <reserved-ip>
acme.myownsuite.org      NS   ns-acme.myownsuite.org
```

## Where it runs

While MOS is in development it shares the nameserver's Droplet: `scripts/nameserver.cjs` sets
`SHARES_NAMESERVER_DROPLET` (in `scripts/acme-responder.cjs`) and adds this payload, both Corefiles run in one CoreDNS, and
`ns-acme.myownsuite.org` points at the nameserver's Reserved IP. The responder and its Caddy are
capped in CPU and memory (`mos-acme-responder.service`, `caddy-limits.conf`), so a flood of API
requests can slow certificate issuance but not the DNS every Easy Door depends on.

Splitting it onto a box of its own is a provisioning step, not a change to any install: apply it
below, re-point `ns-acme.myownsuite.org` at the new Reserved IP, set `SHARES_NAMESERVER_DROPLET` to
false and rebuild the nameserver. Tokens are minutes long, so nothing needs moving.

## Rebuild from scratch (once split out)

```bash
node scripts/acme-responder.cjs status
node scripts/acme-responder.cjs destroy    # keeps the reserved IP
node scripts/acme-responder.cjs plan
node scripts/acme-responder.cjs apply
node scripts/acme-responder.cjs verify
```

The provisioner shares its DigitalOcean plumbing with the nameserver (`scripts/droplet-box.cjs`).
On a rebuild it reclaims the parked Reserved IP that `ns-acme.myownsuite.org` already resolves to,
and never any other, because both boxes live in `ams3`. `s-1vcpu-1gb`, $6/mo.

Why split it eventually: the nameserver going down takes every Easy Door with it, while this one
going down only delays an issuance Caddy retries on its own. Sharing a box couples the two.

## Verifying

```bash
node infrastructure/acme-responder/verify.cjs <reserved-ip>              # the box itself
node infrastructure/acme-responder/verify.cjs 1.1.1.1 --via-resolver     # the whole CNAME chain
```

Each run posts one throwaway token for `192-168-255-254` and expects to read it back within seconds.
`--wait-expiry` also waits out its ten minutes.

### Testing a change before it ships

```bash
MOS_ACME_ZONE_FILE=/tmp/mos-acme/acme.myownsuite.org.zone MOS_ACME_APEX_ADDRESS=127.0.0.1 \
  node infrastructure/acme-responder/responder.cjs &
docker run -d --name mos-acme-test -p 127.0.0.1:15354:53/udp -p 127.0.0.1:15354:53/tcp \
  -v "$PWD/infrastructure/acme-responder/Corefile:/etc/coredns/Corefile:ro" \
  -v /tmp/mos-acme:/var/lib/mos-acme:ro coredns/coredns:1.14.6 -conf /etc/coredns/Corefile
node infrastructure/acme-responder/verify.cjs 127.0.0.1:15354 --api http://127.0.0.1:8053
```

## What it sees

Per issuance and renewal, a few times a year per box: the household's public IP (the TCP
connection) and the challenge token. It keeps neither. No owner email, no install id, no app
inventory. Let's Encrypt sees the same public IP for the same reason.
