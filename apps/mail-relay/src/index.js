import crypto from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import PostalMime from 'postal-mime';

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNumber(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalEnv(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function formatAddress(address, name = '') {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return address;
  }

  const escaped = trimmedName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}" <${address}>`;
}

function normalizeAddressList(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeAddressList(entry));
  }

  if (typeof value === 'object') {
    if (typeof value.address === 'string' && value.address.trim()) {
      return [value.address.trim()];
    }
    return [];
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

function getSessionUsername(session) {
  if (typeof session.user === 'string' && session.user.trim()) {
    return session.user.trim();
  }

  if (session.user && typeof session.user.username === 'string' && session.user.username.trim()) {
    return session.user.username.trim();
  }

  return 'unknown';
}

const config = {
  bindHost: optionalEnv('RELAY_BIND_HOST', '0.0.0.0'),
  port: parseNumber('RELAY_PORT', 2525),
  hostname: optionalEnv('RELAY_HOSTNAME', 'mos-mail-relay'),
  username: requireEnv('RELAY_USERNAME'),
  password: requireEnv('RELAY_PASSWORD'),
  resendApiKey: requireEnv('RESEND_API_KEY'),
  resendAudience: optionalEnv('RESEND_API_AUDIENCE', 'https://api.resend.com/emails'),
  fromAddress: requireEnv('RESEND_FROM'),
  fromName: optionalEnv('RESEND_FROM_NAME', ''),
  maxRecipientsPerMessage: parseNumber('RELAY_MAX_RECIPIENTS_PER_MESSAGE', 10),
  maxMessageBytes: parseNumber('RELAY_MAX_MESSAGE_BYTES', 256 * 1024),
  rateLimitWindowMs: parseNumber('RELAY_RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMaxMessages: parseNumber('RELAY_RATE_LIMIT_MAX_MESSAGES', 20),
  allowInsecureAuth: parseBoolean(process.env.RELAY_ALLOW_INSECURE_AUTH, true),
  allowAttachments: parseBoolean(process.env.RELAY_ALLOW_ATTACHMENTS, false),
};

const rateLimitState = new Map();

function pruneRateLimitBucket(now, timestamps) {
  return timestamps.filter((timestamp) => now - timestamp < config.rateLimitWindowMs);
}

function recordMessageAttempt(username) {
  const now = Date.now();
  const timestamps = pruneRateLimitBucket(now, rateLimitState.get(username) || []);
  if (timestamps.length >= config.rateLimitMaxMessages) {
    throw new Error('Rate limit exceeded for this relay credential.');
  }

  timestamps.push(now);
  rateLimitState.set(username, timestamps);
}

async function readStream(stream) {
  const chunks = [];
  let size = 0;

  for await (const chunk of stream) {
    size += chunk.length;
    if (size > config.maxMessageBytes) {
      throw new Error(`Message exceeds RELAY_MAX_MESSAGE_BYTES (${config.maxMessageBytes}).`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function sendWithResend({ envelope, parsed }) {
  const recipients = envelope.rcptTo.map((entry) => entry.address).filter(Boolean);
  if (recipients.length === 0) {
    throw new Error('Message must include at least one recipient.');
  }

  if (recipients.length > config.maxRecipientsPerMessage) {
    throw new Error(`Message exceeds RELAY_MAX_RECIPIENTS_PER_MESSAGE (${config.maxRecipientsPerMessage}).`);
  }

  if (!config.allowAttachments && Array.isArray(parsed.attachments) && parsed.attachments.length > 0) {
    throw new Error('Attachments are disabled for this relay.');
  }

  const cc = normalizeAddressList(parsed.cc);
  const bcc = normalizeAddressList(parsed.bcc);
  const replyTo = envelope.mailFrom?.address ? [envelope.mailFrom.address] : [];
  const payload = {
    from: formatAddress(config.fromAddress, config.fromName),
    to: recipients,
    subject: parsed.subject || '(no subject)',
  };

  if (parsed.html) {
    payload.html = parsed.html;
  }

  if (parsed.text) {
    payload.text = parsed.text;
  }

  if (cc.length > 0) {
    payload.cc = cc;
  }

  if (bcc.length > 0) {
    payload.bcc = bcc;
  }

  if (replyTo.length > 0) {
    payload.reply_to = replyTo;
  }

  const response = await fetch(config.resendAudience, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend API request failed (${response.status}): ${body}`);
  }

  return response.json();
}

const server = new SMTPServer({
  secure: false,
  authOptional: false,
  allowInsecureAuth: config.allowInsecureAuth,
  banner: `${config.hostname} ready`,
  size: config.maxMessageBytes,
  disabledCommands: ['STARTTLS'],
  authMethods: ['PLAIN', 'LOGIN'],
  logger: false,
  onAuth(auth, _session, callback) {
    const providedUsername = String(auth.username ?? '');
    const providedPassword = String(auth.password ?? '');
    const validUsername = secureEquals(providedUsername, config.username);
    const validPassword = secureEquals(providedPassword, config.password);

    if (!validUsername || !validPassword) {
      console.warn(
        `[relay] auth rejected method=${auth.method || 'unknown'} username=${JSON.stringify(providedUsername)} password_length=${providedPassword.length}`,
      );
      return callback(new Error('Invalid relay credentials.'));
    }

    console.log(`[relay] auth accepted method=${auth.method || 'unknown'} username=${JSON.stringify(providedUsername)}`);
    return callback(null, { user: providedUsername, username: providedUsername });
  },
  onData(stream, session, callback) {
    (async () => {
      const username = getSessionUsername(session);
      recordMessageAttempt(username);

      const rawMessage = await readStream(stream);
      const parser = new PostalMime();
      const parsed = await parser.parse(rawMessage);
      const resendResponse = await sendWithResend({
        envelope: session.envelope,
        parsed,
      });

      const recipients = session.envelope.rcptTo.map((entry) => entry.address).join(', ');
      console.log(
        `[relay] accepted message user=${username} recipients=${recipients} subject=${JSON.stringify(parsed.subject || '(no subject)')} resend_id=${resendResponse?.id || 'n/a'}`,
      );
    })()
      .then(() => callback(null, 'Message accepted for delivery'))
      .catch((error) => {
        console.error(`[relay] message rejected: ${error.message}`);
        callback(error);
      });
  },
});

server.on('error', (error) => {
  console.error(`[relay] server error: ${error.message}`);
});

server.listen(config.port, config.bindHost, () => {
  console.log(
    `[relay] listening on ${config.bindHost}:${config.port} as ${config.hostname}; sender rewrite => ${formatAddress(config.fromAddress, config.fromName)}`,
  );
});
