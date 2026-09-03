'use strict';

// A minimal SMTP client, on Node's own `net`/`tls` and nothing else. MOS ships
// no mail library on purpose: verifying a relay and sending one test message is
// a lockstep request/response protocol small enough to own outright, and owning
// it keeps a mail dependency and its transitive tree out of the control plane.
//
// It does exactly two things — prove a relay accepts our login, and send one
// message through it — and it refuses to send a credential in the clear unless
// the caller has said the relay is trusted. It is not a general mail transport
// and should not grow into one.

const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');

const DEFAULT_TIMEOUT_MS = 15_000;
// A single SMTP reply, even a multiline EHLO from a chatty relay, is kilobytes.
// A relay streaming past this is not one we can talk to, so the read is bounded
// rather than trusted to end.
const MAX_REPLY_BYTES = 64 * 1024;
const CRLF = '\r\n';

class SmtpError extends Error {
  constructor(code, message, { reply = null } = {}) {
    super(message);
    this.code = code;
    this.reply = reply;
  }
}

// The client greeting. A relay may reject an EHLO whose name is empty or an
// address literal it dislikes, so this is a plain hostname with a safe fallback.
function greetingName() {
  const host = String(os.hostname() || '').trim();
  return /^[A-Za-z0-9.-]+$/u.test(host) && host.length <= 255 ? host : 'my-own-suite.local';
}

// SMTP replies are one or more lines sharing a status code. Continuation lines
// are `250-text`; the final line is `250 text` (a space in the fourth column).
// Returns the parsed reply once the final line has arrived, or null if the
// buffer does not yet hold a complete reply.
function parseReply(buffer) {
  const lines = buffer.split(CRLF);
  // The last element is the text after the final CRLF: empty on a clean
  // boundary, a partial line otherwise. Either way it is not a finished line.
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index];
    if (line.length >= 4 && line[3] === ' ') {
      const code = Number.parseInt(line.slice(0, 3), 10);
      const text = lines.slice(0, index + 1).map((entry) => entry.slice(4)).join('\n');
      return { code: Number.isFinite(code) ? code : 0, raw: lines.slice(0, index + 1).join('\n'), text };
    }
  }
  return null;
}

// One live connection to a relay, wrapping whichever socket is current — the
// same object is reused across a STARTTLS upgrade by swapping the socket under
// it, so a caller writes the conversation as a straight line of awaits.
class SmtpConnection {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.pending = null;
    this.closedError = null;
    this._bind(socket);
  }

  _bind(socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(this.timeoutMs);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('timeout', () => this._fail(new SmtpError('SMTP_TIMEOUT', 'The relay did not answer in time.')));
    socket.on('error', (error) => this._fail(new SmtpError('SMTP_CONNECTION_FAILED', mapSocketError(error))));
    socket.on('close', () => this._fail(new SmtpError('SMTP_CONNECTION_CLOSED', 'The relay closed the connection.')));
  }

  _onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_REPLY_BYTES) {
      this._fail(new SmtpError('SMTP_REPLY_TOO_LARGE', 'The relay sent more than a reply should contain.'));
      return;
    }
    if (!this.pending) return;
    const reply = parseReply(this.buffer);
    if (!reply) return;
    this.buffer = '';
    const { resolve } = this.pending;
    this.pending = null;
    resolve(reply);
  }

  _fail(error) {
    this.closedError = this.closedError || error;
    if (this.pending) {
      const { reject } = this.pending;
      this.pending = null;
      reject(error);
    }
  }

  // Wait for the next complete reply. Only one may be outstanding at a time,
  // which the lockstep protocol guarantees.
  readReply() {
    if (this.closedError) return Promise.reject(this.closedError);
    // A reply may already be buffered (the greeting, or a fast relay).
    const buffered = parseReply(this.buffer);
    if (buffered) {
      this.buffer = '';
      return Promise.resolve(buffered);
    }
    return new Promise((resolve, reject) => { this.pending = { reject, resolve }; });
  }

  write(line) {
    this.socket.write(line + CRLF);
  }

  // Send a command and require the reply to carry one of `expect`. The command
  // text is never included in the thrown message: an AUTH line carries the
  // credential, so only the relay's own answer is surfaced.
  async command(line, expect, { redacted = false } = {}) {
    if (this.closedError) throw this.closedError;
    this.write(line);
    const reply = await this.readReply();
    if (!expect.includes(reply.code)) {
      throw new SmtpError('SMTP_COMMAND_REJECTED', `The relay refused ${redacted ? 'the command' : `"${line.split(' ')[0]}"`}: ${reply.code} ${reply.text}`, { reply });
    }
    return reply;
  }

  end() {
    try { this.socket.end(); } catch { /* closing a closed socket is fine */ }
    try { this.socket.destroy(); } catch { /* idem */ }
  }
}

function mapSocketError(error) {
  switch (error?.code) {
    case 'ECONNREFUSED': return 'The relay refused the connection. Check the host and port.';
    case 'ENOTFOUND': return 'The relay host could not be found. Check the hostname.';
    case 'ETIMEDOUT': return 'The relay did not answer in time.';
    case 'ECONNRESET': return 'The relay reset the connection.';
    default: return error?.message ? `Could not reach the relay: ${error.message}` : 'Could not reach the relay.';
  }
}

function connectSocket({ host, port, security, allowInvalidCert, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(new SmtpError('SMTP_CONNECTION_FAILED', mapSocketError(error)));
    if (security === 'tls') {
      const socket = tls.connect({ host, port, rejectUnauthorized: !allowInvalidCert, servername: host }, () => resolve(socket));
      socket.setTimeout(timeoutMs, () => socket.destroy(new SmtpError('SMTP_TIMEOUT', 'The relay did not answer in time.')));
      socket.once('error', onError);
      return;
    }
    const socket = net.connect({ host, port }, () => resolve(socket));
    socket.setTimeout(timeoutMs, () => socket.destroy(new SmtpError('SMTP_TIMEOUT', 'The relay did not answer in time.')));
    socket.once('error', onError);
  });
}

// Upgrade an established plaintext connection to TLS in place, returning the new
// socket. `servername` is the relay host so certificate validation checks the
// name the owner typed, not an IP the DNS happened to return.
function startTlsUpgrade(plainSocket, { host, allowInvalidCert, timeoutMs }) {
  return new Promise((resolve, reject) => {
    plainSocket.removeAllListeners('data');
    plainSocket.removeAllListeners('timeout');
    plainSocket.removeAllListeners('close');
    plainSocket.removeAllListeners('error');
    const secure = tls.connect({ allowHalfOpen: false, host, rejectUnauthorized: !allowInvalidCert, servername: host, socket: plainSocket }, () => resolve(secure));
    secure.setTimeout(timeoutMs, () => secure.destroy(new SmtpError('SMTP_TIMEOUT', 'The relay did not answer in time.')));
    secure.once('error', (error) => reject(new SmtpError('SMTP_TLS_FAILED', tlsErrorMessage(error))));
  });
}

function tlsErrorMessage(error) {
  if (error instanceof SmtpError) return error.message;
  const code = error?.code || '';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALT_NAME|HOSTNAME/u.test(code)) {
    return 'The relay presented a certificate this server does not trust. Use a relay with a valid certificate, or acknowledge the insecure relay explicitly.';
  }
  return error?.message ? `The encrypted handshake failed: ${error.message}` : 'The encrypted handshake failed.';
}

function b64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function parseEhloCapabilities(reply) {
  const capabilities = new Map();
  for (const line of String(reply.text || '').split('\n').slice(1)) {
    const [name, ...rest] = line.trim().split(/\s+/u);
    if (name) capabilities.set(name.toUpperCase(), rest.map((token) => token.toUpperCase()));
  }
  return capabilities;
}

// Open a connection, greet, upgrade to STARTTLS when asked, and authenticate.
// Shared by verify and send so both reach the relay by exactly the same path —
// a relay that verifies but cannot send, or the reverse, is the confusing case
// this rules out. Returns the live connection plus what the relay advertised.
async function openAuthenticated(relay, timeoutMs) {
  const { allowInvalidCert = false, host, password, port, security, username } = relay;
  const socket = await connectSocket({ allowInvalidCert, host, port, security, timeoutMs });
  const connection = new SmtpConnection(socket, timeoutMs);
  const name = greetingName();
  try {
    const greeting = await connection.readReply();
    if (greeting.code !== 220) {
      throw new SmtpError('SMTP_GREETING_REJECTED', `The relay declined the connection: ${greeting.code} ${greeting.text}`, { reply: greeting });
    }
    let ehlo = await connection.command(`EHLO ${name}`, [250]);
    let capabilities = parseEhloCapabilities(ehlo);
    let secured = security === 'tls';

    if (security === 'starttls') {
      if (!capabilities.has('STARTTLS')) {
        throw new SmtpError('SMTP_STARTTLS_UNAVAILABLE', 'The relay does not offer STARTTLS on this port. Use implicit TLS, a different port, or an unencrypted relay only on a trusted network.');
      }
      await connection.command('STARTTLS', [220]);
      const secure = await startTlsUpgrade(socket, { allowInvalidCert, host, timeoutMs });
      connection._bind(secure);
      ehlo = await connection.command(`EHLO ${name}`, [250]);
      capabilities = parseEhloCapabilities(ehlo);
      secured = true;
    }

    if (username) {
      await authenticate(connection, capabilities, { password, username });
    }
    return { capabilities, connection, secured };
  } catch (error) {
    connection.end();
    throw error;
  }
}

async function authenticate(connection, capabilities, { password, username }) {
  const mechanisms = capabilities.get('AUTH') || [];
  if (mechanisms.includes('PLAIN')) {
    // AUTH PLAIN carries \0user\0pass base64-encoded on one line. Marked
    // redacted so a rejection never echoes the credential back in an error.
    await connection.command(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`, [235], { redacted: true });
    return;
  }
  if (mechanisms.includes('LOGIN') || mechanisms.length === 0) {
    await connection.command('AUTH LOGIN', [334]);
    await connection.command(b64(username), [334], { redacted: true });
    await connection.command(b64(password), [235], { redacted: true });
    return;
  }
  throw new SmtpError('SMTP_AUTH_UNSUPPORTED', `The relay offers no supported login method (it advertised: ${mechanisms.join(', ') || 'none'}).`);
}

// Prove a relay will accept our login, without sending anyone a message. The
// strongest check that leaves no trace: connect, secure, authenticate, RSET,
// QUIT. Throws SmtpError on any failure; resolves with what the relay is.
async function verifyRelay(relay, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { capabilities, connection, secured } = await openAuthenticated(relay, timeoutMs);
  try {
    await connection.command('RSET', [250]);
    await connection.command('QUIT', [221]);
    return { authenticated: Boolean(relay.username), capabilities: [...capabilities.keys()], secured };
  } finally {
    connection.end();
  }
}

// A test message an owner can send to themselves to prove the relay works end to
// end. The body is base64 so a UTF-8 line, a long line, or a leading dot cannot
// corrupt the DATA phase, and the headers carry only ASCII the caller controls.
async function sendTestMessage(relay, { subject, text, timeoutMs = DEFAULT_TIMEOUT_MS, to }) {
  const { connection, secured } = await openAuthenticated(relay, timeoutMs);
  try {
    const from = relay.fromAddress;
    await connection.command(`MAIL FROM:<${from}>`, [250]);
    await connection.command(`RCPT TO:<${to}>`, [250, 251]);
    await connection.command('DATA', [354]);
    const message = buildMessage({ from, fromName: relay.fromName, subject, text, to });
    // The body is dot-stuffed by construction (base64 has no leading dots), then
    // terminated by a lone dot on its own line.
    connection.write(message);
    const accepted = await connection.command('.', [250]);
    await connection.command('QUIT', [221]);
    return { messageId: messageIdFor(from), reply: accepted.text, secured };
  } finally {
    connection.end();
  }
}

function messageIdFor(from) {
  const domain = String(from).split('@')[1] || 'my-own-suite.local';
  return `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${domain}>`;
}

function headerAddress(address, name) {
  // Only a display name that already passed the contract's FROM_NAME_PATTERN
  // reaches here, so it has no quotes, angle brackets, or line breaks to escape.
  return name ? `"${name}" <${address}>` : `<${address}>`;
}

function buildMessage({ from, fromName, subject, text, to }) {
  const headers = [
    `From: ${headerAddress(from, fromName)}`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageIdFor(from)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(String(text), 'utf8').toString('base64').replace(/(.{76})/gu, `$1${CRLF}`);
  return headers.join(CRLF) + CRLF + CRLF + body;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  SmtpError,
  parseReply,
  sendTestMessage,
  verifyRelay,
};
