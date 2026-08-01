import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret';

export interface SynapseUser {
  pmUserId: number;
  username: string;
  email: string;
}

export interface AuthRequest extends Request {
  user?: SynapseUser;
}

export function signSession(user: SynapseUser): string {
  return jwt.sign(
    { pmUserId: user.pmUserId, username: user.username, email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function authenticateSession(req: AuthRequest, res: Response, next: NextFunction): void {
  const user = tryDecodeSession(req);
  if (!user) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }
  req.user = user;
  next();
}

/** Attach session user when present; continue without error if missing/invalid. */
export function optionalAuthenticateSession(req: AuthRequest, _res: Response, next: NextFunction): void {
  req.user = tryDecodeSession(req) || undefined;
  next();
}

function tryDecodeSession(req: AuthRequest): SynapseUser | null {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const cookieToken =
    (req as AuthRequest & { cookies?: Record<string, string> }).cookies?.synapse_session || '';
  const token = bearer || cookieToken;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as SynapseUser & { pmUserId: number };
    return {
      pmUserId: Number(decoded.pmUserId),
      username: String(decoded.username || ''),
      email: String(decoded.email || ''),
    };
  } catch {
    return null;
  }
}
