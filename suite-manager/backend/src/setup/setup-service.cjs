const { CodedError } = require('../../../../shared/coded-error.cjs');
const { hashPassword, needsRehash, verifyPassword } = require('../auth/passwords.cjs');
const { createSessionToken, hashSessionToken } = require('../auth/sessions.cjs');
const {
  OwnerAlreadyExistsError,
  SuiteManagerStore,
} = require('../state/suite-manager-store.cjs');

const MIN_PASSWORD_LENGTH = 12;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const KNOWN_BROWSER_MAX_AGE_MS = 365 * DAY_MS;
const SESSION_IDLE_TIMEOUT_MS = 14 * DAY_MS;
const SESSION_MAX_AGE_MS = 90 * DAY_MS;
// Use is written back no more often than this, so a busy page is not a write per request.
const SESSION_SEEN_INTERVAL_MS = HOUR_MS;

// The terms the owner is asked to accept, versioned by the "Last updated" date
// on site/src/content/docs/docs/terms.md. Bumping this date there means bumping
// it here: a new version is a new acceptance, and every install is asked again.
const TERMS_VERSION = '2026-07';

// Owner preferences and the value each one has when nothing is stored. This
// object is the whole contract: it decides the default in one place rather than
// at each call site, and a key that is not in it is not a preference — the write
// route rejects it, and a row left behind by another release is ignored.
const OWNER_PREFERENCE_DEFAULTS = Object.freeze({
  technicalControls: false,
});

const SETUP_ERROR_STATUS = Object.freeze({
  INVALID_LOGIN: 401,
  OWNER_ALREADY_EXISTS: 409,
  OWNER_NOT_CREATED: 401,
});

class SetupError extends CodedError {
  constructor(code, message) {
    super(code, message, { statusCode: SETUP_ERROR_STATUS[code] || 400 });
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function publicOwner(owner) {
  if (!owner) {
    return null;
  }

  return {
    createdAt: owner.createdAt,
    email: owner.email,
    name: owner.name,
  };
}

// A session signs the owner in only while it is newer than both cut-offs.
function liveSessionWindow(now) {
  return {
    createdAfter: new Date(now.getTime() - SESSION_MAX_AGE_MS).toISOString(),
    seenAfter: new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS).toISOString(),
  };
}

function validateOwnerInput(input) {
  const name = String(input?.name || '').trim();
  const email = normalizeEmail(input?.email);
  const password = String(input?.password || '');

  if (!name) {
    throw new SetupError('INVALID_OWNER_NAME', 'Owner name is required.');
  }

  if (!email || !email.includes('@')) {
    throw new SetupError('INVALID_OWNER_EMAIL', 'Owner email must be valid.');
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new SetupError('WEAK_OWNER_PASSWORD', `Owner password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  return { email, name, password };
}

class SetupService {
  constructor({ now = () => new Date(), stateDir }) {
    this.now = now;
    this.store = new SuiteManagerStore(stateDir);
  }

  status(sessionToken = '') {
    const owner = this.store.getOwner();
    const session = this.hasSession(sessionToken);

    if (!owner) {
      return { owner: null, status: 'needs-owner', ...this.termsState() };
    }

    if (session) {
      // Preferences ride on the bootstrap payload so Suite Manager knows them
      // before its first paint, and only here: a signed-out or needs-owner
      // caller is told nothing about the owner beyond their name and email.
      return { owner: publicOwner(owner), preferences: this.preferences(), status: 'signed-in', ...this.termsState() };
    }

    return { owner: publicOwner(owner), status: 'signed-out', ...this.termsState() };
  }

  preferences() {
    const owner = this.store.getOwner();
    const stored = owner ? this.store.getOwnerPreferences(owner.id) : {};
    return Object.fromEntries(Object.entries(OWNER_PREFERENCE_DEFAULTS).map(([key, fallback]) => [
      key,
      typeof stored[key] === typeof fallback ? stored[key] : fallback,
    ]));
  }

  setPreference(input) {
    const owner = this.store.getOwner();
    if (!owner) {
      throw new SetupError('OWNER_NOT_CREATED', 'Create the MOS owner account first.');
    }

    const key = String(input?.key || '');
    if (!Object.hasOwn(OWNER_PREFERENCE_DEFAULTS, key)) {
      throw new SetupError('UNKNOWN_PREFERENCE', 'That is not a Suite Manager preference.');
    }

    if (typeof input?.value !== typeof OWNER_PREFERENCE_DEFAULTS[key]) {
      throw new SetupError('INVALID_PREFERENCE_VALUE', `Preference ${key} must be a ${typeof OWNER_PREFERENCE_DEFAULTS[key]}.`);
    }

    this.store.setOwnerPreference({ at: this.now().toISOString(), key, ownerId: owner.id, value: input.value });
    return this.preferences();
  }

  termsState() {
    const acceptance = this.store.getTermsAcceptance(TERMS_VERSION);
    return {
      terms: {
        accepted: Boolean(acceptance),
        acceptedAt: acceptance?.acceptedAt || null,
        version: TERMS_VERSION,
      },
    };
  }

  acceptTerms(input) {
    if (!this.store.getOwner()) {
      throw new SetupError('OWNER_NOT_CREATED', 'Create the MOS owner account first.');
    }
    // The version travels with the acceptance so a stale tab cannot accept
    // terms the owner was never shown.
    const version = String(input?.version || '');
    if (version !== TERMS_VERSION) {
      throw new SetupError('TERMS_VERSION_MISMATCH', 'These terms have changed. Reload Suite Manager and read them again.');
    }
    this.store.recordTermsAcceptance({ acceptedAt: this.now().toISOString(), termsVersion: TERMS_VERSION });
    return this.termsState();
  }

  async createOwner(input) {
    if (this.store.getOwner()) {
      throw new SetupError('OWNER_ALREADY_EXISTS', 'The MOS owner account already exists.');
    }

    const ownerInput = validateOwnerInput(input);
    const owner = {
      createdAt: this.now().toISOString(),
      email: ownerInput.email,
      name: ownerInput.name,
      passwordHash: await hashPassword(ownerInput.password),
    };
    const token = createSessionToken();
    const session = {
      createdAt: this.now().toISOString(),
      tokenHash: hashSessionToken(token),
    };

    try {
      this.store.createOwnerAndSession(owner, session);
    } catch (error) {
      if (error instanceof OwnerAlreadyExistsError) {
        throw new SetupError('OWNER_ALREADY_EXISTS', 'The MOS owner account already exists.');
      }
      throw error;
    }

    return {
      owner: publicOwner(owner),
      sessionToken: token,
      status: 'signed-in',
    };
  }

  async login(input) {
    const owner = this.store.getOwner();
    const email = normalizeEmail(input?.email);
    const password = String(input?.password || '');

    if (!owner) {
      throw new SetupError('OWNER_NOT_CREATED', 'Create the MOS owner account first.');
    }

    // The password is verified even when the email already does not match, so a
    // wrong address and a wrong password cost the same. Skipping the hash on a
    // mismatch would answer "is this the owner's email?" in the response time,
    // and raising the hashing cost is exactly what would make that audible.
    const passwordMatches = await verifyPassword(password, owner.passwordHash);
    if (owner.email !== email || !passwordMatches) {
      throw new SetupError('INVALID_LOGIN', 'Email or password is incorrect.');
    }

    // A correct sign-in is the only time MOS holds the plaintext for an account
    // it did not just create, so it is the only chance to move a hash written
    // under weaker parameters up to the current ones.
    if (needsRehash(owner.passwordHash)) {
      this.store.upgradeOwnerPasswordHash(await hashPassword(password), { replacing: owner.passwordHash });
    }

    return {
      owner: publicOwner(owner),
      sessionToken: this.#startSession(),
      status: 'signed-in',
    };
  }

  /**
   * Rotating the owner password is how an install created over plain HTTP gets
   * a password that was never sent in the clear. It proves the current password
   * first, then ends every session — including the caller's — and hands back a
   * fresh one so the owner stays signed in on this browser only.
   *
   * `beforeCommit` runs after every check has passed and before the new
   * password becomes the one that signs the owner in. On a machine that asks
   * for this password at startup, that ordering is the whole point: a password
   * Suite Manager accepts while the disk still wants the previous one is a
   * machine that signs its owner in and then refuses them after a power cut.
   * Its own failure never refuses the change — an owner may be changing this
   * password precisely because it leaked — so it reports rather than throws,
   * and what it reports travels back to the screen.
   */
  async changeOwnerPassword(input, { beforeCommit = null } = {}) {
    const owner = this.store.getOwner();
    if (!owner) {
      throw new SetupError('OWNER_NOT_CREATED', 'Create the MOS owner account first.');
    }

    const currentPassword = String(input?.currentPassword || '');
    const newPassword = String(input?.newPassword || '');

    if (!await verifyPassword(currentPassword, owner.passwordHash)) {
      throw new SetupError('INVALID_CURRENT_PASSWORD', 'Your current password is incorrect.');
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new SetupError('WEAK_OWNER_PASSWORD', `Owner password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    if (await verifyPassword(newPassword, owner.passwordHash)) {
      throw new SetupError('PASSWORD_UNCHANGED', 'Choose a password you have not used here before.');
    }

    const startupProtection = beforeCommit ? await beforeCommit(newPassword) : null;
    this.store.replaceOwnerPassword(await hashPassword(newPassword));

    return {
      owner: publicOwner(owner),
      sessionToken: this.#startSession(),
      startupProtection,
      status: 'signed-in',
    };
  }

  // Proving the owner password without signing in and without changing
  // anything. Used where a signed-in owner asks to see a secret again: the
  // session says who they are, this says they are still the one at the keyboard.
  async verifyOwnerPassword(password) {
    const owner = this.store.getOwner();
    if (!owner) {
      throw new SetupError('OWNER_NOT_CREATED', 'Create the MOS owner account first.');
    }
    return verifyPassword(String(password || ''), owner.passwordHash);
  }

  logout(sessionToken = '') {
    const tokenHash = sessionToken ? hashSessionToken(sessionToken) : '';
    this.store.deleteSession(tokenHash);

    return this.status();
  }

  hasSession(sessionToken) {
    if (!sessionToken) {
      return null;
    }

    const now = this.now();
    const tokenHash = hashSessionToken(sessionToken);
    const session = this.store.findLiveSession({ tokenHash, ...liveSessionWindow(now) });
    if (!session) {
      return false;
    }
    if (now.getTime() - Date.parse(session.lastSeenAt) >= SESSION_SEEN_INTERVAL_MS) {
      this.store.markSessionSeen({ at: now.toISOString(), tokenHash });
    }
    return true;
  }

  #startSession() {
    const now = this.now();
    const token = createSessionToken();
    this.store.createSession({ createdAt: now.toISOString(), tokenHash: hashSessionToken(token) }, liveSessionWindow(now));
    return token;
  }

  // A browser that has signed in successfully carries a random token, of which
  // only the hash is stored — the same shape as a session, but it proves only
  // "this browser has been the owner before", never that it is signed in now.
  // Sign-in uses it to skip the account-wide backoff, and nothing else.
  isKnownBrowser(token) {
    if (!token) return false;
    return this.store.isKnownBrowser({
      at: this.now().toISOString(),
      maxAgeMs: KNOWN_BROWSER_MAX_AGE_MS,
      tokenHash: hashSessionToken(token),
    });
  }

  rememberBrowser() {
    const token = createSessionToken();
    this.store.rememberBrowser({ at: this.now().toISOString(), tokenHash: hashSessionToken(token) });
    return token;
  }

  close() {
    this.store.close();
  }
}

module.exports = {
  KNOWN_BROWSER_MAX_AGE_MS,
  MIN_PASSWORD_LENGTH,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_AGE_MS,
  SESSION_SEEN_INTERVAL_MS,
  SetupError,
  SetupService,
  TERMS_VERSION,
};
