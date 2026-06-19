const { hashPassword, verifyPassword } = require('../auth/passwords.cjs');
const { createSessionToken, hashSessionToken } = require('../auth/sessions.cjs');
const { PlatformStateStore } = require('../state/platform-state-store.cjs');

const MIN_PASSWORD_LENGTH = 12;

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
    this.store = new PlatformStateStore(stateDir);
  }

  status(sessionToken = '') {
    const state = this.store.load();
    const session = this.sessionFromState(state, sessionToken);

    if (!state.owner) {
      return { owner: null, status: 'needs-owner' };
    }

    if (session) {
      return { owner: publicOwner(state.owner), status: 'signed-in' };
    }

    return { owner: publicOwner(state.owner), status: 'signed-out' };
  }

  createOwner(input) {
    const state = this.store.load();
    if (state.owner) {
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

    this.store.save({
      ...state,
      owner,
      sessions: [session],
    });

    return {
      owner: publicOwner(owner),
      sessionToken: token,
      status: 'signed-in',
    };
  }

  login(input) {
    const state = this.store.load();
    const email = normalizeEmail(input?.email);
    const password = String(input?.password || '');

    if (!state.owner) {
      throw new SetupError('OWNER_NOT_CREATED', 'Create the MOS owner account first.');
    }

    if (state.owner.email !== email || !verifyPassword(password, state.owner.passwordHash)) {
      throw new SetupError('INVALID_LOGIN', 'Email or password is incorrect.');
    }

    const token = createSessionToken();
    const session = {
      createdAt: this.now().toISOString(),
      tokenHash: hashSessionToken(token),
    };

    this.store.save({
      ...state,
      sessions: [...state.sessions, session],
    });

    return {
      owner: publicOwner(state.owner),
      sessionToken: token,
      status: 'signed-in',
    };
  }

  logout(sessionToken = '') {
    const state = this.store.load();
    const tokenHash = sessionToken ? hashSessionToken(sessionToken) : '';

    this.store.save({
      ...state,
      sessions: state.sessions.filter((session) => session.tokenHash !== tokenHash),
    });

    return this.status();
  }

  sessionFromState(state, sessionToken) {
    if (!sessionToken) {
      return null;
    }

    const tokenHash = hashSessionToken(sessionToken);
    return state.sessions.find((session) => session.tokenHash === tokenHash) || null;
  }
}

module.exports = {
  SetupError,
  SetupService,
};
