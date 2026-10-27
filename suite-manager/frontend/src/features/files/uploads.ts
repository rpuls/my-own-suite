// Adding files from the browser, one chunk per request, each counted once the drive
// has it. A cut connection, a reload or a drive needing a check all end the same
// way: ask where the drive has the file, and carry on from there.

import { useCallback, useEffect, useRef, useState } from 'react';

import { uploadsApi } from './model';

export type UploadStatus = 'added' | 'failed' | 'sending' | 'waiting';
export type UploadItem = { driveId: string; error: string; file: File; folder: string; folderName: string; key: string; sent: number; speed: number | null; status: UploadStatus };
// What the queue is waiting on, if anything, which the screen says in a card.
export type Interruption = 'away' | 'connection' | 'read-only' | null;

type Answer = { code?: string; details?: string[]; error?: string };
type Begun = { chunkBytes: number; offset: number; uploadId: string };

class UploadFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter = 0) {
    super(message);
  }
}

const PAUSING_CODES = new Set(['FILES_DRIVE_READ_ONLY', 'FILES_DRIVE_AWAY', 'FILES_NOT_BROWSABLE', 'FILES_DRIVE_NOT_FOUND', 'APP_AGENT_UNAVAILABLE']);
const RESTARTING_CODES = new Set(['FILES_UPLOAD_OFFSET', 'FILES_UPLOAD_GONE', 'FILES_UPLOAD_INCOMPLETE']);
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000];
const STALL_MS = 60_000;
// Leaving the screen stops the sending but keeps what the drive has, so dropping
// the same file again carries on; a Stop click cancels it on the drive too.
const LEFT_SCREEN = 'left-screen';

const sleep = (ms: number) => new Promise((resolve) => { window.setTimeout(resolve, ms); });

async function answerOf<T>(response: Response) {
  const body = await response.json().catch(() => ({})) as Answer & T;
  if (response.ok) return body;
  throw new UploadFailure(response.status, body.code || '', body.error || 'The file could not be added.', Number(response.headers.get('Retry-After')) || 0);
}

async function request<T>(send: () => Promise<Response>) {
  let response: Response;
  try { response = await send(); } catch { throw new UploadFailure(0, 'NETWORK', 'The connection was lost.'); }
  return answerOf<T>(response);
}

// A PUT through XHR, the one browser API that reports bytes on their way up.
function putChunk(url: string, chunk: Blob, onProgress: (loaded: number) => void, abort: AbortSignal) {
  return new Promise<{ offset: number }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // A request whose connection vanished silently never ends by itself.
    let stalled = false;
    let watchdog = 0;
    const watch = () => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => { stalled = true; xhr.abort(); }, STALL_MS);
    };
    const onAbort = () => xhr.abort();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => { watch(); onProgress(event.loaded); };
    xhr.onloadend = () => {
      window.clearTimeout(watchdog);
      abort.removeEventListener('abort', onAbort);
    };
    xhr.onload = () => {
      let body: Answer & { offset?: number } = {};
      try { body = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve({ offset: Number(body.offset) });
      else reject(new UploadFailure(xhr.status, body.code || '', body.error || 'The file could not be added.', Number(xhr.getResponseHeader('Retry-After')) || 0));
    };
    xhr.onerror = () => reject(new UploadFailure(0, 'NETWORK', 'The connection was lost.'));
    xhr.onabort = () => reject(stalled ? new UploadFailure(0, 'NETWORK', 'The connection stalled.') : new UploadFailure(0, 'STOPPED', 'Stopped.'));
    abort.addEventListener('abort', onAbort);
    xhr.send(chunk);
    watch();
  });
}

// The connection, or Suite Manager behind the proxy, went away for a moment.
function transient(failure: UploadFailure) {
  return failure.code === 'NETWORK' || ([502, 503, 504].includes(failure.status) && !PAUSING_CODES.has(failure.code));
}

function pausedBy(code: string): Interruption {
  return code === 'FILES_DRIVE_READ_ONLY' ? 'read-only' : 'away';
}

export type UploadTarget = { driveId: string; folder: string; folderName: string };

export function useUploads({ onAdded, writable }: { onAdded: (folder: string) => void; writable: boolean }) {
  const queue = useRef<UploadItem[]>([]);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [interruption, setInterruption] = useState<Interruption>(null);
  const running = useRef(false);
  const writableRef = useRef(writable);
  const stops = useRef(new Map<string, AbortController>());
  const onAddedRef = useRef(onAdded);
  useEffect(() => { writableRef.current = writable; }, [writable]);
  useEffect(() => { onAddedRef.current = onAdded; }, [onAdded]);
  const show = useCallback(() => setItems([...queue.current]), []);

  const busy = items.some((item) => item.status === 'waiting' || item.status === 'sending');
  useEffect(() => {
    if (!busy) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  // Nothing is sent from a screen that is no longer there.
  useEffect(() => () => {
    queue.current = [];
    for (const stop of stops.current.values()) stop.abort(LEFT_SCREEN);
  }, []);

  const send = useCallback(async (item: UploadItem) => {
    const uploads = uploadsApi(item.driveId);
    const stop = new AbortController();
    stops.current.set(item.key, stop);
    const samples: Array<{ at: number; sent: number }> = [];
    let uploadId = '';
    let attempt = 0;
    const note = (sent: number) => {
      const at = performance.now();
      samples.push({ at, sent });
      while (samples.length > 2 && at - samples[0]!.at > 5_000) samples.shift();
      const first = samples[0]!;
      item.sent = sent;
      item.speed = at - first.at > 500 ? ((sent - first.sent) * 1000) / (at - first.at) : item.speed;
      show();
    };
    const stopped = async () => {
      if (stop.signal.reason !== LEFT_SCREEN && uploadId) await uploads.cancel(uploadId).catch(() => undefined);
      throw new UploadFailure(0, 'STOPPED', 'Stopped.');
    };
    // Waits out whatever stopped the last request, then asks where the drive has the file.
    const resume = async (failure: UploadFailure) => {
      if (transient(failure)) {
        setInterruption('connection');
        await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!);
        attempt += 1;
      } else if (PAUSING_CODES.has(failure.code)) {
        setInterruption(pausedBy(failure.code));
        for (let waited = 0; waited < 15_000 && !stop.signal.aborted; waited += 1_000) {
          await sleep(1_000);
          if (waited >= 2_000 && writableRef.current) break;
        }
      } else if (failure.status === 429) {
        await sleep((failure.retryAfter || 2) * 1000);
      } else if (RESTARTING_CODES.has(failure.code)) {
        await sleep(1_000);
      } else {
        throw failure;
      }
    };
    const begin = () => request<Begun>(() => uploads.begin({ lastModified: item.file.lastModified, name: item.file.name, path: item.folder, size: item.file.size }));
    item.status = 'sending';
    show();
    let offset = 0;
    let chunkBytes = 0;
    for (let begun = false; !begun;) {
      if (stop.signal.aborted) await stopped();
      try {
        ({ chunkBytes, offset, uploadId } = await begin());
        begun = true;
      } catch (caught) {
        await resume(caught as UploadFailure);
      }
    }
    setInterruption(null);
    note(offset);
    while (offset < item.file.size || !item.file.size) {
      if (stop.signal.aborted) await stopped();
      try {
        if (offset < item.file.size) {
          const sent = offset;
          ({ offset } = await putChunk(uploads.chunkUrl(uploadId, offset), item.file.slice(offset, offset + chunkBytes), (loaded) => note(sent + loaded), stop.signal));
          note(offset);
        }
        if (offset >= item.file.size) {
          await request(() => uploads.finish(uploadId));
          break;
        }
        attempt = 0;
        setInterruption(null);
      } catch (caught) {
        const failure = caught as UploadFailure;
        if (failure.code === 'STOPPED') continue;
        await resume(failure);
        const answer = await begin().catch((again: UploadFailure) => again);
        if (answer instanceof UploadFailure) {
          if (!PAUSING_CODES.has(answer.code) && !transient(answer) && answer.status !== 429) throw answer;
          continue;
        }
        ({ offset, uploadId } = answer);
        setInterruption(null);
        note(offset);
      }
    }
    stops.current.delete(item.key);
  }, [show]);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (let next = queue.current.find((item) => item.status === 'waiting'); next; next = queue.current.find((item) => item.status === 'waiting')) {
        try {
          await send(next);
          next.status = 'added';
          next.sent = next.file.size;
          onAddedRef.current(next.folder);
        } catch (caught) {
          next.status = 'failed';
          next.error = caught instanceof UploadFailure && caught.code === 'STOPPED' ? 'Stopped — nothing was added.' : caught instanceof Error ? caught.message : 'The file could not be added.';
        }
        setInterruption(null);
        show();
      }
    } finally {
      running.current = false;
    }
  }, [send, show]);

  const add = useCallback((files: File[], target: UploadTarget) => {
    const fresh = files.map((file): UploadItem => ({ ...target, error: '', file, key: `${Date.now()}-${Math.random()}`, sent: 0, speed: null, status: 'waiting' }));
    queue.current = [...queue.current.filter((item) => item.status === 'waiting' || item.status === 'sending'), ...fresh];
    show();
    void run();
  }, [run, show]);

  const stop = useCallback((key: string) => {
    const item = queue.current.find((entry) => entry.key === key);
    if (!item) return;
    if (item.status === 'waiting') {
      item.status = 'failed';
      item.error = 'Stopped — nothing was added.';
      show();
    }
    stops.current.get(key)?.abort();
  }, [show]);

  const clear = useCallback(() => {
    queue.current = queue.current.filter((item) => item.status === 'waiting' || item.status === 'sending');
    show();
  }, [show]);

  return { add, busy, clear, interruption, items, stop };
}
