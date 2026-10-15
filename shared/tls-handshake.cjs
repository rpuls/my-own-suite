const tls = require('node:tls');

// One TLS handshake to a local listener for a name, verified against the
// system's trust store: it succeeds only once a real certificate is being
// served for exactly that host. Resolves with the leaf certificate.
function tlsHandshake({ host, port, servername, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: true, servername, timeout: timeoutMs }, () => {
      const certificate = socket.getPeerCertificate();
      socket.end();
      resolve(certificate);
    });
    socket.on('timeout', () => socket.destroy(new Error('the TLS handshake timed out')));
    socket.on('error', reject);
  });
}

module.exports = { tlsHandshake };
