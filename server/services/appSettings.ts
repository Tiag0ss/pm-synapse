import { pool, RowDataPacket } from '../config/database';
import { decryptSecret, encryptSecret } from './crypto';
import logger from '../utils/logger';

export const SETTING_KEYS = {
  siteName: 'siteName',
  allowPublicWikiDirectory: 'allowPublicWikiDirectory',
  allowPublicRegistration: 'allowPublicRegistration',
  allowSsoLogin: 'allowSsoLogin',
  minPasswordLength: 'minPasswordLength',
  pmIntegrationEnabled: 'pmIntegrationEnabled',
  pmApiKey: 'pmApiKey',
  smtpHost: 'smtpHost',
  smtpPort: 'smtpPort',
  smtpSecure: 'smtpSecure',
  smtpUser: 'smtpUser',
  smtpPassword: 'smtpPassword',
  smtpFrom: 'smtpFrom',
  smtpFromName: 'smtpFromName',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

const ENCRYPTED_KEYS = new Set<string>([SETTING_KEYS.smtpPassword]);

const settingsCache = new Map<string, string | null>();
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000;

export function invalidateSettingsCache(): void {
  settingsCache.clear();
  cacheLoadedAt = 0;
}

async function loadAll(): Promise<void> {
  if (settingsCache.size && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return;
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT SettingKey, SettingValue FROM AppSettings'
  );
  settingsCache.clear();
  for (const row of rows) {
    settingsCache.set(String(row.SettingKey), row.SettingValue == null ? null : String(row.SettingValue));
  }
  cacheLoadedAt = Date.now();
}

export async function getSetting(key: string): Promise<string | null> {
  await loadAll();
  if (settingsCache.has(key)) return settingsCache.get(key) ?? null;
  return null;
}

export async function getSettingBool(key: string, defaultValue = false): Promise<boolean> {
  const v = await getSetting(key);
  if (v == null || v === '') return defaultValue;
  return v === 'true' || v === '1';
}

export async function getSettingInt(key: string, defaultValue: number): Promise<number> {
  const v = await getSetting(key);
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultValue;
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  const stored =
    value != null && ENCRYPTED_KEYS.has(key) && value !== '' ? encryptSecret(value) : value;
  await pool.execute(
    `INSERT INTO AppSettings (SettingKey, SettingValue) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE SettingValue = VALUES(SettingValue)`,
    [key, stored]
  );
  invalidateSettingsCache();
}

export async function getDecryptedSetting(key: string): Promise<string | null> {
  const raw = await getSetting(key);
  if (raw == null || raw === '') return null;
  if (!ENCRYPTED_KEYS.has(key)) return raw;
  try {
    return decryptSecret(raw);
  } catch (error) {
    logger.error('Failed to decrypt setting', { key, error });
    return null;
  }
}

export function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export async function countUsers(): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS c FROM Users');
  return Number(rows[0]?.c || 0);
}

export function isSsoEnvConfigured(): boolean {
  const base = (process.env.PM_BASE_URL || '').trim();
  const secret = (process.env.SSO_CLIENT_SECRET || '').trim();
  return Boolean(base) && Boolean(secret);
}

export async function getPublicAuthProviders(): Promise<{
  siteName: string;
  allowPublicRegistration: boolean;
  allowSsoLogin: boolean;
  ssoConfigured: boolean;
  passwordResetAvailable: boolean;
  hasUsers: boolean;
}> {
  const [siteName, allowReg, allowSso, smtpReady, userCount] = await Promise.all([
    getSetting(SETTING_KEYS.siteName),
    getSettingBool(SETTING_KEYS.allowPublicRegistration, true),
    getSettingBool(SETTING_KEYS.allowSsoLogin, true),
    isSmtpConfigured(),
    countUsers(),
  ]);
  const bootstrap = userCount === 0;
  return {
    siteName: siteName || 'PM Synapse',
    allowPublicRegistration: bootstrap || allowReg,
    allowSsoLogin: allowSso && isSsoEnvConfigured(),
    ssoConfigured: isSsoEnvConfigured(),
    passwordResetAvailable: smtpReady,
    hasUsers: userCount > 0,
  };
}

export async function isSmtpConfigured(): Promise<boolean> {
  const [host, port, user, pass, from] = await Promise.all([
    getSetting(SETTING_KEYS.smtpHost),
    getSetting(SETTING_KEYS.smtpPort),
    getSetting(SETTING_KEYS.smtpUser),
    getDecryptedSetting(SETTING_KEYS.smtpPassword),
    getSetting(SETTING_KEYS.smtpFrom),
  ]);
  return Boolean(host && port && user && pass && from);
}
