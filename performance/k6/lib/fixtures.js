const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function loadFixtureManifest(path, expectedRunId) {
  if (!path) {
    throw new Error('FIXTURE_MANIFEST is required');
  }
  const manifest = JSON.parse(open(path));
  if (manifest.version !== 1 || !Array.isArray(manifest.actors)) {
    throw new Error('unsupported fixture manifest');
  }
  if (!SAFE_RUN_ID.test(manifest.runId || '')) {
    throw new Error('fixture manifest has an invalid runId');
  }
  if (expectedRunId && manifest.runId !== expectedRunId) {
    throw new Error('fixture manifest runId does not match PERFORMANCE_RUN_ID');
  }
  if (manifest.actors.length === 0) {
    throw new Error('fixture manifest contains no actors');
  }
  for (const actor of manifest.actors) {
    if (
      !actor.userId ||
      !actor.sessionId ||
      !actor.publicKey ||
      !actor.privateKey
    ) {
      throw new Error('fixture actor is missing credentials');
    }
  }
  return manifest;
}

export function actorForVU(manifest, vu = __VU) {
  const index = Math.max(0, Number(vu || 1) - 1) % manifest.actors.length;
  return manifest.actors[index];
}

export function assertSafeTarget(rawURL) {
  const parsed = parseTarget(rawURL);
  if (parsed.authority.includes('@')) {
    throw new Error('target URL must not contain credentials');
  }
  const host = parsed.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return;
  }
  if (__ENV.PERF_ALLOW_REMOTE !== '1') {
    throw new Error(`remote target ${host} requires PERF_ALLOW_REMOTE=1`);
  }
  const allowed = (__ENV.PERF_ALLOWED_HOSTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(host)) {
    throw new Error(`remote target ${host} is not in PERF_ALLOWED_HOSTS`);
  }
}

export function parseTarget(rawURL) {
  const match = String(rawURL || '').match(
    /^(https?|wss?):\/\/([^/?#]+)([^?#]*)?(?:\?[^#]*)?(?:#.*)?$/i,
  );
  if (!match) {
    throw new Error('target must be an absolute http(s) or ws(s) URL');
  }
  const authority = match[2];
  let hostname = authority;
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']');
    if (closingBracket < 0) {
      throw new Error('invalid IPv6 target authority');
    }
    hostname = authority.slice(1, closingBracket);
  } else {
    hostname = authority.split(':', 1)[0];
  }
  return {
    scheme: match[1].toLowerCase(),
    authority,
    hostname: hostname.toLowerCase(),
    path: match[3] || '',
  };
}