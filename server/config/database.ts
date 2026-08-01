import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

export type RowDataPacket = mysql.RowDataPacket;
export type ResultSetHeader = mysql.ResultSetHeader;

const pool = mysql.createPool({
  host: String(process.env.DB_HOST || 'localhost').trim(),
  port: Number(String(process.env.DB_PORT || 3306).trim()),
  user: String(process.env.DB_USER || 'root').trim(),
  password: String(process.env.DB_PASSWORD || '').trim(),
  database: String(process.env.DB_NAME || 'pm_synapse').trim(),
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  namedPlaceholders: false,
});

export { pool };

export async function testConnection(): Promise<boolean> {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    return true;
  } catch {
    return false;
  }
}
