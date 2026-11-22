// GitHub answers a spent unauthenticated quota with 403 or 429 and a remaining
// count of zero. Any other 403 is a refusal that waiting does not cure, so the
// two must not share an error.
function rateLimit(response) {
  if (![403, 429].includes(response.status) || response.headers.get('x-ratelimit-remaining') !== '0') return null;
  const resetAt = Number(response.headers.get('x-ratelimit-reset'));
  return { retryAt: Number.isFinite(resetAt) && resetAt > 0 ? new Date(resetAt * 1000).toISOString() : null };
}

module.exports = { rateLimit };
