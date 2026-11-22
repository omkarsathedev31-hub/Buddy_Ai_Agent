import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { PublicUser, UserRole, UserSettings } from '../shared/types.ts';
import { getDb } from './db.ts';
import { getAdminPasscode } from './env.ts';

export const SESSION_COOKIE_NAME = 'buddy_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthenticatedRequest extends Request {
  user?: PublicUser;
  sessionTokenHash?: string;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  if (!salt || !keyHex) return false;
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derived = crypto.scryptSync(password, salt, 64);
  if (keyBuf.length !== derived.length) return false;
  return crypto.timingSafeEqual(keyBuf, derived);
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(userId: string): { token: string; expiresAt: string } {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), userId, tokenHash, expiresAt, now.toISOString());
  return { token, expiresAt };
}

export function deleteSessionByHash(tokenHash: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
}

export function isHttpsRequest(req: Request): boolean {
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    if (forwardedProto.split(',')[0].trim() === 'https') return true;
  }
  if (req.secure) return true;
  if (typeof req.headers.origin === 'string' && req.headers.origin.startsWith('https://')) return true;
  if (typeof req.headers.referer === 'string' && req.headers.referer.startsWith('https://')) return true;
  const host = req.headers.host || '';
  if (
    !host.startsWith('127.0.0.1') &&
    !host.startsWith('localhost') &&
    (process.env.APP_URL?.startsWith('https://') || Boolean(process.env.VERCEL))
  ) {
    return true;
  }
  return false;
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const isHttps = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isHttps) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const isHttps = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
  ];
  if (isHttps) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

export function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] || null;
}

export function verifyCsrf(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }
  // Requests using explicit Authorization Bearer token are immune to cookie CSRF
  if (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')) {
    next();
    return;
  }
  const customHeader = req.headers['x-requested-with'];
  if (customHeader === 'BuddyElderAI') {
    next();
    return;
  }
  const origin = req.headers.origin;
  const host = (req.headers['x-forwarded-host'] as string | undefined) || req.headers.host;
  if (origin && host) {
    try {
      const parsed = new URL(origin);
      if (parsed.host === host) {
        next();
        return;
      }
    } catch {
      // fall through to 403
    }
  }
  res.status(403).json({ error: 'Invalid request origin or missing security header.' });
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required. Please sign in.' });
    return;
  }

  const tokenHash = hashToken(token);
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.phone, u.role, u.language, u.is_active, u.created_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash) as
    | (Omit<PublicUser, 'is_active'> & { is_active: number; expires_at: string })
    | undefined;

  if (!row) {
    res.status(401).json({ error: 'Session not found or expired. Please sign in again.' });
    return;
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    deleteSessionByHash(tokenHash);
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
    return;
  }

  if (!row.is_active) {
    res.status(403).json({ error: 'Account is deactivated. Please contact an administrator.' });
    return;
  }

  req.user = {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    role: row.role,
    language: row.language,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
  };
  req.sessionTokenHash = tokenHash;
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'You do not have permission to access this resource.' });
      return;
    }
    next();
  };
}

export function ensureDefaultSettings(userId: string): UserSettings {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM user_settings WHERE user_id = ?`).get(userId) as
    | (Omit<UserSettings, 'reduced_motion' | 'voice_enabled' | 'notifications_enabled' | 'onboarding_completed'> & {
        reduced_motion: number;
        voice_enabled: number;
        notifications_enabled: number;
        onboarding_completed: number;
      })
    | undefined;

  if (existing) {
    return {
      ...existing,
      reduced_motion: Boolean(existing.reduced_motion),
      voice_enabled: Boolean(existing.voice_enabled),
      notifications_enabled: Boolean(existing.notifications_enabled),
      onboarding_completed: Boolean(existing.onboarding_completed),
    };
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user_settings (
      user_id, text_size, contrast_mode, theme, reduced_motion,
      voice_enabled, voice_speed, voice_name, notifications_enabled,
      onboarding_completed, updated_at
    ) VALUES (?, 'normal', 'standard', 'light', 0, 1, 'normal', NULL, 1, 0, ?)`
  ).run(userId, now);

  return {
    user_id: userId,
    text_size: 'normal',
    contrast_mode: 'standard',
    theme: 'light',
    reduced_motion: false,
    voice_enabled: true,
    voice_speed: 'normal',
    voice_name: null,
    notifications_enabled: true,
    onboarding_completed: false,
    updated_at: now,
  };
}

export function hasAdminConfigured(): {
  hasEnvPasscode: boolean;
  hasClaimedPasscode: boolean;
  hasAdminUser: boolean;
} {
  const db = getDb();
  const hasEnvPasscode = Boolean(getAdminPasscode());
  const claimedRow = db.prepare(`SELECT value FROM system_config WHERE key = 'admin_passcode_hash'`).get() as
    | { value: string }
    | undefined;
  const adminUserRow = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get() as
    | { id: string }
    | undefined;
  return {
    hasEnvPasscode,
    hasClaimedPasscode: Boolean(claimedRow?.value),
    hasAdminUser: Boolean(adminUserRow?.id),
  };
}

export function verifyAdminPasscode(passcode: string): boolean {
  const envPass = getAdminPasscode();
  if (envPass) {
    const a = Buffer.from(passcode);
    const b = Buffer.from(envPass);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  const db = getDb();
  const claimedRow = db.prepare(`SELECT value FROM system_config WHERE key = 'admin_passcode_hash'`).get() as
    | { value: string }
    | undefined;
  if (!claimedRow?.value) return false;
  return verifyPassword(passcode, claimedRow.value);
}
