const { hashPassword, verifyPassword } = require('../auth/passwords.cjs');
const { createSessionToken, hashSessionToken } = require('../auth/sessions.cjs');
const {
  OwnerAlreadyExistsError,
  SuiteManagerStore,
} = require('../state/suite-manager-store.cjs');

const MIN_PASSWORD_LENGTH = 12;

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

class SetupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
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

  createOwner(input) {
    if (this.store.getOwner()) {
      throw new SetupError('OWNER_ALREADY_EXISTS', 'The MOS owner account already exists.');
    }

    const ownerInput = validateOwnerInput(input);
    const owner = {
      createdAt: this.now().toISOString(),
      email: ownerInput.email,
      name: ownerInput.name,
      passwordHash: hashPassword(ownerInput.password),
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

  login(input) {
    const owner = this.store.getOwner();
    const email = normalizeEmail(input?.email);
    const password = String(input?.password || '');

    if (!owner) {
      throw new SetupError('OWNER_NOT_CREATED', 'Create the MOS owner account first.');
    }

    if (owner.email !== email || !verifyPassword(password, owner.passwordHash)) {
      throw new SetupError('INVALID_LOGIN', 'Email or password is incorrect.');
    }

    const token = createSessionToken();
    const session = {
      createdAt: this.now().toISOString(),
      tokenHash: hashSessionToken(token),
    };

    this.store.createSession(session);

    return {
      owner: publicOwner(owner),
      sessionToken: token,
      status: 'signed-in',
    };
  }

  // Rotating the owner password is how an install created over plain HTTP gets
  // a password that was never sent in the clear. It proves the current password
  // first, then ends every session — including the caller's — and hands back a
  // fresh one so the owner stays signed in on this browser only.
  changeOwnerPassword(input) {
    const owner = this.store.getOwner();
    if (!owner) {
      throw new SetupError('OWNER_NOT_CREATED', 'Create the MOS owner account first.');
    }

    const currentPassword = String(input?.currentPassword || '');
    const newPassword = String(input?.newPassword || '');

    if (!verifyPassword(currentPassword, owner.passwordHash)) {
      throw new SetupError('INVALID_CURRENT_PASSWORD', 'Your current password is incorrect.');
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new SetupError('WEAK_OWNER_PASSWORD', `Owner password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    if (verifyPassword(newPassword, owner.passwordHash)) {
      throw new SetupError('PASSWORD_UNCHANGED', 'Choose a password you have not used here before.');
    }

    this.store.replaceOwnerPassword(hashPassword(newPassword));

    const token = createSessionToken();
    this.store.createSession({
      createdAt: this.now().toISOString(),
      tokenHash: hashSessionToken(token),
    });

    return {
      owner: publicOwner(owner),
      sessionToken: token,
      status: 'signed-in',
    };
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

    const tokenHash = hashSessionToken(sessionToken);
    return this.store.hasSession(tokenHash);
  }

  close() {
    this.store.close();
  }
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  SetupError,
  SetupService,
  TERMS_VERSION,
};
