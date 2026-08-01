import nodemailer from 'nodemailer';
import {
  getDecryptedSetting,
  getSetting,
  isSmtpConfigured,
  SETTING_KEYS,
} from './appSettings';
import logger from '../utils/logger';

export type SendMailResult = { ok: true } | { ok: false; message: string };

async function buildTransport() {
  const host = (await getSetting(SETTING_KEYS.smtpHost)) || '';
  const port = Number((await getSetting(SETTING_KEYS.smtpPort)) || 587);
  const user = (await getSetting(SETTING_KEYS.smtpUser)) || '';
  const pass = (await getDecryptedSetting(SETTING_KEYS.smtpPassword)) || '';
  const secureSetting = await getSetting(SETTING_KEYS.smtpSecure);
  const secureFlag = secureSetting === 'true' || secureSetting === '1';
  const useSecure = port === 465 ? true : port === 587 ? false : secureFlag;

  return nodemailer.createTransport({
    host,
    port,
    secure: useSecure,
    auth: { user, pass },
    ...(port === 587 ? { requireTLS: true } : {}),
  });
}

export async function sendMail(options: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<SendMailResult> {
  if (!(await isSmtpConfigured())) {
    return { ok: false, message: 'SMTP is not configured' };
  }
  const fromEmail = (await getSetting(SETTING_KEYS.smtpFrom)) || '';
  const fromName = (await getSetting(SETTING_KEYS.smtpFromName)) || 'PM Synapse';
  try {
    const transport = await buildTransport();
    await transport.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
    return { ok: true };
  } catch (error) {
    logger.error('Failed to send email', { error, to: options.to });
    return { ok: false, message: 'Failed to send email. Check SMTP configuration.' };
  }
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<SendMailResult> {
  const siteName = (await getSetting(SETTING_KEYS.siteName)) || 'PM Synapse';
  return sendMail({
    to,
    subject: `${siteName} — password reset`,
    text: `Reset your password using this link (valid for 1 hour):\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
    html: `<p>Reset your password using this link (valid for 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you did not request this, ignore this email.</p>`,
  });
}
