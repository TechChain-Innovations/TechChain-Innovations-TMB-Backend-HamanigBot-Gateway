import sensible from '@fastify/sensible';
import { FastifyPluginAsync } from 'fastify';

import { logger } from '../../services/logger';
import {
  RemoveAllWalletsRequest,
  RemoveAllWalletsResponse,
  RemoveAllWalletsRequestSchema,
  RemoveAllWalletsResponseSchema,
} from '../schemas';
import { removeAllWalletsForChain } from '../utils';

const isDevEnvironment = (): boolean => {
  return process.argv.includes('--dev') || process.env.GATEWAY_TEST_MODE === 'dev';
};

export const removeAllWalletsDevRoute: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);

  fastify.delete<{ Body: RemoveAllWalletsRequest; Reply: RemoveAllWalletsResponse }>(
    '/dev/removeAll',
    {
      schema: {
        summary: 'Dev: purge all wallets for a chain',
        description: 'Development only: remove all wallets (software and hardware) for a chain',
        tags: ['/wallet'],
        body: RemoveAllWalletsRequestSchema,
        response: {
          200: RemoveAllWalletsResponseSchema,
        },
      },
    },
    async (request) => {
      if (!isDevEnvironment()) {
        throw fastify.httpErrors.forbidden(
          'Development endpoint disabled. Start Gateway with --dev or set GATEWAY_TEST_MODE=dev to enable it.'
        );
      }

      const { chain } = request.body;
      logger.info(`Removing all wallets for chain: ${chain} via dev endpoint`);

      const result = await removeAllWalletsForChain(fastify, chain);
      const hardwareSentence = result.hardwareCleared ? 'hardware wallets cleared' : 'no hardware wallets found';

      return {
        message: `Removed ${result.removedWallets} wallet(s) for ${chain}, ${hardwareSentence}, default wallet reset`,
        chain,
        removedWallets: result.removedWallets,
        hardwareCleared: result.hardwareCleared,
      };
    }
  );
};

export default removeAllWalletsDevRoute;
