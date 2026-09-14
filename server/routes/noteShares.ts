import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  SHARE_COOKIE,
  findActiveShareByToken,
  deleteShareAskAnswerForToken,
  getShareContent,
  getShareMeta,
  readShareCookie,
  shareMediaAllowed,
  signShareCookie,
  submitShareAskAnswerForToken,
  updateShareAskAnswerForToken,
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

const askAnswerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many answers. Try again shortly.' },
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
        embeddedBoards: content.embeddedBoards,
        askAnswers: content.askAnswers,
        expiresAt: content.expiresAt,
      },
    });
  } catch (error) {
    logger.error('Share content failed', { error });
    return res.status(500).json({ success: false, message: 'Failed to load share' });
  }
});

router.post('/:token/asks/:askId/answers', askAnswerLimiter, async (req, res: Response) => {
  const token = String(req.params.token || '');
  const askId = String(req.params.askId || '').trim();
  if (!token || token.length > 128 || !askId || askId.length > 64) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }

  const parsed = z
    .object({
      body: z.string().min(1).max(8000),
      authorName: z.string().max(128).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Answer body required' });
  }

  try {
    const result = await submitShareAskAnswerForToken({
      rawToken: token,
      shareCookie: shareCookieFromReq(req),
      askMarkerId: askId,
      body: parsed.data.body,
      authorName: parsed.data.authorName,
    });
    if (!result.ok) {
      if (result.reason === 'locked') {
        return res.status(401).json({
          success: false,
          message: 'Password required',
          code: 'locked',
        });
      }
      if (result.reason === 'invalid_ask') {
        return res.status(400).json({ success: false, message: 'Unknown question' });
      }
      if (result.reason === 'empty_body') {
        return res.status(400).json({ success: false, message: 'Answer body required' });
      }
      if (result.reason === 'whiteboard') {
        return res.status(400).json({ success: false, message: 'Q&A is not available on whiteboards' });
      }
      const status = result.reason === 'not_found' ? 404 : 410;
      return res.status(status).json({
        success: false,
        message:
          result.reason === 'expired'
            ? 'This share link has expired'
            : result.reason === 'revoked'
              ? 'This share link was revoked'
              : 'Share not found',
        code: result.reason,
      });
    }
    res.status(201).json({
      success: true,
      data: {
        ...result.answer,
        guestEditToken: result.guestEditToken,
      },
    });
  } catch (error) {
    logger.error('Share ask answer failed', { error });
    return res.status(500).json({ success: false, message: 'Failed to submit answer' });
  }
});

function mapShareAskMutationError(
  res: Response,
  reason: string
): Response | null {
  if (reason === 'locked') {
    return res.status(401).json({
      success: false,
      message: 'Password required',
      code: 'locked',
    });
  }
  if (reason === 'forbidden') {
    return res.status(403).json({ success: false, message: 'Not allowed to change this answer' });
  }
  if (reason === 'not_pending') {
    return res.status(409).json({
      success: false,
      message: 'Only pending answers can be edited or deleted',
    });
  }
  if (reason === 'deleted' || reason === 'already_deleted') {
    return res.status(409).json({ success: false, message: 'Answer was deleted' });
  }
  if (reason === 'empty_body') {
    return res.status(400).json({ success: false, message: 'Answer body required' });
  }
  if (reason === 'unchanged') {
    return res.json({ success: true, data: null, message: 'No change' });
  }
  if (reason === 'whiteboard') {
    return res.status(400).json({ success: false, message: 'Q&A is not available on whiteboards' });
  }
  if (reason === 'not_found') {
    return res.status(404).json({ success: false, message: 'Answer not found' });
  }
  if (reason === 'expired' || reason === 'revoked') {
    return res.status(410).json({
      success: false,
      message:
        reason === 'expired' ? 'This share link has expired' : 'This share link was revoked',
      code: reason,
    });
  }
  return null;
}

router.patch(
  '/:token/asks/:askId/answers/:answerId',
  askAnswerLimiter,
  async (req, res: Response) => {
    const token = String(req.params.token || '');
    const askId = String(req.params.askId || '').trim();
    const answerId = Number(req.params.answerId);
    if (
      !token ||
      token.length > 128 ||
      !askId ||
      askId.length > 64 ||
      !Number.isFinite(answerId) ||
      answerId <= 0
    ) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    const parsed = z
      .object({
        body: z.string().min(1).max(8000),
        authorName: z.string().max(128).optional(),
        guestEditToken: z.string().min(8).max(200),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Invalid edit payload' });
    }

    try {
      const result = await updateShareAskAnswerForToken({
        rawToken: token,
        shareCookie: shareCookieFromReq(req),
        askMarkerId: askId,
        answerId,
        guestEditToken: parsed.data.guestEditToken,
        body: parsed.data.body,
        authorName: parsed.data.authorName,
      });
      if (!result.ok) {
        const mapped = mapShareAskMutationError(res, result.reason);
        if (mapped) return mapped;
        return res.status(400).json({ success: false, message: 'Failed to update answer' });
      }
      res.json({ success: true, data: result.answer });
    } catch (error) {
      logger.error('Share ask answer edit failed', { error });
      return res.status(500).json({ success: false, message: 'Failed to update answer' });
    }
  }
);

router.delete(
  '/:token/asks/:askId/answers/:answerId',
  askAnswerLimiter,
  async (req, res: Response) => {
    const token = String(req.params.token || '');
    const askId = String(req.params.askId || '').trim();
    const answerId = Number(req.params.answerId);
    if (
      !token ||
      token.length > 128 ||
      !askId ||
      askId.length > 64 ||
      !Number.isFinite(answerId) ||
      answerId <= 0
    ) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    const parsed = z
      .object({
        guestEditToken: z.string().min(8).max(200),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Edit token required' });
    }

    try {
      const result = await deleteShareAskAnswerForToken({
        rawToken: token,
        shareCookie: shareCookieFromReq(req),
        askMarkerId: askId,
        answerId,
        guestEditToken: parsed.data.guestEditToken,
      });
      if (!result.ok) {
        const mapped = mapShareAskMutationError(res, result.reason);
        if (mapped) return mapped;
        return res.status(400).json({ success: false, message: 'Failed to delete answer' });
      }
      res.json({ success: true, data: result.answer });
    } catch (error) {
      logger.error('Share ask answer delete failed', { error });
      return res.status(500).json({ success: false, message: 'Failed to delete answer' });
    }
  }
);

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
