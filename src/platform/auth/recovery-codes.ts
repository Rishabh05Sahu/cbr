// One-time 2FA recovery codes (owner decision 2026-10-20, item D).
//
// The auth library stores backup codes reversibly encrypted by default. We store only keyed
// hashes instead: HMAC-SHA-256 under a key derived from BETTER_AUTH_SECRET (HKDF, own info
// label), so a database dump alone neither reveals nor lets anyone test codes offline.
// Codes carry ~59 bits of entropy, so a fast keyed hash is appropriate (no password stretching
// needed); they are single-use and verification is rate-limited and account-locked.
//
// The library compares the submitted code with the stored list by equality, so the auth
// before-hook replaces the submitted code with its hash (hashRecoveryCode) before verification.
import { createHmac, hkdfSync, randomInt } from 'node:crypto';

export const RECOVERY_CODE_COUNT = 10;
const GROUPS = 3;
const GROUP_LENGTH = 4;
/** 31 symbols without look-alikes (0/o, 1/l/i); 12 symbols ≈ 59 bits. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const HASH_PREFIX = 'h1:';

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () =>
    Array.from({ length: GROUPS }, () =>
      Array.from({ length: GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
    ).join('-'),
  );
}

/** Case, spaces and dashes do not matter when a person types a code. */
export function normaliseRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}

const keys = new Map<string, Buffer>();

function keyFor(secret: string): Buffer {
  let k = keys.get(secret);
  if (!k) {
    k = Buffer.from(hkdfSync('sha256', secret, 'cbr-crm', 'recovery-code-hmac-v1', 32));
    keys.set(secret, k);
  }
  return k;
}

export function isHashedRecoveryCode(value: string): boolean {
  return value.startsWith(HASH_PREFIX);
}

/** Stored representation of a code. Anything submitted is hashed, including hash-like input. */
export function hashRecoveryCode(code: string, secret: string): string {
  const mac = createHmac('sha256', keyFor(secret)).update(normaliseRecoveryCode(code));
  return `${HASH_PREFIX}${mac.digest('base64url')}`;
}

/**
 * `storeBackupCodes` adapter for the two-factor plugin. `encrypt` receives the JSON list of
 * freshly generated plain codes (hash them) or the remaining list after a code was consumed
 * (already hashed; keep). `decrypt` returns the stored hashes unchanged.
 */
export function hashedRecoveryCodeStorage(secret: string) {
  return {
    encrypt: async (json: string): Promise<string> => {
      const codes = JSON.parse(json) as string[];
      return JSON.stringify(
        codes.map((c) => (isHashedRecoveryCode(c) ? c : hashRecoveryCode(c, secret))),
      );
    },
    decrypt: async (stored: string): Promise<string> => stored,
  };
}

/** Number of unused codes in a stored value (null when unreadable). */
export function remainingRecoveryCodes(stored: string | null | undefined): number | null {
  if (!stored) return null;
  try {
    const codes = JSON.parse(stored) as unknown;
    return Array.isArray(codes) &&
      codes.every((c) => typeof c === 'string' && isHashedRecoveryCode(c))
      ? codes.length
      : null;
  } catch {
    return null;
  }
}
