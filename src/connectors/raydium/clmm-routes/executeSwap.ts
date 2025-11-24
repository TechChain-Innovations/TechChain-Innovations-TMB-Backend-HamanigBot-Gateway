import { ReturnTypeComputeAmountOutFormat, ReturnTypeComputeAmountOutBaseOut } from '@raydium-io/raydium-sdk-v2';
import { VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';

import { Solana } from '../../../chains/solana/solana';
import { ExecuteSwapResponse, ExecuteSwapResponseType } from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { Raydium } from '../raydium';
import { RaydiumConfig } from '../raydium.config';
import { RaydiumClmmExecuteSwapRequest, RaydiumClmmExecuteSwapRequestType } from '../schemas';

import { getSwapQuote, resolveClmmContext } from './quoteSwap';

type ErrorContext = {
  walletAddress?: string;
  tokenIn?: string;
  tokenOut?: string;
  amount?: number;
  side?: string;
  poolAddress?: string;
};

const buildDetails = (error: any, context?: ErrorContext) => {
  const details: Record<string, any> = {
    ...(context || {}),
    raw: error?.details || error?.cause || error?.message || error,
  };
  if (error?.stack) {
    details.stack = error.stack;
  }
  return details;
};

export const mapSwapError = (fastify: FastifyInstance, error: any, context?: ErrorContext): any => {
  const msg = (error?.message || '').toLowerCase();
  const details = buildDetails(error, context);

  // Common Solana / Raydium failure patterns
  if (msg.includes('insufficient funds') || msg.includes('custom program error: 0x1')) {
    const err = fastify.httpErrors.badRequest('Swap failed: insufficient funds');
    (err as any).details = details;
    return err;
  }

  if (msg.includes('slippage') || msg.includes('price limit') || msg.includes('liquidity')) {
    const err = fastify.httpErrors.badRequest('Swap failed: slippage or liquidity too low');
    (err as any).details = details;
    return err;
  }

  if (msg.includes('blockhash') || msg.includes('expired')) {
    const err = fastify.httpErrors.serviceUnavailable('Swap failed: transaction expired, try again');
    (err as any).details = details;
    return err;
  }

  if (msg.includes('pool not found')) {
    const err = fastify.httpErrors.notFound('Swap failed: pool not found');
    (err as any).details = details;
    return err;
  }

  // default
  const err = fastify.httpErrors.internalServerError('Swap execution failed');
  (err as any).details = details;
  return err;
};

export async function executeSwap(
  fastify: FastifyInstance,
  network: string,
  walletAddress: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  poolAddress: string,
  slippagePct?: number,
  useNativeSolBalance: boolean = false
): Promise<ExecuteSwapResponseType> {
  const ctx = await resolveClmmContext(fastify, network, poolAddress);
  const { solana, raydium, poolInfo: resolvedPoolInfo, poolKeys, network: networkToUse } = ctx;

  // Prepare wallet and check if it's hardware
  const { wallet, isHardwareWallet } = await raydium.prepareWallet(walletAddress);

  // Get pool info from address
  const poolInfo = resolvedPoolInfo ?? (await raydium.getClmmPoolfromAPI(poolAddress))?.[0];
  let poolKeysToUse = poolKeys;

  // For mainnet API calls poolKeys can be undefined; fetch from RPC as a fallback
  if (!poolKeysToUse) {
    try {
      const rpcData = await raydium.raydiumSDK.clmm.getPoolInfoFromRpc(poolAddress);
      poolKeysToUse = rpcData?.poolKeys;
    } catch (e) {
      logger.warn(`Failed to fetch CLMM pool keys from RPC for ${poolAddress}: ${e.message}`);
    }
  }

  if (!poolInfo || !poolKeysToUse) {
    throw fastify.httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
  }

  // Use configured slippage if not provided; keep explicit zero safe
  const effectiveSlippage =
    slippagePct === undefined || slippagePct === null ? RaydiumConfig.config.slippagePct : Number(slippagePct);

  const { inputToken, outputToken, response, clmmPoolInfo } = await getSwapQuote(
    fastify,
    networkToUse,
    baseToken,
    quoteToken,
    amount,
    side,
    poolAddress,
    effectiveSlippage,
    ctx
  );

  logger.info(`Raydium CLMM getSwapQuote:`, {
    response:
      side === 'BUY'
        ? {
            amountIn: {
              amount: (response as ReturnTypeComputeAmountOutBaseOut).amountIn.amount.toNumber(),
            },
            maxAmountIn: {
              amount: (response as ReturnTypeComputeAmountOutBaseOut).maxAmountIn.amount.toNumber(),
            },
            realAmountOut: {
              amount: (response as ReturnTypeComputeAmountOutBaseOut).realAmountOut.amount.toNumber(),
            },
          }
        : {
            realAmountIn: {
              amount: {
                raw: (response as ReturnTypeComputeAmountOutFormat).realAmountIn.amount.raw.toNumber(),
                token: {
                  symbol: (response as ReturnTypeComputeAmountOutFormat).realAmountIn.amount.token.symbol,
                  mint: (response as ReturnTypeComputeAmountOutFormat).realAmountIn.amount.token.mint,
                  decimals: (response as ReturnTypeComputeAmountOutFormat).realAmountIn.amount.token.decimals,
                },
              },
            },
            amountOut: {
              amount: {
                raw: (response as ReturnTypeComputeAmountOutFormat).amountOut.amount.raw.toNumber(),
                token: {
                  symbol: (response as ReturnTypeComputeAmountOutFormat).amountOut.amount.token.symbol,
                  mint: (response as ReturnTypeComputeAmountOutFormat).amountOut.amount.token.mint,
                  decimals: (response as ReturnTypeComputeAmountOutFormat).amountOut.amount.token.decimals,
                },
              },
            },
            minAmountOut: {
              amount: {
                numerator: (response as ReturnTypeComputeAmountOutFormat).minAmountOut.amount.raw.toNumber(),
                token: {
                  symbol: (response as ReturnTypeComputeAmountOutFormat).minAmountOut.amount.token.symbol,
                  mint: (response as ReturnTypeComputeAmountOutFormat).minAmountOut.amount.token.mint,
                  decimals: (response as ReturnTypeComputeAmountOutFormat).minAmountOut.amount.token.decimals,
                },
              },
            },
          },
  });

  logger.info(`Executing ${amount.toFixed(4)} ${side} swap in pool ${poolAddress}`);

  // Use hardcoded compute units for CLMM swaps
  const COMPUTE_UNITS = 600000;

  // Get priority fee from solana (returns lamports/CU)
  const priorityFeeInLamports = await solana.estimateGasPrice();
  // Convert lamports to microLamports (1 lamport = 1,000,000 microLamports)
  const priorityFeePerCU = Math.floor(priorityFeeInLamports * 1e6);

  // Build transaction with SDK - pass parameters directly
  let transaction: VersionedTransaction;
  if (side === 'BUY') {
    const pseudo = response as ReturnTypeComputeAmountOutBaseOut;
    const amountInRaw = pseudo.amountIn.amount;
    const maxAmountInRaw = pseudo.maxAmountIn.amount;
    const amountOutRaw = pseudo.realAmountOut.amount;
    logger.debug(
      `CLMM BUY swap | amountOut=${amount} ${outputToken.symbol} -> input=${
        inputToken.symbol
      } maxInRaw=${maxAmountInRaw.toString()}`
    );

    ({ transaction } = (await raydium.raydiumSDK.clmm.swapBaseOut({
      poolInfo,
      poolKeys: poolKeysToUse,
      outputMint: outputToken.address,
      amountInMax: maxAmountInRaw,
      amountOut: amountOutRaw,
      observationId: clmmPoolInfo.observationId,
      ownerInfo: {
        useSOLBalance: useNativeSolBalance,
      },
      txVersion: raydium.txVersion,
      remainingAccounts: pseudo.remainingAccounts ?? [],
      computeBudgetConfig: {
        units: COMPUTE_UNITS,
        microLamports: priorityFeePerCU,
      },
    })) as { transaction: VersionedTransaction });
  } else {
    const exactInResponse = response as ReturnTypeComputeAmountOutFormat;
    ({ transaction } = (await raydium.raydiumSDK.clmm.swap({
      poolInfo,
      poolKeys: poolKeysToUse,
      inputMint: inputToken.address,
      amountIn: exactInResponse.realAmountIn.amount.raw,
      amountOutMin: exactInResponse.minAmountOut.amount.raw,
      observationId: clmmPoolInfo.observationId,
      ownerInfo: {
        useSOLBalance: useNativeSolBalance,
      },
      remainingAccounts: exactInResponse.remainingAccounts,
      txVersion: raydium.txVersion,
      computeBudgetConfig: {
        units: COMPUTE_UNITS,
        microLamports: priorityFeePerCU,
      },
    })) as { transaction: VersionedTransaction });
  }

  // Sign transaction using helper
  transaction = (await raydium.signTransaction(
    transaction,
    walletAddress,
    isHardwareWallet,
    wallet
  )) as VersionedTransaction;

  // Simulate transaction with proper error handling
  await solana.simulateWithErrorHandling(transaction as VersionedTransaction, fastify);

  // Send and confirm - keep retry loop here for retrying same tx hash
  const { confirmed, signature, txData } = await solana.sendAndConfirmRawTransaction(transaction);

  // Handle confirmation status
  const result = await solana.handleConfirmation(
    signature,
    confirmed,
    txData,
    inputToken.address,
    outputToken.address,
    walletAddress,
    side
  );

  if (result.status === 1) {
    logger.info(
      `Swap executed successfully: ${result.data?.amountIn.toFixed(4)} ${
        inputToken.symbol
      } -> ${result.data?.amountOut.toFixed(4)} ${outputToken.symbol}`
    );
  }

  return result as ExecuteSwapResponseType;
}

export const executeSwapRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: RaydiumClmmExecuteSwapRequestType;
    Reply: ExecuteSwapResponseType;
  }>(
    '/execute-swap',
    {
      schema: {
        description: 'Execute a swap on Raydium CLMM',
        tags: ['/connector/raydium'],
        body: RaydiumClmmExecuteSwapRequest,
        response: { 200: ExecuteSwapResponse },
      },
    },
    async (request) => {
      // context for structured error details
      let errContext: ErrorContext = {};

      try {
        const {
          network,
          walletAddress,
          baseToken,
          quoteToken,
          amount,
          side,
          poolAddress,
          slippagePct,
          useNativeSolBalance,
        } = request.body;
        const networkToUse = network;

        errContext = {
          walletAddress,
          poolAddress,
          amount,
          side,
          tokenIn: side === 'BUY' ? quoteToken : baseToken, // BUY spends quote, SELL spends base
          tokenOut: side === 'BUY' ? baseToken : quoteToken,
        };

        // If no pool address provided, find default pool
        let poolAddressToUse = poolAddress;
        if (!poolAddressToUse) {
          const solana = await Solana.getInstance(networkToUse);

          // Resolve token symbols to get proper symbols for pool lookup
          const baseTokenInfo = await solana.getToken(baseToken);
          const quoteTokenInfo = await solana.getToken(quoteToken);

          if (!baseTokenInfo || !quoteTokenInfo) {
            throw fastify.httpErrors.badRequest(
              sanitizeErrorMessage('Token not found: {}', !baseTokenInfo ? baseToken : quoteToken)
            );
          }

          // Use PoolService to find pool by token pair
          const { PoolService } = await import('../../../services/pool-service');
          const poolService = PoolService.getInstance();

          const pool = await poolService.getPool(
            'raydium',
            networkToUse,
            'clmm',
            baseTokenInfo.symbol,
            quoteTokenInfo.symbol
          );

          if (!pool) {
            throw fastify.httpErrors.notFound(
              `No CLMM pool found for ${baseTokenInfo.symbol}-${quoteTokenInfo.symbol} on Raydium`
            );
          }

          poolAddressToUse = pool.address;
        }

        errContext.poolAddress = poolAddressToUse;

        return await executeSwap(
          fastify,
          networkToUse,
          walletAddress,
          baseToken,
          quoteToken,
          amount,
          side as 'BUY' | 'SELL',
          poolAddressToUse,
          slippagePct,
          useNativeSolBalance ?? false
        );
      } catch (e) {
        throw mapSwapError(fastify, e, errContext);
      }
    }
  );
};

export default executeSwapRoute;
