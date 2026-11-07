// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for tests: what an authenticator app computes.
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secretBase32: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const o = mac[mac.length - 1]! & 0x0f;
  const n = (mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

export const secretFromUri = (uri: string) => new URL(uri).searchParams.get('secret') ?? '';

/** Authenticator secrets of seeded users, by lower-case email (test process only). */
export const authenticators = new Map<string, string>();
