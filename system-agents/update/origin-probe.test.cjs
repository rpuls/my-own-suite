const assert = require('node:assert/strict');
const test = require('node:test');

const { conclude, filterCurlTrace, loginSources, scrub } = require('./origin-probe.cjs');

// A real `GIT_TRACE_CURL` capture of git asking GitHub for a repository it
// does not show, followed by a retry with a login found by a credential helper.
const TRACE = `
22:45:16.404629 http.c:915              == Info: Couldn't find host github.com in the .netrc file; using defaults
22:45:16.421734 http.c:915              == Info: IPv4: 140.82.121.3
22:45:16.421734 http.c:915              == Info:   Trying 140.82.121.3:443...
22:45:16.453937 http.c:915              == Info: schannel: disabled automatic use of client certificate
22:45:16.475916 http.c:915              == Info: ALPN: server accepted http/1.1
22:45:16.475916 http.c:915              == Info: Established connection to github.com (140.82.121.3 port 443) from 192.168.20.10 port 61269
22:45:16.475916 http.c:862              => Send header, 0000000226 bytes (0x000000e2)
22:45:16.475916 http.c:874              => Send header: GET /rpuls/my-own-suite.git/info/refs?service=git-upload-pack HTTP/1.1
22:45:16.475916 http.c:874              => Send header: Host: github.com
22:45:16.475916 http.c:874              => Send header: User-Agent: git/2.52.0.windows.1
22:45:16.475916 http.c:874              => Send header: Accept: */*
22:45:16.475916 http.c:874              => Send header: Accept-Encoding: deflate, gzip, br, zstd
22:45:16.475916 http.c:874              => Send header: Pragma: no-cache
22:45:16.475916 http.c:874              => Send header: Git-Protocol: version=2
22:45:16.475916 http.c:874              => Send header:
22:45:16.475916 http.c:915              == Info: Request completely sent off
22:45:16.640069 http.c:874              <= Recv header: HTTP/1.1 401 Unauthorized
22:45:16.640069 http.c:874              <= Recv header: Server: GitHub-Babel/3.0
22:45:16.640069 http.c:874              <= Recv header: Content-Security-Policy: default-src 'none'; sandbox
22:45:16.640069 http.c:874              <= Recv header: Content-Type: text/plain; charset=UTF-8
22:45:16.640069 http.c:874              <= Recv header: Strict-Transport-Security: max-age=31536000
22:45:16.640069 http.c:874              <= Recv header: www-authenticate: Basic realm="GitHub"
22:45:16.640069 http.c:874              <= Recv header: Content-Length: 21
22:45:16.640069 http.c:874              <= Recv header: X-GitHub-Request-Id: AA56:3AAB7B:4193A4C:3730533:6A988ABD
22:45:16.640069 http.c:874              <= Recv header:
22:45:16.640069 http.c:915              == Info: Connection #0 to host github.com:443 left intact
22:45:17.076807 http.c:915              == Info: Server auth using Basic with user 'ghp_abcdefghijklmnop'
22:45:17.076807 http.c:874              => Send header: GET /rpuls/my-own-suite.git/info/refs?service=git-upload-pack HTTP/1.1
22:45:17.076807 http.c:874              => Send header: Authorization: Basic <redacted>
`;

test('a curl trace is reduced to the request, the login it carried, and the answer', () => {
  const lines = filterCurlTrace(TRACE);
  assert.deepEqual(lines, [
    "Couldn't find host github.com in the .netrc file; using defaults",
    'IPv4: 140.82.121.3',
    'Trying 140.82.121.3:443...',
    'Established connection to github.com (140.82.121.3 port 443) from 192.168.20.10 port 61269',
    'GET /rpuls/my-own-suite.git/info/refs?service=git-upload-pack HTTP/1.1',
    'Host: github.com',
    'User-Agent: git/2.52.0.windows.1',
    'Git-Protocol: version=2',
    'HTTP/1.1 401 Unauthorized',
    'Server: GitHub-Babel/3.0',
    'Content-Type: text/plain; charset=UTF-8',
    'www-authenticate: Basic realm="GitHub"',
    'X-GitHub-Request-Id: AA56:3AAB7B:4193A4C:3730533:6A988ABD',
    "Server auth using Basic with user '<redacted>'",
    'GET /rpuls/my-own-suite.git/info/refs?service=git-upload-pack HTTP/1.1',
    'Authorization: <redacted>',
  ]);
});

test('scrubbing removes every form a login takes in git and curl output', () => {
  assert.equal(scrub('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: <redacted>');
  assert.equal(scrub('proxy-authorization: Bearer abc'), 'proxy-authorization: <redacted>');
  assert.equal(scrub('url.https://x-access-token:ghp_1234567890abcdef@github.com/.insteadof'), 'url.https://<redacted>@github.com/.insteadof');
  assert.equal(scrub("Server auth using Basic with user 'rpuls'"), "Server auth using Basic with user '<redacted>'");
  assert.equal(scrub('token github_pat_11ABCDEFG_xyz123456789 rejected'), 'token <redacted> rejected');
  assert.equal(scrub('GET /rpuls/my-own-suite.git/info/refs HTTP/1.1'), 'GET /rpuls/my-own-suite.git/info/refs HTTP/1.1');
});

test('login sources name the key and the file, and never the value of an extra header', () => {
  assert.deepEqual(loginSources([
    'file:/root/.gitconfig\tcredential.helper store',
    'file:/etc/gitconfig\thttp.extraheader Authorization: Basic c2VjcmV0',
    'file:/root/.gitconfig\turl.https://ghp_abcdefghijklmnop@github.com/.insteadof https://github.com/',
  ].join('\n')), [
    'credential.helper = store (/root/.gitconfig)',
    'http.extraheader = <redacted> (/etc/gitconfig)',
    'url.https://<redacted>@github.com/.insteadof = https://github.com/ (/root/.gitconfig)',
  ]);
  assert.deepEqual(loginSources(''), []);
});

test('the conclusion follows from the plain request, not from git\'s wording', () => {
  const gitSaid = ["fatal: could not read Username for 'https://github.com': terminal prompts disabled"];
  const base = { gitSaid, host: 'github.com', remote: 'https://github.com/rpuls/my-own-suite.git' };
  const answer = (status, extra = {}) => ({ body: '', error: null, headers: [], remoteAddress: '140.82.121.4', status, statusMessage: 'x', ...extra });

  assert.match(conclude({ ...base, direct: answer(200), sentLogin: true }), /git on this server sends a stored login/u);
  assert.match(conclude({ ...base, direct: answer(200), sentLogin: false }), /yet git's own request failed: fatal: could not read Username/u);
  assert.equal(
    conclude({ ...base, direct: answer(401, { body: 'Repository not found.', headers: ['x-github-request-id: AB12:CD34'] }), sentLogin: false }),
    'github.com answered a plain request from this server for this repository with HTTP 401 "Repository not found.". No login was sent, so either the repository is not public or github.com is declining this server. github.com can look up request AB12:CD34.',
  );
  assert.match(conclude({ ...base, direct: answer(429, { headers: ['retry-after: 60'] }), sentLogin: false }), /limiting requests from this server's address \(HTTP 429, retry after 60 seconds\)/u);
  assert.match(conclude({ ...base, direct: answer(403, { headers: ['x-ratelimit-remaining: 0'] }), sentLogin: false }), /limiting requests/u);
  assert.match(conclude({ ...base, direct: answer(502), sentLogin: false }), /HTTP 502 x: it is having trouble on its side/u);
  assert.match(conclude({ ...base, direct: answer(301, { headers: ['location: https://github.com/rpuls/renamed.git/info/refs'] }), sentLogin: false }), /redirects this repository to https:\/\/github.com\/rpuls\/renamed.git/u);
  assert.equal(conclude({ ...base, direct: { error: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND github.com' } }, sentLogin: false }), 'This server could not reach github.com: getaddrinfo ENOTFOUND github.com.');
  assert.equal(conclude({ ...base, direct: null, sentLogin: false }), "Fetching from https://github.com/rpuls/my-own-suite.git failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled");
});
