// PostgreSQL's SCRAM-SHA-256 password verifier, computed on the client so that a role's plaintext
// password is never sent to the server. Shared by provision-cleanup-role.mjs and
// bootstrap-supabase.mjs. The result is still a credential: never print or log it.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/** PostgreSQL's SCRAM-SHA-256 verifier for an ASCII password (SASLprep is the identity). */
export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  const b64 = (b) => b.toString('base64');
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}
