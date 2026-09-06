import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  SHARE_COOKIE,
  findActiveShareByToken,
  getShareContent,
  getShareMeta,
  readShareCookie,
  shareMediaAllowed,
  signShareCookie,
  verifySharePassword,
} from '../services/noteShares';
import { applySafeMediaHeaders, readVaultMedia } from '../services/vaultMedia';
import logger from '../utils/logger';

const router = Router();

function cookieSecure(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === '1';
}

function shareCookieFromReq(req: { cookies?: Record<string, string> }): string | undefined {
  return req.cookies?.[SHARE_COOKIE];
}

const unlockLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many unlock attempts. Try again shortly.' },
});

router.get('/:token', async (req, res: Response) => {
  const token = String(req.params.token || '');
  if (!token || token.length > 128) {
    return res.status(404).json({ success: false, message: 'Share not found' });
  }

  const meta = await getShareMeta(token);
  if (!meta.ok) {
    const message =
      meta.state === 'expired'
        ? 'This share link has expired'
        : meta.state === 'revoked'
          ? 'This share link was revoked'
          : 'Share not found';
    const status = meta.state === 'not_found' ? 404 : 410;
    return res.status(status).json({ success: false, message, code: meta.state });
  }

  const found = await findActiveShareByToken(token);
  const unlocked = Boolean(
    found.share && readShareCookie(shareCookieFromReq(req), found.share)
  );

  res.json({
    success: true,
    data: {
      title: meta.title,
      kind: meta.kind,
      expiresAt: meta.expiresAt,
      unlocked,
    },
  });
});

router.post('/:token/unlock', unlockLimiter, async (req, res: Response) => {
  const token = String(req.params.token || '');
  if (!token || token.length > 128) {
    return res.status(404).json({ success: false, message: 'Share not found' });
  }

  const parsed = z
    .object({ password: z.string().min(1).max(200) })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Password required' });
  }

  const found = await findActiveShareByToken(token);
  if (found.state === 'not_found' || !found.share) {
    return res.status(404).json({ success: false, message: 'Share not found' });
  }
  if (found.state === 'expired') {
    return res.status(410).json({ success: false, message: 'This share link has expired', code: 'expired' });
  }
  if (found.state === 'revoked') {
    return res
      .status(410)
      .json({ success: false, message: 'This share link was revoked', code: 'revoked' });
  }

  const ok = await verifySharePassword(found.share, parsed.data.password);
  if (!ok) {
    return res.status(401).json({ success: false, message: 'Incorrect password' });
  }

  const { token: cookieToken, maxAgeMs } = signShareCookie(found.share);
  res.cookie(SHARE_COOKIE, cookieToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(),
    maxAge: maxAgeMs,
    path: '/',
  });

  res.json({ success: true, message: 'Unlocked' });
});

router.get('/:token/content', async (req, res: Response) => {
  const token = String(req.params.token || '');
  if (!token || token.length > 128) {
    return res.status(404).json({ success: false, message: 'Share not found' });
  }

  try {
    const content = await getShareContent({
      rawToken: token,
      shareCookie: shareCookieFromReq(req),
    });
    if (!content.ok) {
      if (content.reason === 'locked') {
        return res.status(401).json({
          success: false,
          message: 'Password required',
          code: 'locked',
        });
      }
      const status = content.reason === 'not_found' ? 404 : 410;
      return res.status(status).json({
        success: false,
        message:
          content.reason === 'expired'
            ? 'This share link has expired'
            : content.reason === 'revoked'
              ? 'This share link was revoked'
              : 'Share not found',
        code: content.reason,
      });
    }

    res.json({
      success: true,
      data: {
        title: content.title,
        kind: content.kind,
        noteId: content.noteId,
        html: content.html,
        boardJson: content.boardJson,
        expiresAt: content.expiresAt,
      },
    });
  } catch (error) {
    logger.error('Share content failed', { error });
    return res.status(500).json({ success: false, message: 'Failed to load share' });
  }
});

router.get('/:token/media/:mediaId', async (req, res: Response) => {
  const token = String(req.params.token || '');
  const mediaId = Number(req.params.mediaId);
  if (!token || token.length > 128 || !Number.isFinite(mediaId) || mediaId <= 0) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }

  const allowed = await shareMediaAllowed({
    rawToken: token,
    shareCookie: shareCookieFromReq(req),
    mediaId,
  });
  if (!allowed.ok) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }

  const media = await readVaultMedia(allowed.vaultId, mediaId);
  if (!media) return res.status(404).json({ success: false, message: 'Not found' });
  if (
    !applySafeMediaHeaders(res, {
      mimeType: media.mimeType,
      originalName: media.originalName,
      cacheControl: 'private, max-age=3600',
    })
  ) {
    return res.status(415).json({ success: false, message: 'Unsupported media type' });
  }
  res.send(media.buffer);
});

export default router;
