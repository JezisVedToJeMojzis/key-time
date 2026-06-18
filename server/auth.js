// Auth helpers: stateless signed device tokens (no passwords).
// Tokens are `userId.HMAC(userId)` — verified by recomputing the HMAC, so there's
// nothing to store server-side. The token lives on the device and is the identity.
import crypto from 'node:crypto';

// A stable secret so tokens survive restarts. Falls back to the VAPID private
// key (already stable + secret) so no extra config is needed to get going.
const SECRET =
  process.env.AUTH_SECRET || process.env.VAPID_PRIVATE_KEY || 'key-time-dev-secret';

export function signToken(userId) {
  const mac = crypto.createHmac('sha256', SECRET).update(userId).digest('base64url');
  return `${userId}.${mac}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const userId = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(userId).digest('base64url');
  if (mac.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return userId;
}

// Validation for usernames: 3–20 chars — letters, digits, spaces and _ . ' -
// (spaces allowed so display-style names like "King Moses" work). Trim first.
export function validUsername(name) {
  return typeof name === 'string' && /^[\p{L}\p{N} _.'-]{3,20}$/u.test(name);
}
