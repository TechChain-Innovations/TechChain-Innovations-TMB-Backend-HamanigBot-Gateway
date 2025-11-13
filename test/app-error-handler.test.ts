import { FastifyInstance } from 'fastify';

import './mocks/app-mocks';

import { gatewayApp } from '../src/app';

describe('Global error handler', () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    fastify = gatewayApp;

    fastify.route({
      method: 'GET',
      url: '/__test/error/no-status',
      handler: () => {
        const error = new Error('Insufficient allowance for USDC');
        (error as Error & { cause?: unknown }).cause = { code: 'ALLOWANCE_REQUIRED' };
        throw error;
      },
    });

    fastify.route({
      method: 'GET',
      url: '/__test/error/status',
      handler: () => {
        const error = new Error('Detailed fastify error') as Error & { statusCode?: number; name?: string };
        error.statusCode = 400;
        error.name = 'BadRequestError';
        throw error;
      },
    });

    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
  });

  it('returns the original message and details for unhandled errors', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/__test/error/no-status',
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.payload);
    expect(body.message).toBe('Insufficient allowance for USDC');
    expect(body.error).toBe('Error');
    expect(body.details).toEqual({ code: 'ALLOWANCE_REQUIRED' });
  });

  it('preserves Fastify HTTP error responses', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/__test/error/status',
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.message).toBe('Detailed fastify error');
    expect(body.error).toBe('BadRequestError');
    expect(body.details).toBeUndefined();
  });
});
