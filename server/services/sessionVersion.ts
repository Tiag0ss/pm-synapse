import { pool } from '../config/database';

/** Bump so existing JWTs for this user fail authenticateSession. */
export async function bumpSessionVersion(userId: number): Promise<void> {
  await pool.execute('UPDATE Users SET SessionVersion = SessionVersion + 1 WHERE Id = ?', [userId]);
}
