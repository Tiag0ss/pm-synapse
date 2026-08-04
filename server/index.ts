import express from 'express';
import next from 'next';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { testConnection } from './config/database';
import { ensureSchema } from './services/schema';
import { assertRuntimeSecrets } from './services/secrets';
import logger from './utils/logger';
import authRoutes from './routes/auth';
import vaultsRoutes from './routes/vaults';
import publicWikiRoutes from './routes/publicWiki';
import settingsRoutes from './routes/settings';
import usersRoutes from './routes/users';
import templatesRoutes from './routes/templates';
import exportTemplatesRoutes from './routes/exportTemplates';

dotenv.config();
assertRuntimeSecrets();

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT || 3010);
const app = next({ dev, dir: process.cwd() });
const handle = app.getRequestHandler();

function allowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin / non-browser
  const allowed = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '');
  if (allowed && origin === allowed) return true;
  if (dev) {
    try {
      const u = new URL(origin);
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  }
  return false;
}

async function main() {
  await app.prepare();

  const ok = await testConnection();
  if (!ok) {
    logger.error('Database connection failed — check DB_* in pm-synapse/.env');
    logger.error('Create database pm_synapse and copy values from .env.example');
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
    logger.warn('Continuing in development without DB — API routes that need MySQL will fail');
  } else {
    await ensureSchema();
  }

  const server = express();
  server.set('trust proxy', 1);
  server.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", 'data:', 'blob:'],
          "font-src": ["'self'", 'data:'],
          "connect-src": ["'self'"],
          "worker-src": ["'self'", 'blob:'],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
          "form-action": ["'self'"],
          "frame-ancestors": ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );
  server.use(
    cors({
      origin(origin, callback) {
        if (allowedCorsOrigin(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
    })
  );
  server.use(express.json({ limit: '30mb' }));
  server.use(cookieParser());

  server.get('/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'pm-synapse', timestamp: new Date().toISOString() });
  });

  server.use('/api/auth', authRoutes);
  server.use('/api/vaults', vaultsRoutes);
  server.use('/api/public', publicWikiRoutes);
  server.use('/api/settings', settingsRoutes);
  server.use('/api/users', usersRoutes);
  server.use('/api/templates', templatesRoutes);
  server.use('/api/export-templates', exportTemplatesRoutes);

  server.use((req, res) => handle(req, res));

  server.listen(port, () => {
    logger.info(`PM Synapse listening on http://localhost:${port}`);
  });
}

main().catch((error) => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error, Object.getOwnPropertyNames(error instanceof Object ? error : {}));
  logger.error('Failed to start PM Synapse', {
    message,
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
