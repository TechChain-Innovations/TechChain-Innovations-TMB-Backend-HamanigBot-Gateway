import { VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';

import { Solana } from '../../../chains/solana/solana';
import { ExecuteSwapResponse, ExecuteSwapResponseType, ExecuteSwapRequestType } from '../../../schemas/amm-schema';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { executeSwap as executeClmmSwap, mapSwapError } from '../clmm-routes/executeSwap';
import { Raydium } from '../raydium';
import { RaydiumConfig } from '../raydium.config';
import { isValidClmm } from '../raydium.utils';
import { RaydiumAmmExecuteSwapRequest } from '../schemas';

import { getRawSwapQuote } from './quoteSwap';

async function executeSwap(
  fastify: FastifyInstance,
  network: string,
  walletAddress: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  poolAddress: string,
  slippagePct?: number,
  useNativeSolBalance: boolean = false,
): Promise<ExecuteSwapResponseType> {
  const solana = await Solana.getInstance(network);
  const raydium = await Raydium.getInstance(network);

  // Prepare wallet and check if it's hardware
  const { wallet, isHardwareWallet } = await raydium.prepareWallet(walletAddress);

  // Get pool info from address
  const poolInfo = await raydium.getAmmPoolInfo(poolAddress);
  if (!poolInfo) {
    throw fastify.httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
  }

  // Use configured slippage if not provided
  const effectiveSlippage = slippagePct || RaydiumConfig.config.slippagePct;

  // Get swap quote
  const quote = await getRawSwapQuote(
    raydium,
    network,
    poolAddress,
    baseToken,
    quoteToken,
    amount,
    side,
    effectiveSlippage,
  );

  const inputToken = quote.inputToken;
  const outputToken = quote.outputToken;

  logger.info(`Executing ${amount.toFixed(4)} ${side} swap in pool ${poolAddress}`);

  // Use hardcoded compute units for AMM swaps
  const COMPUTE_UNITS = 300000;

  // Get priority fee from solana (returns lamports/CU)
  const priorityFeeInLamports = await solana.estimateGasPrice();
  // Convert lamports to microLamports (1 lamport = 1,000,000 microLamports)
  const priorityFeePerCU = Math.floor(priorityFeeInLamports * 1e6);
  let transaction: VersionedTransaction;

  // Get transaction based on pool type
  if (poolInfo.poolType === 'amm') {
    if (side === 'BUY') {
      // AMM swap base out (exact output)
      ({ transaction } = (await raydium.raydiumSDK.liquidity.swap({
        poolInfo: quote.poolInfo,
        poolKeys: quote.poolKeys,
        amountIn: quote.maxAmountIn,
        amountOut: new BN(quote.amountOut),
        fixedSide: 'out',
        inputMint: inputToken.address,
        txVersion: raydium.txVersion,
        config: {
          inputUseSolBalance: useNativeSolBalance,
          outputUseSolBalance: useNativeSolBalance,
        },
        computeBudgetConfig: {
          units: COMPUTE_UNITS,
          microLamports: priorityFeePerCU,
        },
      })) as { transaction: VersionedTransaction });
    } else {
      // AMM swap (exact input)
      ({ transaction } = (await raydium.raydiumSDK.liquidity.swap({
        poolInfo: quote.poolInfo,
        poolKeys: quote.poolKeys,
        amountIn: new BN(quote.amountIn),
        amountOut: quote.minAmountOut,
        fixedSide: 'in',
        inputMint: inputToken.address,
        txVersion: raydium.txVersion,
        config: {
          inputUseSolBalance: useNativeSolBalance,
          outputUseSolBalance: useNativeSolBalance,
        },
        computeBudgetConfig: {
          units: COMPUTE_UNITS,
          microLamports: priorityFeePerCU,
        },
      })) as { transaction: VersionedTransaction });
    }
  } else if (poolInfo.poolType === 'cpmm') {
    // Note: CPMM SDK automatically handles native SOL when token is WSOL
    // No explicit useSOLBalance needed - SDK checks if mint === WSOLMint internally
    if (side === 'BUY') {
      // CPMM swap base out (exact output)
      ({ transaction } = (await raydium.raydiumSDK.cpmm.swap({
        poolInfo: quote.poolInfo,
        poolKeys: quote.poolKeys,
        inputAmount: new BN(0), // not used when fixedOut is true
        fixedOut: true,
        swapResult: {
          inputAmount: quote.amountIn,
          outputAmount: new BN(quote.amountOut),
        },
        slippage: effectiveSlippage / 100,
        baseIn: inputToken.address === quote.poolInfo.mintA.address,
        txVersion: raydium.txVersion,
        computeBudgetConfig: {
          units: COMPUTE_UNITS,
          microLamports: priorityFeePerCU,
        },
      })) as { transaction: VersionedTransaction });
    } else {
      // CPMM swap (exact input)
      ({ transaction } = (await raydium.raydiumSDK.cpmm.swap({
        poolInfo: quote.poolInfo,
        poolKeys: quote.poolKeys,
        inputAmount: quote.amountIn,
        swapResult: {
          inputAmount: quote.amountIn,
          outputAmount: quote.amountOut,
        },
        slippage: effectiveSlippage / 100,
        baseIn: inputToken.address === quote.poolInfo.mintA.address,
        txVersion: raydium.txVersion,
        computeBudgetConfig: {
          units: COMPUTE_UNITS,
          microLamports: priorityFeePerCU,
        },
      })) as { transaction: VersionedTransaction });
    }
  } else {
    throw new Error(`Unsupported pool type: ${poolInfo.poolType}`);
  }

  // Sign transaction using helper
  transaction = (await raydium.signTransaction(
    transaction,
    walletAddress,
    isHardwareWallet,
    wallet,
  )) as VersionedTransaction;

  // Simulate transaction with proper error handling
  await solana.simulateWithErrorHandling(transaction as VersionedTransaction, fastify);

  const { confirmed, signature, txData } = await solana.sendAndConfirmRawTransaction(transaction);

  // Handle confirmation status
  const result = await solana.handleConfirmation(
    signature,
    confirmed,
    txData,
    inputToken.address,
    outputToken.address,
    walletAddress,
    side,
  );

  if (result.status === 1) {
    logger.info(
      `Swap executed successfully: ${result.data?.amountIn.toFixed(4)} ${
        inputToken.symbol
      } -> ${result.data?.amountOut.toFixed(4)} ${outputToken.symbol}`,
    );
  }

  return result as ExecuteSwapResponseType;
}

export const executeSwapRoute: FastifyPluginAsync = async (fastify) => {
  const walletAddressExample = await Solana.getWalletAddressExample();

  fastify.post<{
    Body: ExecuteSwapRequestType;
    Reply: ExecuteSwapResponseType;
  }>(
    '/execute-swap',
    {
      schema: {
        description: 'Execute a swap on Raydium AMM or CPMM',
        tags: ['/connector/raydium'],
        body: {
          ...RaydiumAmmExecuteSwapRequest,
          properties: {
            ...RaydiumAmmExecuteSwapRequest.properties,
            network: { type: 'string', default: 'mainnet-beta' },
            walletAddress: { type: 'string', examples: [walletAddressExample] },
            baseToken: { type: 'string', examples: ['SOL'] },
            quoteToken: { type: 'string', examples: ['USDC'] },
            amount: { type: 'number', examples: [0.01] },
            side: { type: 'string', examples: ['SELL'] },
            poolAddress: { type: 'string', examples: [''] },
            slippagePct: { type: 'number', examples: [1] },
          },
        },
        response: { 200: ExecuteSwapResponse },
      },
    },
    async (request) => {
      let errContext: {
        walletAddress?: string;
        poolAddress?: string;
        amount?: number;
        side?: string;
        tokenIn?: string;
        tokenOut?: string;
      } = {};
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
        } = request.body as typeof RaydiumAmmExecuteSwapRequest._type;
        const networkToUse = network;

        const normalizedSide = typeof side === 'string' ? side.toUpperCase() : undefined;
        errContext = {
          walletAddress,
          poolAddress,
          amount,
          side,
          tokenIn: normalizedSide === 'BUY' ? quoteToken : baseToken,
          tokenOut: normalizedSide === 'BUY' ? baseToken : quoteToken,
        };

        // If the supplied pool is actually a CLMM pool, transparently route to the CLMM handler
        if (poolAddress) {
          const raydium = await Raydium.getInstance(networkToUse);
          try {
            const [poolInfo] = await raydium.getPoolfromAPI(poolAddress);
            if (poolInfo && isValidClmm(poolInfo.programId)) {
              logger.info(`Detected CLMM pool ${poolAddress} on AMM execute-swap, routing to CLMM handler`);
              return await executeClmmSwap(
                fastify,
                networkToUse,
                walletAddress,
                baseToken,
                quoteToken,
                amount,
                side as 'BUY' | 'SELL',
                poolAddress,
                slippagePct,
                useNativeSolBalance ?? false,
              );
            }
          } catch (e) {
            // If we already have a structured HTTP error, bubble it up instead of misclassifying the pool
            if ((e as any)?.statusCode) {
              throw e;
            }
            logger.warn(
              `Pool type detection failed for ${poolAddress}, falling back to AMM path: ${(e as Error)?.message}`,
            );
          }
        }

        // If no pool address provided, find default pool
        let poolAddressToUse = poolAddress;
        if (!poolAddressToUse) {
          const solana = await Solana.getInstance(networkToUse);

          // Resolve token symbols to get proper symbols for pool lookup
          const baseTokenInfo = await solana.getToken(baseToken);
          const quoteTokenInfo = await solana.getToken(quoteToken);

          if (!baseTokenInfo || !quoteTokenInfo) {
            throw fastify.httpErrors.badRequest(
              sanitizeErrorMessage('Token not found: {}', !baseTokenInfo ? baseToken : quoteToken),
            );
          }

          // Use PoolService to find pool by token pair
          const { PoolService } = await import('../../../services/pool-service');
          const poolService = PoolService.getInstance();

          const pool = await poolService.getPool(
            'raydium',
            networkToUse,
            'amm',
            baseTokenInfo.symbol,
            quoteTokenInfo.symbol,
          );

          if (!pool) {
            throw fastify.httpErrors.notFound(
              `No AMM pool found for ${baseTokenInfo.symbol}-${quoteTokenInfo.symbol} on Raydium`,
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
          useNativeSolBalance ?? false,
        );
      } catch (e) {
        throw mapSwapError(fastify, e, errContext);
      }
    },
  );
};

export default executeSwapRoute;
