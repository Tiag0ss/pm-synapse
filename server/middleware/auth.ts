import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool, RowDataPacket } from '../config/database';
import { jwtSecret } from '../services/secrets';

export interface SynapseUser {
  userId: number;
  username: string;
  email: string;
  isAdmin: boolean;
  sessionVersion: number;
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
      sv: user.sessionVersion ?? 0,
    },
    jwtSecret(),
    { expiresIn: '7d' }
  );
}

type DecodedSession = {
  userId?: number;
  pmUserId?: number;
  username?: string;
  email?: string;
  isAdmin?: boolean;
  sv?: number;
};

function tryDecodeToken(req: AuthRequest): DecodedSession | null {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const cookieToken =
    (req as AuthRequest & { cookies?: Record<string, string> }).cookies?.synapse_session || '';
  const token = bearer || cookieToken;
  if (!token) return null;
  try {
    return jwt.verify(token, jwtSecret()) as DecodedSession;
  } catch {
    return null;
  }
}

async function loadActiveSessionUser(decoded: DecodedSession): Promise<SynapseUser | null> {
  const userId = Number(decoded.userId ?? decoded.pmUserId);
  if (!Number.isFinite(userId) || userId <= 0) return null;

  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT Username, Email, IsAdmin, IsActive, SessionVersion FROM Users WHERE Id = ?`,
    [userId]
  );
  if (!rows.length || Number(rows[0].IsActive) !== 1) return null;

  const sessionVersion = Number(rows[0].SessionVersion ?? 0);
  const tokenSv = Number(decoded.sv ?? 0);
  if (tokenSv !== sessionVersion) return null;

  return {
    userId,
    username: String(rows[0].Username || decoded.username || ''),
    email: String(rows[0].Email || decoded.email || ''),
    isAdmin: Number(rows[0].IsAdmin) === 1,
    sessionVersion,
  };
}

export async function authenticateSession(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const decoded = tryDecodeToken(req);
    if (!decoded) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }
    const user = await loadActiveSessionUser(decoded);
    if (!user) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }
    req.user = user;
    next();
  } catch {
    res.status(500).json({ success: false, message: 'Authentication check failed' });
  }
}

/** Attach session user when present; continue without error if missing/invalid. */
export async function optionalAuthenticateSession(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const decoded = tryDecodeToken(req);
    if (decoded) {
      req.user = (await loadActiveSessionUser(decoded)) || undefined;
    }
    next();
  } catch {
    next();
  }
}

export async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      'SELECT IsAdmin, IsActive, SessionVersion FROM Users WHERE Id = ?',
      [req.user.userId]
    );
    if (!rows.length || Number(rows[0].IsActive) !== 1) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }
    if (Number(rows[0].SessionVersion ?? 0) !== Number(req.user.sessionVersion ?? 0)) {
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
