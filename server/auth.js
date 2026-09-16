/**
 * Admin authentication.
 *
 * One shared password guards the configuration page. There is no user table:
 * the password lives in the config file and a signed, expiring cookie carries
 * the session. That is deliberately the smallest thing that is still not
 * obviously wrong.
 *
 *   * The token is `<expiryMs>.<hmac>` -- no server-side session store, and
 *     tampering with the expiry invalidates the signature.
 *   * Password comparison is constant-time and compares SHA-256 digests of both
 *     sides, so neither the length nor a prefix of the secret leaks by timing.
 *   * Repeated failures from one address are locked out briefly, which is what
 *     makes a single shared password defensible on a reachable network.
 *
 * LIMITATION: the service speaks plain HTTP, so the password crosses the network
 * in the clear. On a trusted intranet that may be acceptable; otherwise put it
 * behind HTTPS or reach it through an SSH tunnel. This is documented in the
 * README rather than silently ignored.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'gpustatus_admin';

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export function generateSecret() {
  return randomBytes(32).toString('hex');
}

/** Parse a Cookie header into a plain object. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export class Auth {
  constructor(adminConfig, secret) {
    this.config = adminConfig;
    this.secret = secret;
    /** @type {Map<string, {count: number, firstAt: number}>} */
    this.failures = new Map();
  }

  /** False when no password is configured, i.e. the admin page cannot be used. */
  get enabled() {
    return Boolean(this.config?.password || this.config?.passwordSha256);
  }

  #digest(value) {
    return createHash('sha256').update(String(value), 'utf8').digest();
  }

  verifyPassword(candidate) {
    if (!this.enabled || typeof candidate !== 'string') return false;

    let expected;
    if (this.config.passwordSha256) {
      if (!/^[0-9a-f]{64}$/.test(this.config.passwordSha256)) return false;
      expected = Buffer.from(this.config.passwordSha256, 'hex');
    } else {
      expected = this.#digest(this.config.password);
    }
    return timingSafeEqual(this.#digest(candidate), expected);
  }

  issueToken(now = Date.now()) {
    const expiry = String(now + this.config.sessionHours * 3600 * 1000);
    const signature = createHmac('sha256', this.secret).update(expiry).digest('hex');
    return `${expiry}.${signature}`;
  }

  verifyToken(token, now = Date.now()) {
    if (typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;

    const expiry = token.slice(0, dot);
    const signature = token.slice(dot + 1);

    // Compare HEX DIGESTS, not the raw strings.
    //
    // `signature.length` counts UTF-16 code units while `timingSafeEqual`
    // compares BYTE lengths, and HTTP headers arrive latin-1 decoded. A cookie
    // whose signature is 64 characters with one byte >= 0x80 therefore passed
    // the old `signature.length !== expected.length` guard (64 === 64) while
    // encoding to 65 UTF-8 bytes, and timingSafeEqual threw
    // "Input buffers must have the same byte length" -- turning a bad cookie
    // into a 500 instead of a clean "not logged in".
    //
    // Decoding both sides as hex makes the buffers exactly 32 bytes by
    // construction, so the lengths can never disagree.
    if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
    const given = Buffer.from(signature, 'hex');
    const expected = Buffer.from(
      createHmac('sha256', this.secret).update(expiry).digest('hex'),
      'hex',
    );
    if (!timingSafeEqual(given, expected)) return false;

    const expiresAt = Number(expiry);
    return Number.isFinite(expiresAt) && expiresAt > now;
  }

  // --- brute-force damping --------------------------------------------------
  isLockedOut(ip, now = Date.now()) {
    const record = this.failures.get(ip);
    if (!record) return false;
    if (now - record.firstAt > LOCKOUT_MS) {
      this.failures.delete(ip);
      return false;
    }
    return record.count >= MAX_FAILURES;
  }

  noteFailure(ip, now = Date.now()) {
    const record = this.failures.get(ip);
    if (!record || now - record.firstAt > LOCKOUT_MS) {
      this.failures.set(ip, { count: 1, firstAt: now });
      return;
    }
    record.count += 1;
  }

  noteSuccess(ip) {
    this.failures.delete(ip);
  }

  /** Set-Cookie value for a successful login. */
  sessionCookie(token) {
    const maxAge = this.config.sessionHours * 3600;
    // SameSite=Strict: the admin API is never called cross-site.
    // `Secure` is omitted because the service is plain HTTP on an intranet;
    // adding it would stop the cookie being stored at all.
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  }

  clearCookie() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
}
