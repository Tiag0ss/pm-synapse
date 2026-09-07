import express from 'express';
import request from 'supertest';
import { buildHealthPayload, registerHealthRoute } from '../../server/health';

describe('smoke: health', () => {
  it('buildHealthPayload returns expected shape', () => {
    const body = buildHealthPayload(new Date('2026-01-01T00:00:00.000Z'));
    expect(body).toEqual({
      status: 'healthy',
      service: 'pm-synapse',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  it('GET /health returns 200 JSON', async () => {
    const app = express();
    registerHealthRoute(app);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.service).toBe('pm-synapse');
    expect(typeof res.body.timestamp).toBe('string');
  });
});
