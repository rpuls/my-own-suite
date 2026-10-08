import { useEffect, useState } from 'react';

import { jsonResponse, postJson } from '../../../lib/api';

// The suite's one recorded address: where apps and Homepage are published.
export type SuiteAddress = {
  acmeEmail?: string | null;
  baseDomain?: string | null;
  host: string;
  kind: 'domain' | 'easy-door' | 'lan-name';
  // Whether the name points at this machine right now; null when DNS could not
  // be asked, or for a door, which needs no DNS.
  resolvesHere: boolean | null;
  scheme: 'http' | 'https';
  url: string;
};

export type AppReconciliationResult = {
  errorCode?: string;
  homepage?: { errorCode?: string; status?: string };
  homepageEntryFailures?: Array<{ errorCode?: string; packageId: string; status: string }>;
  runtime?: Array<{ errorCode?: string; packageId: string; status: string }>;
  skipped?: boolean;
  status?: string;
};

// What the change in flight is doing right now: where the owner's DNS record
// stands, and which app is being rebuilt.
export type LiveProgress = {
  apps: { current: string | null; done: number; remainingSeconds: number | null; total: number } | null;
  dns: { checkedAt: string; pointsHere: boolean; sentence: string } | null;
};

export type AddressChange = {
  at: string | null;
  diagnostics: string | null;
  errorCode: string | null;
  live: LiveProgress;
  result: AppReconciliationResult | null;
  stage: string | null;
  stages: string[];
  status: 'applied' | 'applying' | 'failed' | 'never';
  target: { host: string; kind: string; scheme: string } | null;
};

export type AddressStatus = {
  address: SuiteAddress;
  agentAvailable: boolean;
  appsToRebuild: string[];
  bootstrapUrl: string;
  // The recorded Easy Door name no longer matches the live one: the machine's
  // address moved under it.
  drifted: { from: string; to: string } | null;
  // The trusted certificate for the Easy Door. `log` is Caddy's own lines about
  // it while it has not arrived, for the technical panel only.
  easyDoorCertificate: { host: string | null; log: string[]; notAfter: string | null; state: 'held' | 'not-applicable' | 'pending' };
  easyDoorUrl: string | null;
  installContext: string;
  lastChange: AddressChange;
  // The domain a restored backup was set up for, waiting to be served here.
  offered: { acmeEmail: string | null; baseDomain: string } | null;
  serverAddress: string | null;
  track: 'home-server' | 'public-server';
};

// Where a poll of the address status ended. Signed out and refused are answers;
// unreachable is the web server restarting under this connection.
export type Contact = 'ok' | 'refused' | 'signed-out' | 'unreachable';

export const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

export function normalizeDomain(value: string) {
  return value.trim().toLowerCase().replace(/\.$/u, '');
}

// Reading the address and moving it, the same on both tracks; only the forms
// that build a change differ.
export function useSuiteAddress() {
  const [status, setStatus] = useState<AddressStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [contact, setContact] = useState<Contact>('ok');
  const [busy, setBusy] = useState<'' | 'cancel' | 'change' | 'dismiss'>('');
  const [error, setError] = useState('');
  // The change this screen started, so its outcome is shown once and the
  // history of an earlier one is not mistaken for it.
  const [startedAt, setStartedAt] = useState<string | null>(null);

  // One read of the address status, and the screen is told where it ended:
  // signed out, refused at this address, unreachable, or answered. A domain
  // change restarts the web server under this connection, so a poll that fails
  // is expected for a while and is never rendered as anything it did not see.
  async function load(): Promise<AddressStatus | null> {
    let response: Response;
    try {
      response = await fetch('/suite-manager/api/settings/address', { cache: 'no-store' });
    } catch {
      setContact('unreachable');
      return null;
    }
    if (response.status === 401) { setContact('signed-out'); return null; }
    if (response.status === 421) { setContact('refused'); return null; }
    if (!response.ok) {
      setContact('unreachable');
      if (!status) setLoadError((await response.json().catch(() => ({}))).error || 'Unable to load the suite address.');
      return null;
    }
    const next = await jsonResponse<AddressStatus>(response, 'Unable to load the suite address.');
    setContact('ok');
    setLoadError('');
    setStatus(next);
    return next;
  }

  useEffect(() => { void load(); }, []);

  const applying = status?.lastChange.status === 'applying';
  // While a change runs the screen polls, through whatever the web server
  // answers on, until the change has an outcome.
  useEffect(() => {
    if (!applying && contact !== 'unreachable') return undefined;
    const timer = window.setInterval(() => { void load(); }, 2000);
    return () => window.clearInterval(timer);
  }, [applying, contact]);

  // Every way of moving the suite is the same request with a different body,
  // and every one of them is answered before it finishes.
  async function startChange(body: Record<string, unknown>): Promise<boolean> {
    setError('');
    setBusy('change');
    try {
      const started = await postJson<{ startedAt: string }>('/suite-manager/api/settings/address/change', body, 'The address could not be changed.');
      setStartedAt(started.startedAt);
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The address could not be changed.');
      return false;
    } finally {
      setBusy('');
    }
  }

  async function postAction(path: string, kind: 'cancel' | 'dismiss', failure: string) {
    setError('');
    setBusy(kind);
    try {
      await jsonResponse(await fetch(path, { method: 'POST' }), failure);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failure);
    } finally {
      setBusy('');
    }
  }

  const cancelChange = () => postAction('/suite-manager/api/settings/address/change/cancel', 'cancel', 'The move could not be cancelled.');
  const dismissOffer = () => postAction('/suite-manager/api/settings/address/offer/dismiss', 'dismiss', 'The offer could not be dismissed.');

  const change = status?.lastChange;
  // The outcome of the change this screen started, shown until the next one.
  const outcome = change && startedAt && change.at && change.at >= startedAt && change.status !== 'applying' ? change : null;

  return { applying, busy, cancelChange, contact, dismissOffer, error, loadError, outcome, setError, startChange, status };
}

export type SuiteAddressController = ReturnType<typeof useSuiteAddress>;
