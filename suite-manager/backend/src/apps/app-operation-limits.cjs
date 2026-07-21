// Every app package operation that reaches a source or the app agent costs work
// MOS cannot take back: an outbound archive download, a docker build, a runtime
// swap. Nothing about being the authenticated owner makes that cheap, and the
// expensive part starts long before any durable record exists to refuse a second
// one, so each operation class is bounded here at the point it begins.
//
// Both bounds reject rather than queue. A queue behind a stuck download or a hung
// build stacks the very work the bound exists to prevent, and it turns one slow
// source into a Suite Manager that appears hung to the owner.
const DEFAULT_OPERATION_POLICY = Object.freeze({
  download: Object.freeze({ maxConcurrent: 3, maxPerWindow: 12, windowMs: 60 * 1_000 }),
});

class AppOperationLimitError extends Error {
  constructor(code, message, statusCode = 429) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

class AppOperationLimiter {
  constructor({ now = () => Date.now(), policy = {} } = {}) {
    this.now = now;
    this.policy = { download: { ...DEFAULT_OPERATION_POLICY.download, ...policy.download } };
    this.exclusive = new Set();
    this.downloads = 0;
    this.recentDownloads = new Map();
  }

  // One update transaction per app at a time. The store refuses a second
  // concurrent update durably, but only once the first has reached the database:
  // by then it has already downloaded a candidate and started a build. Holding the
  // key across the whole transaction means an owner double-clicking Update, or a
  // client retrying a request that has not answered yet, cannot start that work
  // twice.
  async runExclusive(key, run) {
    if (this.exclusive.has(key)) {
      throw new AppOperationLimitError('APP_OPERATION_IN_PROGRESS', 'Another operation for this app is already running. Wait for it to finish before starting a new one.', 409);
    }
    this.exclusive.add(key);
    try {
      return await run();
    } finally {
      this.exclusive.delete(key);
    }
  }

  // Candidate downloads are outbound requests that each write a package into the
  // candidate root. The concurrency cap keeps a burst from saturating the host's
  // network and disk; the per-source window keeps MOS from hammering one
  // repository hard enough to look like an attack originating from this host. The
  // window is deliberately generous: previewing an update and then applying it
  // downloads twice in quick succession by design, and that must never throttle.
  async runDownload(key, run) {
    const { maxConcurrent, maxPerWindow, windowMs } = this.policy.download;
    const at = this.now();
    this.#pruneWindows(at);
    const recent = this.recentDownloads.get(key) || [];
    if (recent.length >= maxPerWindow) {
      throw new AppOperationLimitError('APP_DOWNLOAD_THROTTLED', 'This app package source has been checked too many times in a row. Wait a moment and try again.');
    }
    if (this.downloads >= maxConcurrent) {
      throw new AppOperationLimitError('APP_DOWNLOAD_BUSY', 'MOS is already downloading other app packages. Wait for those to finish and try again.');
    }
    this.recentDownloads.set(key, [...recent, at]);
    this.downloads += 1;
    try {
      return await run();
    } finally {
      this.downloads -= 1;
    }
  }

  // Sources nobody is checking any more must not accumulate an entry each, or the
  // limiter itself becomes the unbounded thing.
  #pruneWindows(at) {
    for (const [key, timestamps] of this.recentDownloads) {
      const live = timestamps.filter((timestamp) => at - timestamp < this.policy.download.windowMs);
      if (live.length) this.recentDownloads.set(key, live);
      else this.recentDownloads.delete(key);
    }
  }
}

module.exports = {
  AppOperationLimitError,
  AppOperationLimiter,
  DEFAULT_OPERATION_POLICY,
};
