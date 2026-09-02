import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAgentByEmail, createAgent, setAgentRole } from './db/repo.js';

// Passwords are stored as salt:hash using scrypt, no external dependency.
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = (stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && timingSafeEqual(expected, hash);
}

// Creates the first agent login from env, once, if none exists yet.
export async function seedAdmin(pool, config, log) {
  if (!config.adminEmail || !config.adminPassword) return;
  const existing = await getAgentByEmail(pool, config.adminEmail);
  if (!existing) {
    await createAgent(pool, {
      email: config.adminEmail,
      name: 'Admin',
      passwordHash: hashPassword(config.adminPassword),
      role: 'admin',
    });
    log.info({ email: config.adminEmail }, 'seeded admin agent');
    return;
  }
  // The seed account is always an admin, in case someone downgraded it.
  if (existing.role !== 'admin') {
    await setAgentRole(pool, config.adminEmail, 'admin');
    log.info({ email: config.adminEmail }, 're-promoted seed account to admin');
  }
}
