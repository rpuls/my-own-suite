// The console banner is the last screen of a self-host install and the only one
// that cannot be corrected afterwards by someone who cannot reach the machine.
// Three of its constraints are invisible in the source: the Linux console font
// carries 256 glyphs, a console can be 80x25, and the Easy Door name it prints
// has to be the one Suite Manager's host gate admits.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const { easyDoorHomeHost } = require('../../shared/easy-door.cjs');
const { renderCaddyfile } = require('../../infrastructure/control-plane-runtime.cjs');

const easyDoorModule = path.resolve(__dirname, '..', '..', 'shared', 'easy-door.cjs');
const script = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'image-builder', 'payload', 'mos-first-boot'),
  'utf8',
).replace(/\r\n/gu, '\n');

// The longest value each substitution can carry on a real machine. The Easy Door
// name is longest inside 172.16/12 and 192.168/16, and the docs URL is the one
// `render-bake-seed.cjs` bakes in.
const WIDEST = {
  docs_url: 'https://myownsuite.org/docs/install/own-hardware/',
  domain: 'mos.home',
  easy_host: 'home.192-168-255-255.local.myownsuite.org',
  home_url: 'http://home.mos.home/',
  lan_ip: '255.255.255.255',
};

function bannerLines() {
  const block = script.split('banner=/etc/issue.d/10-mos-address.issue')[1];
  return block.split('} > "$banner"')[0].split('\n');
}

// Widest rendered width of one printf, with ANSI escapes removed: they move the
// cursor without consuming a column.
function renderedWidth(line) {
  const format = line.match(/^\s*printf\s+'([^']*)'/u)[1];
  const args = [...line.matchAll(/"\$([a-z_]+)"/gu)].map((match) => match[1]);
  let index = 0;
  return format
    .replace(/\\033\[[0-9;]*m/gu, '')
    .replace(/\\n$/u, '')
    .replace(/%(-?\d+)?s/gu, (_match, width) => {
      const value = WIDEST[args[index]];
      index += 1;
      assert.ok(value, `mos-first-boot substitutes an unknown variable: ${args[index - 1]}`);
      return width ? value.padEnd(Math.abs(Number(width))) : value;
    })
    .length;
}

// The tallest path through the banner's if/else structure, one line per printf.
function tallestPath(lines, start = 0) {
  let count = 0;
  let index = start;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (line === 'fi' || line === 'else') return { count, next: index };
    if (line.startsWith('if ')) {
      const taken = tallestPath(lines, index + 1);
      let otherwise = 0;
      let next = taken.next;
      if (lines[next].trim() === 'else') {
        const skipped = tallestPath(lines, next + 1);
        otherwise = skipped.count;
        next = skipped.next;
      }
      count += Math.max(taken.count, otherwise);
      index = next + 1;
      continue;
    }
    if (line.startsWith('printf ')) count += 1;
    index += 1;
  }
  return { count, next: index };
}

test('the banner fits an 80x25 console and stays inside the console font', () => {
  const lines = bannerLines();
  const printfs = lines.filter((line) => line.trim().startsWith('printf '));
  assert.ok(printfs.length > 10, 'the banner block was not found');

  for (const line of printfs) {
    const format = line.match(/^\s*printf\s+'([^']*)'/u)[1];
    assert.equal(format.match(/\\n/gu)?.length, 1, `one line per printf: ${format}`);
    assert.ok(format.endsWith('\\n'), `printf must end its line: ${format}`);
    assert.ok(renderedWidth(line) <= 80, `wider than an 80-column console: ${format}`);
    // ✓, ▸ and — render blank in a 256-glyph console font; » is Latin-1 and does not.
    for (const character of format) {
      assert.ok(character.codePointAt(0) <= 0xff, `outside Latin-1 and blank on the console: ${character}`);
    }
  }

  // agetty prints /etc/issue and then the login prompt after this file, so the
  // banner cannot claim all 25 rows.
  assert.ok(tallestPath(lines).count <= 22, 'the tallest banner path no longer fits above the login prompt');
});

test('the banner derives the Easy Door name rather than reimplementing it', () => {
  assert.match(script, /easy_door_module=\/opt\/mos\/repo\/shared\/easy-door\.cjs/u);
  assert.match(script, /"\$easy_door_module" home-host "\$lan_ip"/u);
  assert.match(script, /"\$easy_door_module" address/u);
  // A second implementation of "this machine's LAN address" or of the dashed
  // name is exactly the divergence that puts an unserved address on the screen.
  assert.doesNotMatch(script, /local\.myownsuite\.org/u);
  assert.doesNotMatch(script, /tr '\.' '-'|sed 's\/\\\.\/-\/|192\.168/u);

  // Every Easy Door line sits behind the derived name being non-empty, so a
  // public address or a closed door prints the first door alone.
  const easyDoorBlock = script.split('if [ -n "$easy_host" ]; then')[1].split('else')[0];
  assert.match(easyDoorBlock, /If it cannot/u);
  assert.match(easyDoorBlock, /http:\/\/%s\//u);
  assert.match(easyDoorBlock, /No answer on the second address/u);
  assert.doesNotMatch(script.split('if [ -n "$easy_host" ]; then')[0], /If it cannot/u);

  // Both doors need the reservation, so it is stated before either of them.
  const withAddress = script.split('if [ -n "$lan_ip" ]; then')[1];
  assert.ok(withAddress.indexOf('reserve this address') < withAddress.indexOf('If your router or Pi-hole'));
  assert.match(withAddress, /trusted HTTPS needs a domain of your own/u);
});

test('the Easy Door CLI answers with the name the host gate admits', () => {
  const caddyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-first-boot-'));
  const open = path.join(caddyDir, 'Caddyfile');
  const closed = path.join(caddyDir, 'Caddyfile.https');
  fs.writeFileSync(open, renderCaddyfile());
  fs.writeFileSync(closed, 'http://home.mos.example.com {\n  reverse_proxy 127.0.0.1:3100\n}\n');

  const cli = (args, caddyfilePath) => execFileSync(process.execPath, [easyDoorModule, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MOS_CADDYFILE_PATH: caddyfilePath },
  }).trim();

  for (const address of ['192.168.123.45', '10.0.0.5', '172.16.0.1']) {
    assert.equal(cli(['home-host', address], open), easyDoorHomeHost(address));
  }
  // A public address has no Easy Door: the nameserver refuses those names, so
  // the banner must print the first door alone rather than a dead second one.
  assert.equal(cli(['home-host', '203.0.113.9'], open), '');
  assert.equal(cli(['home-host', '192.168.123.45'], closed), '');
  assert.equal(cli(['home-host', ''], closed), '');
});
