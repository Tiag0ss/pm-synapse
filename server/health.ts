import type { Express, Request, Response } from 'express';

export type HealthPayload = {
  status: 'healthy';
  service: 'pm-synapse';
  timestamp: string;
};

export function buildHealthPayload(now: Date = new Date()): HealthPayload {
  return {
    status: 'healthy',
    service: 'pm-synapse',
    timestamp: now.toISOString(),
  };
}

export function registerHealthRoute(app: Express): void {
  app.get('/health', (_req: Request, res: Response) => {
    res.json(buildHealthPayload());
  });
}
