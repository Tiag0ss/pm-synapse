import logger from '../utils/logger';

const WEAK = new Set(['', 'dev-only-secret', 'dev-only-key', 'change-me', 'change-me-synapse-jwt-secret']);

function isWeakSecret(value: string | undefined, minLen: number): boolean {
  if (!value) return true;
  const v = value.trim();
  if (v.length < minLen) return true;
  if (WEAK.has(v)) return true;
  if (/^change-me/i.test(v)) return true;
  return false;
}

/**
 * Fail fast in production when session/crypto secrets are missing or weak.
 * In development, log loud warnings but keep local DX working.
 */
export function assertRuntimeSecrets(): void {
  const isProd = process.env.NODE_ENV === 'production';
  const jwt = process.env.JWT_SECRET;
  const enc = process.env.ENCRYPTION_KEY;

  const jwtWeak = isWeakSecret(jwt, 32);
  const encMissing = !enc || !enc.trim();
  const encWeak = isWeakSecret(enc, 32);
  const sameKey = Boolean(jwt && enc && jwt === enc);

  if (jwtWeak) {
    const msg =
      'JWT_SECRET is missing or weak (need ≥32 chars, not a placeholder). Generate with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"';
    if (isProd) {
      logger.error(msg);
      process.exit(1);
    }
    logger.warn(`${msg} — using insecure development fallback`);
  }

  if (isProd && (encMissing || encWeak)) {
    logger.error(
      'ENCRYPTION_KEY is required in production (≥32 chars, distinct from JWT_SECRET). Used for SSO tokens, SMTP password, and personal PM API tokens.'
    );
    process.exit(1);
  }

  if (!isProd && (encMissing || encWeak)) {
    logger.warn(
      'ENCRYPTION_KEY missing or weak — falling back to JWT_SECRET / dev key. Set a dedicated ENCRYPTION_KEY before production.'
    );
  }

  if (sameKey) {
    const msg =
      'ENCRYPTION_KEY must differ from JWT_SECRET so a single leak cannot forge sessions and decrypt stored secrets';
    if (isProd) {
      logger.error(msg);
      process.exit(1);
    }
    logger.warn(msg);
  }
}

export function jwtSecret(): string {
  return process.env.JWT_SECRET || 'dev-only-secret';
}

export function encryptionKeyMaterial(): string {
  return process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'dev-only-key';
}
