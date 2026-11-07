import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCodes,
  hashedRecoveryCodeStorage,
  hashRecoveryCode,
  normaliseRecoveryCode,
  remainingRecoveryCodes,
} from './recovery-codes';

const SECRET = 'unit-test-secret-unit-test-secret-0001';

describe('recovery codes', () => {
  it('are 10 distinct codes of 12 unambiguous characters', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){2}$/);
  });

  it('normalise case, spaces and dashes', () => {
    expect(normaliseRecoveryCode(' AB2C-dEf3 GH45 ')).toBe('ab2cdef3gh45');
    expect(hashRecoveryCode('ab2c-def3-gh45', SECRET)).toBe(
      hashRecoveryCode('AB2CDEF3GH45', SECRET),
    );
  });

  it('hash with a key derived from the secret', () => {
    const h = hashRecoveryCode('ab2c-def3-gh45', SECRET);
    expect(h).toMatch(/^h1:[A-Za-z0-9_-]{43}$/);
    expect(hashRecoveryCode('ab2c-def3-gh45', `${SECRET}x`)).not.toBe(h);
    expect(hashRecoveryCode(h, SECRET)).not.toBe(h); // a stored hash is not a valid code
  });

  it('storage hashes new codes, keeps already-hashed ones, and never stores plain text', async () => {
    const store = hashedRecoveryCodeStorage(SECRET);
    const codes = generateRecoveryCodes(3);
    const stored = await store.encrypt(JSON.stringify(codes));
    for (const c of codes) expect(stored).not.toContain(normaliseRecoveryCode(c));
    expect(await store.encrypt(stored)).toBe(stored);
    expect(await store.decrypt(stored)).toBe(stored);
    expect(remainingRecoveryCodes(stored)).toBe(3);
    expect(remainingRecoveryCodes(JSON.stringify(codes))).toBeNull();
    expect(remainingRecoveryCodes('not json')).toBeNull();
  });
});
