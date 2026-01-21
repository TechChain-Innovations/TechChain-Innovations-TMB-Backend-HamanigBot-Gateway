import { FastifyPluginAsync } from 'fastify';

import { logger } from '../../../services/logger';
import { Ethereum } from '../ethereum';
import {
  acquireNonceWithLock,
  releaseNonceByLockId,
  invalidateNonce,
  getExternalLocksStatus,
  startExternalLockCleanup,
} from '../nonce-manager';
import {
  NonceAcquireRequestSchema,
  NonceAcquireResponseSchema,
  NonceAcquireRequestType,
  NonceAcquireResponseType,
  NonceReleaseRequestSchema,
  NonceReleaseResponseSchema,
  NonceReleaseRequestType,
  NonceReleaseResponseType,
  NonceInvalidateRequestSchema,
  NonceInvalidateResponseSchema,
  NonceInvalidateRequestType,
  NonceInvalidateResponseType,
  NonceStatusResponseSchema,
  NonceStatusResponseType,
} from '../schemas';

// Start the cleanup interval when this module is loaded
startExternalLockCleanup();

/**
 * Nonce management routes for external services (wallet-service).
 *
 * These endpoints allow wallet-service to coordinate nonce usage with
 * hummingbot-gateway, preventing nonce collisions when both services
 * execute transactions from the same wallet.
 *
 * Flow:
 * 1. wallet-service calls POST /nonce/acquire before sending a transaction
 * 2. Gateway returns a lockId, nonce, and expiresAt
 * 3. wallet-service uses the nonce to send the transaction
 * 4. wallet-service calls POST /nonce/release with transactionSent=true/false
 *
 * If wallet-service crashes, the lock expires after TTL and is automatically cleaned up.
 */
export const nonceRoute: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /nonce/acquire
   *
   * Acquires a nonce lock for a wallet address. The lock blocks other
   * nonce acquisitions until released or expired.
   */
  fastify.post<{
    Body: NonceAcquireRequestType;
    Reply: NonceAcquireResponseType;
  }>(
    '/nonce/acquire',
    {
      schema: {
        description:
          'Acquire a nonce lock for transaction execution. Returns a lockId that must be released after the transaction.',
        tags: ['/chain/ethereum'],
        body: NonceAcquireRequestSchema,
        response: {
          200: NonceAcquireResponseSchema,
        },
      },
    },
    async (request) => {
      const { network, walletAddress, ttlMs } = request.body;

      logger.info(
        `[nonce-api] Acquire request: network=${network}, wallet=${walletAddress}, ttl=${ttlMs ?? 'default'}`,
      );

      try {
        // Get the Ethereum instance for this network
        const ethereum = await Ethereum.getInstance(network);
        await ethereum.init();

        // Acquire the nonce with lock
        const result = await acquireNonceWithLock(ethereum.provider, walletAddress, network, ttlMs);

        return result;
      } catch (error) {
        logger.error(`[nonce-api] Acquire failed: ${error.message}`);
        throw fastify.httpErrors.internalServerError(`Failed to acquire nonce: ${error.message}`);
      }
    },
  );

  /**
   * POST /nonce/release
   *
   * Releases a previously acquired nonce lock. If transactionSent is false,
   * the nonce is rolled back so it can be reused.
   */
  fastify.post<{
    Body: NonceReleaseRequestType;
    Reply: NonceReleaseResponseType;
  }>(
    '/nonce/release',
    {
      schema: {
        description: 'Release a previously acquired nonce lock. Set transactionSent=false to rollback the nonce.',
        tags: ['/chain/ethereum'],
        body: NonceReleaseRequestSchema,
        response: {
          200: NonceReleaseResponseSchema,
        },
      },
    },
    async (request) => {
      const { lockId, transactionSent, walletAddress, network } = request.body;

      logger.info(
        `[nonce-api] Release request: lockId=${lockId}, wallet=${walletAddress}, ` +
          `network=${network}, transactionSent=${transactionSent}`,
      );

      const success = releaseNonceByLockId(lockId, transactionSent);

      if (!success) {
        // Lock not found - might have expired
        return {
          success: false,
          message: 'Lock not found (may have expired)',
        };
      }

      return {
        success: true,
        message: transactionSent ? 'Lock released, nonce committed' : 'Lock released, nonce rolled back',
      };
    },
  );

  /**
   * POST /nonce/invalidate
   *
   * Invalidates the nonce cache for a wallet address. Use this after
   * detecting a nonce error or when nonce state needs to be reset.
   */
  fastify.post<{
    Body: NonceInvalidateRequestType;
    Reply: NonceInvalidateResponseType;
  }>(
    '/nonce/invalidate',
    {
      schema: {
        description: 'Invalidate the nonce cache for a wallet address. Forces next nonce fetch from blockchain.',
        tags: ['/chain/ethereum'],
        body: NonceInvalidateRequestSchema,
        response: {
          200: NonceInvalidateResponseSchema,
        },
      },
    },
    async (request) => {
      const { network, walletAddress } = request.body;

      logger.info(`[nonce-api] Invalidate request: network=${network}, wallet=${walletAddress}`);

      invalidateNonce(walletAddress, network);

      return { success: true };
    },
  );

  /**
   * GET /nonce/status
   *
   * Returns the current status of all external nonce locks.
   * Useful for monitoring and debugging.
   */
  fastify.get<{
    Reply: NonceStatusResponseType;
  }>(
    '/nonce/status',
    {
      schema: {
        description: 'Get status of all active nonce locks (for monitoring/debugging)',
        tags: ['/chain/ethereum'],
        response: {
          200: NonceStatusResponseSchema,
        },
      },
    },
    async () => {
      return getExternalLocksStatus();
    },
  );
};

export default nonceRoute;
