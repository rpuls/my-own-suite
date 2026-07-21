const crypto = require('node:crypto');

const KEY_LENGTH = 64;
const SCRYPT_COST = 16384;

function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string.');
  }

  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_COST }).toString('base64url');
  return `scrypt$N=${SCRYPT_COST}$${salt}$${hash}`;
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyPassword(password, encodedHash) {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') {
    return false;
  }

  const parts = encodedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt' || !parts[1].startsWith('N=')) {
    return false;
  }

  const cost = Number(parts[1].slice(2));
  const salt = parts[2];
  const expectedHash = parts[3];

  if (!Number.isInteger(cost) || cost <= 0 || !salt || !expectedHash) {
    return false;
  }

  const actualHash = crypto.scryptSync(password, salt, KEY_LENGTH, { N: cost }).toString('base64url');
  return timingSafeEqualString(actualHash, expectedHash);
}

module.exports = {
  hashPassword,
  verifyPassword,
};
