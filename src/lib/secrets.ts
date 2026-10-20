import { createHash, randomBytes } from 'node:crypto';

const API_KEY_PREFIX = 'bk_';

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 6), hash: hashApiKey(key) };
}

/**
 * API keys are long random strings, so a fast hash is enough (unlike passwords).
 * It lets us look a key up by its hash without ever storing the key.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
