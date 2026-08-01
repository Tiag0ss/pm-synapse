import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool, RowDataPacket } from '../config/database';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret';

export interface SynapseUser {
  userId: number;
  username: string;
  email: string;
  isAdmin: boolean;
}

export interface AuthRequest extends Request {
  user?: SynapseUser;
}

export function signSession(user: SynapseUser): string {
  return jwt.sign(
    {
      userId: user.userId,
      username: user.username,
      email: user.email,
      isAdmin: user.isAdmin,
    },
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

export async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT IsAdmin, IsActive FROM Users WHERE Id = ?',
      [req.user.userId]
    );
    if (!rows.length || Number(rows[0].IsActive) !== 1) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }
    if (Number(rows[0].IsAdmin) !== 1) {
      res.status(403).json({ success: false, message: 'Admin access required' });
      return;
    }
    req.user.isAdmin = true;
    next();
  } catch {
    res.status(500).json({ success: false, message: 'Authorization check failed' });
  }
}

function tryDecodeSession(req: AuthRequest): SynapseUser | null {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const cookieToken =
    (req as AuthRequest & { cookies?: Record<string, string> }).cookies?.synapse_session || '';
  const token = bearer || cookieToken;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId?: number;
      pmUserId?: number;
      username?: string;
      email?: string;
      isAdmin?: boolean;
    };
    // Back-compat: older cookies used pmUserId as the Synapse identity
    const userId = Number(decoded.userId ?? decoded.pmUserId);
    if (!Number.isFinite(userId) || userId <= 0) return null;
    return {
      userId,
      username: String(decoded.username || ''),
      email: String(decoded.email || ''),
      isAdmin: Boolean(decoded.isAdmin),
    };
  } catch {
    return null;
  }
}
