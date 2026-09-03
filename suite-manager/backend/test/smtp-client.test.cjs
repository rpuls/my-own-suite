'use strict';

// The minimal SMTP client, exercised against fake relays built on the same
// net/tls the client uses. Every relay quirk it must survive — a multiline EHLO,
// a STARTTLS upgrade, PLAIN vs LOGIN auth, a refusal, a greeting that declines —
// is a fake server here, so the protocol code is proven without a real mail host
// and without reaching the network.

const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const test = require('node:test');

const { SmtpError, parseReply, sendTestMessage, verifyRelay } = require('../src/settings/smtp-client.cjs');

// A throwaway self-signed certificate for localhost, generated once for these
// tests. It is not trusted by anything, which is the point: the client must
// reject it unless allowInvalidCert is set.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCai0CEvmtHFWJ8
6y3/mSP9olozi/l3q1EoHcFBpRnKbNB6cK6M0+U/tQMtBev+idLXraUxvUSQf8Y5
Lvexjm3FR9rpu3p57cv/If5+y/emcIJue+eEQPREUafu8cDRJfLXWY4JV/c1g2l4
dVAzo04oDwN/phc5Dj66TcYgr2YACV6/Btx8TxrV5stM9OiXmvUKVScoRe9FC3C9
XuG/w31anDcsjOj/PfFk567lBqUnrJcBBRB/P6TTgr7CVKlc/wKKO/vTWuj37uvg
UUo8ZTXAk2ofqA0l4tSXfbTVleEx1y+dnyXaxUbE3ilOIJWc3nFHS/rvHi3lTaik
7Kfza1mZAgMBAAECggEADhwB4Jyp8AF0eRyCRJWsrYQHDDG5WELx0+HI5RS3uBLF
2Iffx8ezZGTtofdVG8C62SoSAj/aD1SQZQ7JWmfl1F8XuMMpuWa2ey1AA5Tc9VB2
+Aij6HUtrUHEkpIhHSHZJplsgvne/f8TarCl3oZdpQFJ5nuOyeISZAakZ2jcEnX5
czaHx10H2MvfZbvPfc2ZhJRlAdxPSWaB+xo2vLHEljGEochkD1UrkIxyhUgsTxX5
e1+2oWkdOo26nzsq+/LmhHVGNuMn/5TiurPP1VCIoyYE/A2yUphOTRU1TzmB7rW8
AOlm0ZVmOZVMi0dL4vhpM+ROLVt+B69Z9mL2Sw/9aQKBgQDWmGWILzHMbj0FHYGE
5cO0vWrE75arut73uQi1onscynvXfzz/lSsYdh/atad2mk+U8cYsBz0iPnfXyqOQ
GuMg2j07liBH4ClTj1WYbmIpSni8UeFbSXmVF52Q3fz3g4/FC2wuNTRwvougVCno
fzGfP3hWbc2Y4IuledF3ItBvKwKBgQC4XLZAdAsObwjHOqMr1VWrK8ZY8LhXof/x
+Vi/DttODYMWX17HgvNgO4mLYCy2YpgdA4dBwAsC5VpRoi/R9VP/CYoz8+vsTocs
AEQ8YbEaKpLt1hq86mr6aa01fZ+m5cWTE1np6cj6lBr+eCFwv5dc/CcvfKaqDBYd
gcdUnGxYSwKBgQDEx3pTJvPDQlMyHZxnAUo0snz1mb3QO8u53TLfW98Ix6RIN6T3
uRGLnMYZB/pIB7hyHEJcnUax4BaFCoxx2DXuKjF8Mm3neuZqeUVEQfRBaMjN50d/
LiEPVlhmPyl4zmtHhPHubVtpB1GB86t6Ryh5nvn6RzYAuedUFiC93m7DgQKBgQCg
9nk87tQUZwcQAvchtyITz6VeU9Vu1YcEOgKs1QjOLefsqZmzsXZR58lgAbkoCA7t
Df6Sflxey+Y+bc84jewnOKoMUAQEjk9gMF9jJJwez1r3Aj7YAAck2Q0cLbEtY2FL
1tJi8vXBKXwj/ribmvtJePGxeTB+OQ059+wTyHqj3wKBgF/QEwe29TB8pS/Mc8gV
8S//BGticI3OpugAjI/ucDJ3Qzja/VGi2Rfu1UfSXun4OH/9DopfbTEu2vnr9p5T
CQcJUBU3Zl5GHrsdHFoDOkOCXVWtjLZnK+ZKwJjoX+8cZlCbsLEdB+8MsbdKDRXE
UcovKun4ijMx9RhMvXIJuQ3X
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUNVpNHqhx35xtTEm04ANey31fwsgwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkwMjIzMjI1OVoXDTM2MDgz
MDIzMjI1OVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAmotAhL5rRxVifOst/5kj/aJaM4v5d6tRKB3BQaUZymzQ
enCujNPlP7UDLQXr/onS162lMb1EkH/GOS73sY5txUfa6bt6ee3L/yH+fsv3pnCC
bnvnhED0RFGn7vHA0SXy11mOCVf3NYNpeHVQM6NOKA8Df6YXOQ4+uk3GIK9mAAle
vwbcfE8a1ebLTPTol5r1ClUnKEXvRQtwvV7hv8N9Wpw3LIzo/z3xZOeu5QalJ6yX
AQUQfz+k04K+wlSpXP8Cijv701ro9+7r4FFKPGU1wJNqH6gNJeLUl3201ZXhMdcv
nZ8l2sVGxN4pTiCVnN5xR0v67x4t5U2opOyn82tZmQIDAQABo28wbTAdBgNVHQ4E
FgQUnEZ7dYEMUbNkkacyVOagmnQQ1RwwHwYDVR0jBBgwFoAUnEZ7dYEMUbNkkacy
VOagmnQQ1RwwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAIWBOeQF6MgJy1ClL0ceNDTaeY5Y8sei
r/Dt7FhjYFAi0VOkoiSMs2emRJ4Js0hNg4WdCdPT+6Pg/K66RFKmYezaTQUf1EAM
Xngsq7CNAX/ldzOatFQ6zba5MmWrM/xKZ0k/OhWCMmiorru2OVXHySY2xcG6BdOH
C31ttgbD4CoPddtCzM1A5rGr/ymyTn8iQc5fHZ0heK/S5kDurLVLuYGvsFsQUJCG
wi/xwD0B+6pshAtWQ/YS0I/pjapaYWo57h1z9kWWEYHuSWUFRKHEOXcwNNMWglRc
XiouVCFw4voLipeQECOYjuXIO3Z7LwAeU3+NBaVckSfz5Ce3nfNOnm8=
-----END CERTIFICATE-----`;

// A fake relay. Options shape its behaviour: whether it offers STARTTLS, which
// AUTH mechanisms it advertises, whether it accepts the login, and whether it is
// implicit-TLS from the first byte. It records the credential it was given and
// any message it received, so a test can assert what actually reached it.
function fakeRelay(options = {}) {
  const {
    advertiseAuth = ['PLAIN', 'LOGIN'],
    greeting = '220 fake ESMTP ready',
    implicitTls = false,
    rejectAuth = false,
    starttls = false,
  } = options;
  const state = { auth: null, connections: 0, messages: [] };

  function handle(socket, { secured, sendGreeting }) {
    socket.setEncoding('utf8');
    let buffer = '';
    let mode = 'command';
    let login = null;
    let dataLines = [];
    if (sendGreeting) socket.write(`${greeting}\r\n`);

    const reply = (line) => socket.write(`${line}\r\n`);

    const ehloReply = () => {
      const lines = ['fake greets you'];
      if (starttls && !secured) lines.push('STARTTLS');
      if (advertiseAuth.length) lines.push(`AUTH ${advertiseAuth.join(' ')}`);
      lines.push('HELP');
      for (let i = 0; i < lines.length; i += 1) reply(`250${i === lines.length - 1 ? ' ' : '-'}${lines[i]}`);
    };

    const onLine = (line) => {
      if (mode === 'data') {
        if (line === '.') {
          mode = 'command';
          state.messages.push(dataLines.join('\n'));
          dataLines = [];
          reply('250 2.0.0 Queued');
        } else {
          dataLines.push(line);
        }
        return;
      }
      if (login) {
        if (login === 'user') { login = 'pass'; reply('334 UGFzc3dvcmQ6'); return; }
        login = null;
        reply(rejectAuth ? '535 5.7.8 Authentication failed' : '235 2.7.0 Accepted');
        return;
      }
      const [verb, ...rest] = line.split(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO': case 'HELO': ehloReply(); break;
        case 'STARTTLS':
          if (!starttls || secured) { reply('502 5.5.1 Not available'); break; }
          reply('220 2.0.0 Ready to start TLS');
          upgrade(socket);
          return;
        case 'AUTH': {
          const mechanism = (rest[0] || '').toUpperCase();
          if (mechanism === 'PLAIN') {
            state.auth = { mechanism: 'PLAIN', payload: rest[1] || '' };
            reply(rejectAuth ? '535 5.7.8 Authentication failed' : '235 2.7.0 Accepted');
          } else if (mechanism === 'LOGIN') {
            login = 'user';
            reply('334 VXNlcm5hbWU6');
          } else {
            reply('504 5.5.4 Unsupported mechanism');
          }
          break;
        }
        case 'MAIL': reply('250 2.1.0 Sender OK'); break;
        case 'RCPT': reply('250 2.1.5 Recipient OK'); break;
        case 'DATA': mode = 'data'; reply('354 End data with <CRLF>.<CRLF>'); break;
        case 'RSET': reply('250 2.0.0 Reset'); break;
        case 'NOOP': reply('250 2.0.0 OK'); break;
        case 'QUIT': reply('221 2.0.0 Bye'); socket.end(); break;
        default: reply('500 5.5.2 Unrecognized');
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\r\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        onLine(line);
        index = buffer.indexOf('\r\n');
      }
    });
    socket.on('error', () => {});
  }

  function upgrade(plainSocket) {
    const secure = new tls.TLSSocket(plainSocket, { cert: TEST_CERT, isServer: true, key: TEST_KEY });
    secure.on('secure', () => handle(secure, { secured: true, sendGreeting: false }));
    secure.on('error', () => {});
  }

  const server = implicitTls
    ? tls.createServer({ cert: TEST_CERT, key: TEST_KEY }, (socket) => { state.connections += 1; handle(socket, { secured: true, sendGreeting: true }); })
    : net.createServer((socket) => { state.connections += 1; handle(socket, { secured: false, sendGreeting: true }); });

  return { server, state };
}

function listen(fake) {
  return new Promise((resolve) => {
    fake.server.listen(0, '127.0.0.1', () => resolve({ ...fake, close: () => new Promise((done) => fake.server.close(done)), port: fake.server.address().port }));
  });
}

function relay(port, overrides = {}) {
  return { allowInvalidCert: true, fromAddress: 'me@example.com', fromName: 'Tester', host: '127.0.0.1', password: 'pw-secret', port, security: 'none', username: 'me@example.com', ...overrides };
}

test('parseReply returns null until a reply is whole, then joins its lines', () => {
  assert.equal(parseReply('250-first\r\n250-second\r\n'), null);
  const reply = parseReply('250-first\r\n250 second\r\n');
  assert.equal(reply.code, 250);
  assert.equal(reply.text, 'first\nsecond');
  assert.equal(parseReply('220 ready\r\n').code, 220);
});

test('an unauthenticated plaintext relay verifies', async () => {
  const fake = await listen(fakeRelay({ advertiseAuth: [] }));
  try {
    const result = await verifyRelay(relay(fake.port, { username: '', password: '' }));
    assert.equal(result.secured, false);
    assert.equal(result.authenticated, false);
  } finally {
    await fake.close();
  }
});

test('AUTH PLAIN is used when the relay advertises it, and carries the credential', async () => {
  const fake = await listen(fakeRelay({ advertiseAuth: ['PLAIN'] }));
  try {
    await verifyRelay(relay(fake.port));
    const decoded = Buffer.from(fake.state.auth.payload, 'base64').toString('utf8');
    assert.equal(fake.state.auth.mechanism, 'PLAIN');
    assert.equal(decoded, ' me@example.com pw-secret');
  } finally {
    await fake.close();
  }
});

test('AUTH LOGIN is used when PLAIN is not offered', async () => {
  const fake = await listen(fakeRelay({ advertiseAuth: ['LOGIN'] }));
  try {
    const result = await verifyRelay(relay(fake.port));
    assert.equal(result.authenticated, true);
  } finally {
    await fake.close();
  }
});

test('a rejected login fails with the relay message and no credential in it', async () => {
  const fake = await listen(fakeRelay({ advertiseAuth: ['PLAIN'], rejectAuth: true }));
  try {
    await assert.rejects(verifyRelay(relay(fake.port)), (error) => {
      assert.ok(error instanceof SmtpError);
      assert.equal(error.code, 'SMTP_COMMAND_REJECTED');
      assert.match(error.message, /Authentication failed/u);
      assert.ok(!error.message.includes('pw-secret'), 'the password must not appear in the error');
      assert.ok(!error.message.includes('AUTH PLAIN'), 'the auth command line must not appear in the error');
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('STARTTLS upgrades the connection, then authenticates over TLS', async () => {
  const fake = await listen(fakeRelay({ advertiseAuth: ['PLAIN'], starttls: true }));
  try {
    const result = await verifyRelay(relay(fake.port, { security: 'starttls' }));
    assert.equal(result.secured, true);
    assert.ok(fake.state.auth, 'the relay saw the login only after the upgrade');
  } finally {
    await fake.close();
  }
});

test('STARTTLS refuses rather than sending the login in the clear when the relay does not offer it', async () => {
  const fake = await listen(fakeRelay({ advertiseAuth: ['PLAIN'], starttls: false }));
  try {
    await assert.rejects(verifyRelay(relay(fake.port, { security: 'starttls' })), (error) => {
      assert.equal(error.code, 'SMTP_STARTTLS_UNAVAILABLE');
      assert.equal(fake.state.auth, null, 'no credential was sent');
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('implicit TLS connects encrypted from the first byte', async () => {
  const fake = await listen(fakeRelay({ advertiseAuth: ['PLAIN'], implicitTls: true }));
  try {
    const result = await verifyRelay(relay(fake.port, { security: 'tls' }));
    assert.equal(result.secured, true);
  } finally {
    await fake.close();
  }
});

test('an untrusted certificate is refused unless the relay is acknowledged insecure', async () => {
  const fake = await listen(fakeRelay({ advertiseAuth: ['PLAIN'], implicitTls: true }));
  try {
    await assert.rejects(verifyRelay(relay(fake.port, { allowInvalidCert: false, security: 'tls' })), (error) => {
      assert.equal(error.code, 'SMTP_CONNECTION_FAILED');
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('a greeting that declines the connection is surfaced, not pushed past', async () => {
  const fake = await listen(fakeRelay({ greeting: '554 no service here' }));
  try {
    await assert.rejects(verifyRelay(relay(fake.port, { username: '', password: '' })), (error) => {
      assert.equal(error.code, 'SMTP_GREETING_REJECTED');
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('a test message is delivered through the relay and its body reaches DATA intact', async () => {
  const fake = await listen(fakeRelay({ advertiseAuth: ['PLAIN'] }));
  try {
    const result = await sendTestMessage(relay(fake.port), { subject: 'Hello', text: 'Line one.\n.Line two starts with a dot.', to: 'you@example.com' });
    assert.match(result.messageId, /@example\.com>$/u);
    assert.equal(fake.state.messages.length, 1);
    const message = fake.state.messages[0];
    assert.match(message, /^From: "Tester" <me@example\.com>/u);
    assert.match(message, /^To: <you@example\.com>/mu);
    assert.match(message, /Content-Transfer-Encoding: base64/u);
    // The base64 body decodes back to exactly what was sent, dot and all.
    const body = message.split('\n\n').slice(1).join('\n\n').replace(/\s+/gu, '');
    assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Line one.\n.Line two starts with a dot.');
  } finally {
    await fake.close();
  }
});

test('a connection to a port nobody answers fails as a connection error, in time', async () => {
  // Port 1 is not listening; connecting fails fast with a coded error.
  await assert.rejects(verifyRelay(relay(1, { host: '127.0.0.1', username: '', password: '' }), { timeoutMs: 2000 }), (error) => {
    assert.ok(error instanceof SmtpError);
    assert.equal(error.code, 'SMTP_CONNECTION_FAILED');
    return true;
  });
});
