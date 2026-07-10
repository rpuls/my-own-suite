const { hashPassword, verifyPassword } = require('../auth/passwords.cjs');
const { createSessionToken, hashSessionToken } = require('../auth/sessions.cjs');
const {
  OwnerAlreadyExistsError,
  SuiteManagerStore,
} = require('../state/suite-manager-store.cjs');

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
    this.store = new SuiteManagerStore(stateDir);
  }

  status(sessionToken = '') {
    const owner = this.store.getOwner();
    const session = this.hasSession(sessionToken);

    if (!owner) {
      return { owner: null, status: 'needs-owner' };
    }

    if (session) {
      return { owner: publicOwner(owner), status: 'signed-in' };
    }

    return { owner: publicOwner(owner), status: 'signed-out' };
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
  SetupError,
  SetupService,
};
