const fs = require('node:fs');

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return SUPPORTED_PROTOCOLS.has(url.protocol) && Boolean(url.hostname) && !url.hostname.includes('*');
  } catch {
    return false;
  }
}

function parseSiteAddress(value) {
  const candidate = value.startsWith('http://') || value.startsWith('https://')
    ? value
    : `https://${value}`;

  try {
    const url = new URL(candidate);
    if (!SUPPORTED_PROTOCOLS.has(url.protocol) || !url.hostname || url.hostname.includes('*')) {
      return null;
    }

    if (url.pathname !== '/' || url.search || url.hash) {
      return null;
    }

    return {
      host: url.hostname.toLowerCase(),
      siteAddress: value,
    };
  } catch {
    return null;
  }
}

function parseUpstream(value) {
  try {
    const url = new URL(value);
    if (!SUPPORTED_PROTOCOLS.has(url.protocol) || !url.hostname || url.hostname.includes('*')) {
      return null;
    }

    if (url.pathname !== '/' || url.search || url.hash) {
      return null;
    }

    return {
      protocol: url.protocol,
      upstream: url.toString().endsWith('/') ? url.toString().slice(0, -1) : url.toString(),
    };
  } catch {
    return null;
  }
}

function createError(line, message) {
  return { line, message };
}

function validateGeneratedExternalProxySnippet(content) {
  const errors = [];
  const routes = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const seenHosts = new Map();
  let index = 0;

  function currentLineNumber() {
    return index + 1;
  }

  function skipNoise() {
    while (index < lines.length) {
      const trimmed = lines[index].trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        index += 1;
        continue;
      }
      break;
    }
  }

  while (index < lines.length) {
    skipNoise();

    if (index >= lines.length) {
      break;
    }

    const siteMatch = lines[index].match(/^([^\s{}]+) \{$/);
    if (!siteMatch) {
      errors.push(createError(currentLineNumber(), 'Expected a generated Caddy site block.'));
      break;
    }

    const siteLine = currentLineNumber();
    const site = parseSiteAddress(siteMatch[1]);
    if (!site) {
      errors.push(createError(siteLine, 'Generated Caddy site address must be an http/https host without wildcards or paths.'));
    }
    index += 1;

    const proxyMatch = lines[index]?.match(/^\treverse_proxy ([^\s{}]+)(?: \{)?$/);
    if (!proxyMatch) {
      errors.push(createError(currentLineNumber(), 'Expected a generated reverse_proxy directive.'));
      break;
    }

    const proxyLine = currentLineNumber();
    const upstream = parseUpstream(proxyMatch[1]);
    if (!upstream) {
      errors.push(createError(proxyLine, 'Generated reverse_proxy upstream must be an origin-only http/https URL.'));
    }

    const hasProxyBlock = lines[index].endsWith(' {');
    index += 1;
    let tlsInsecureSkipVerify = false;

    if (hasProxyBlock) {
      const expectedBlock = [
        '\t\ttransport http {',
        '\t\t\ttls_insecure_skip_verify',
        '\t\t}',
        '\t}',
      ];

      for (const expected of expectedBlock) {
        if (lines[index] !== expected) {
          errors.push(createError(currentLineNumber(), 'Expected the generated TLS transport block shape.'));
          break;
        }
        index += 1;
      }

      tlsInsecureSkipVerify = true;
      if (upstream && upstream.protocol !== 'https:') {
        errors.push(createError(proxyLine, 'TLS skip verification is only valid for HTTPS upstreams.'));
      }
    }

    if (lines[index] !== '}') {
      errors.push(createError(currentLineNumber(), 'Expected the generated site block closing brace.'));
      break;
    }
    index += 1;

    if (site) {
      const previousLine = seenHosts.get(site.host);
      if (previousLine) {
        errors.push(createError(siteLine, `Duplicate generated external proxy host also appears on line ${previousLine}.`));
      } else {
        seenHosts.set(site.host, siteLine);
      }
    }

    if (site && upstream) {
      routes.push({
        host: site.host,
        siteAddress: site.siteAddress,
        tlsInsecureSkipVerify,
        upstream: upstream.upstream,
      });
    }
  }

  return {
    errors,
    routes: errors.length === 0 ? routes : [],
    valid: errors.length === 0,
  };
}

function validateGeneratedExternalProxySnippetFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      errors: [],
      routes: [],
      valid: true,
    };
  }

  return validateGeneratedExternalProxySnippet(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  isHttpUrl,
  validateGeneratedExternalProxySnippet,
  validateGeneratedExternalProxySnippetFile,
};
