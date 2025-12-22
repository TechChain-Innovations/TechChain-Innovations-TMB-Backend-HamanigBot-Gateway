import { DecimalUtil } from '@orca-so/common-sdk';
import {
  PoolUtils,
  ReturnTypeComputeAmountOutFormat,
  ReturnTypeComputeAmountOutBaseOut,
  TickQuery,
  TickUtils,
  TickArrayLayout,
  getPdaTickArrayAddress,
  getMultipleAccountsInfoWithCustomFlags,
} from '@raydium-io/raydium-sdk-v2';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { Decimal } from 'decimal.js';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';

import { estimateGasSolana } from '../../../chains/solana/routes/estimate-gas';
import { Solana } from '../../../chains/solana/solana';
import {
  QuoteSwapResponseType,
  QuoteSwapResponse,
  QuoteSwapRequestType,
  QuoteSwapRequest,
} from '../../../schemas/clmm-schema';
import { logger } from '../../../services/logger';
import { sanitizeErrorMessage } from '../../../services/sanitize';
import { Raydium } from '../raydium';
import { RaydiumConfig } from '../raydium.config';
import { RaydiumClmmQuoteSwapRequest } from '../schemas';
import { getDefaultSolanaNetwork } from '../../../chains/solana/solana.utils';
import type { ApiV3PoolInfoConcentratedItem, ClmmKeys } from '@raydium-io/raydium-sdk-v2';

export type ClmmContext = {
  network: string;
  solana: Solana;
  raydium: Raydium;
  poolInfo?: ApiV3PoolInfoConcentratedItem;
  poolKeys?: ClmmKeys;
};

async function tryBuildContext(network: string, poolAddress?: string): Promise<ClmmContext & { poolFound: boolean }> {
  const solana = await Solana.getInstance(network);
  const raydium = await Raydium.getInstance(network);

  if (!poolAddress) {
    return { network, solana, raydium, poolFound: false };
  }

  try {
    const poolResult = await raydium.getClmmPoolfromAPI(poolAddress);
    const poolInfo = poolResult ? poolResult[0] : undefined;
    const poolKeys = poolResult ? poolResult[1] : undefined;

    return { network, solana, raydium, poolInfo, poolKeys, poolFound: Boolean(poolInfo) };
  } catch (error) {
    logger.warn(`Failed to load CLMM pool ${poolAddress} on ${network}: ${error.message}`);
    return { network, solana, raydium, poolFound: false };
  }
}

/**
 * Resolve Solana/Raydium context for a CLMM pool.
 * - Uses requested network when pool exists there
 * - Falls back to mainnet-beta when pool is missing (common when a mainnet pool is queried on devnet)
 */
export async function resolveClmmContext(
  fastify: FastifyInstance,
  requestedNetwork: string | undefined,
  poolAddress?: string
): Promise<ClmmContext> {
  const defaultNetwork = getDefaultSolanaNetwork() || 'mainnet-beta';
  const initialNetwork = requestedNetwork || defaultNetwork;

  // 1) Try requested (or default) network
  let ctx = await tryBuildContext(initialNetwork, poolAddress);
  if (!poolAddress || ctx.poolFound) {
    return ctx;
  }

  // 2) Fallback to mainnet-beta if pool not found and we are not already there
  if (initialNetwork !== 'mainnet-beta') {
    const fallbackCtx = await tryBuildContext('mainnet-beta', poolAddress);
    if (fallbackCtx.poolFound) {
      logger.warn(
        `Pool ${poolAddress} not found on ${initialNetwork}, falling back to mainnet-beta for Raydium CLMM request`
      );
      return fallbackCtx;
    }
  }

  throw fastify.httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
}

export async function getSwapQuote(
  fastify: FastifyInstance,
  network: string,
  baseTokenSymbol: string,
  quoteTokenSymbol: string,
  amount: number,
  side: 'BUY' | 'SELL',
  poolAddress: string,
  slippagePct?: number,
  ctx?: ClmmContext
) {
  const resolvedCtx = ctx ?? (await resolveClmmContext(fastify, network, poolAddress));
  const { solana, raydium, poolInfo: resolvedPoolInfo, poolKeys } = resolvedCtx;
  const baseToken = await solana.getToken(baseTokenSymbol);
  const quoteToken = await solana.getToken(quoteTokenSymbol);

  if (!baseToken || !quoteToken) {
    throw fastify.httpErrors.notFound(`Token not found: ${!baseToken ? baseTokenSymbol : quoteTokenSymbol}`);
  }

  const poolInfo = resolvedPoolInfo ?? (await raydium.getClmmPoolfromAPI(poolAddress))?.[0];
  if (!poolInfo) {
    throw fastify.httpErrors.notFound(sanitizeErrorMessage('Pool not found: {}', poolAddress));
  }

  // For buy orders, we're swapping quote token for base token (ExactOut)
  // For sell orders, we're swapping base token for quote token (ExactIn)
  const [inputToken, outputToken] = side === 'BUY' ? [quoteToken, baseToken] : [baseToken, quoteToken];

  const amount_bn =
    side === 'BUY'
      ? DecimalUtil.toBN(new Decimal(amount), outputToken.decimals) // desired base amount (exactOut target)
      : DecimalUtil.toBN(new Decimal(amount), inputToken.decimals); // exactIn when SELL
  const clmmPoolInfo = await PoolUtils.fetchComputeClmmInfo({
    connection: solana.connection,
    poolInfo,
  });
  // Fetch a wider set of tick arrays than the default (which only grabs ~7 around current tick).
  // Large exactOut BUY quotes can span many ticks and fail with "No enough initialized tickArray"
  // if the cache is too small. TickQuery.getTickArrays pulls ~15 around current by default.
  const tickCache: { [key: string]: any } = {};
  tickCache[poolAddress] = await fetchWideTickArrays(
    solana.connection,
    clmmPoolInfo,
    // widen the window substantially so exactOut BUY doesn't miss distant arrays
    120
  );
  const slippagePctEffective =
    slippagePct === undefined || slippagePct === null ? RaydiumConfig.config.slippagePct : Number(slippagePct);
  const effectiveSlippage = new BN(slippagePctEffective / 100);

  // Convert BN to number for slippage
  const effectiveSlippageNumber = effectiveSlippage.toNumber();

  let response: ReturnTypeComputeAmountOutFormat | ReturnTypeComputeAmountOutBaseOut;

  if (side === 'BUY') {
    const exactOut = await PoolUtils.computeAmountIn({
      poolInfo: clmmPoolInfo,
      tickArrayCache: tickCache[poolAddress],
      amountOut: amount_bn,
      epochInfo: await raydium.raydiumSDK.fetchEpochInfo(),
      baseMint: new PublicKey(outputToken.address),
      slippage: effectiveSlippageNumber,
    });

    response = {
      amountIn: { amount: exactOut.amountIn.amount },
      maxAmountIn: { amount: exactOut.maxAmountIn.amount },
      realAmountOut: exactOut.realAmountOut,
      priceImpact: exactOut.priceImpact,
      remainingAccounts: exactOut.remainingAccounts,
    } as ReturnTypeComputeAmountOutBaseOut;
  } else {
    response = await PoolUtils.computeAmountOutFormat({
      poolInfo: clmmPoolInfo,
      tickArrayCache: tickCache[poolAddress],
      amountIn: amount_bn,
      tokenOut: poolInfo['mintB'],
      slippage: effectiveSlippageNumber,
      epochInfo: await raydium.raydiumSDK.fetchEpochInfo(),
      catchLiquidityInsufficient: true,
    });
  }

  return {
    inputToken,
    outputToken,
    response,
    clmmPoolInfo,
    tickArrayCache: tickCache[poolAddress],
  };
}

/**
 * Fetches a wide window of initialized tick arrays around current tick to avoid
 * "No enough initialized tickArray" on large exact-out quotes.
 */
async function fetchWideTickArrays(
  connection: any,
  poolInfo: any,
  window: number
): Promise<Record<string, any>> {
  const programId = new PublicKey(poolInfo.programId);
  const poolId = new PublicKey(poolInfo.id);

  const currentStartIndex = TickUtils.getTickArrayStartIndexByTick(poolInfo.tickCurrent, poolInfo.tickSpacing);

  // 1) Try initialized indexes around current tick (bitmap-based)
  const startIndexArray = TickUtils.getInitializedTickArrayInRange(
    poolInfo.tickArrayBitmap,
    poolInfo.exBitmapInfo,
    poolInfo.tickSpacing,
    currentStartIndex,
    window
  );
  const cache: Record<string, any> = {};
  await fetchIntoCache(connection, programId, poolId, startIndexArray, cache);

  // 2) If still empty, brute-force ±window around current start index
  if (Object.keys(cache).length === 0) {
    const brute: number[] = [];
    // Use TickQuery.tickCount to step across arrays; if missing, default to 60 ticks per array.
    const ticksPerArray = (TickQuery as any).tickCount ? (TickQuery as any).tickCount(poolInfo.tickSpacing) : 60;
    const step = poolInfo.tickSpacing * ticksPerArray;
    for (let i = currentStartIndex - window; i <= currentStartIndex + window; i += step) {
      brute.push(i);
    }
    await fetchIntoCache(connection, programId, poolId, brute, cache);
  }

  // 3) If still empty, last resort: TickQuery default
  if (Object.keys(cache).length === 0) {
    const fallback = await TickQuery.getTickArrays(
      connection,
      programId,
      poolId,
      poolInfo.tickCurrent,
      poolInfo.tickSpacing,
      poolInfo.tickArrayBitmap,
      poolInfo.exBitmapInfo
    );
    Object.assign(cache, fallback);
  }

  if (Object.keys(cache).length === 0) {
    throw new Error('Not enough tick data for quote');
  }

  return cache;
}

async function fetchIntoCache(
  connection: any,
  programId: PublicKey,
  poolId: PublicKey,
  startIndexArray: number[],
  cache: Record<string, any>
) {
  if (!startIndexArray.length) return;
  const tickArrays = startIndexArray.map((idx: number) => {
    const { publicKey } = getPdaTickArrayAddress(programId, poolId, idx);
    return { pubkey: publicKey };
  });

  const fetched = await getMultipleAccountsInfoWithCustomFlags(connection, tickArrays, { batchRequest: true });
  for (let i = 0; i < fetched.length; i++) {
    const account = fetched[i];
    if (!account?.accountInfo) continue;
    const layout = TickArrayLayout.decode(account.accountInfo.data);
    cache[layout.startTickIndex] = { ...layout, address: tickArrays[i].pubkey };
  }
}

export async function formatSwapQuote(
  fastify: FastifyInstance,
  network: string,
  baseTokenSymbol: string,
  quoteTokenSymbol: string,
  amount: number,
  side: 'BUY' | 'SELL',
  poolAddress: string,
  slippagePct?: number
): Promise<QuoteSwapResponseType> {
  const { inputToken, outputToken, response } = await getSwapQuote(
    fastify,
    network,
    baseTokenSymbol,
    quoteTokenSymbol,
    amount,
    side,
    poolAddress,
    slippagePct
  );
  logger.debug(
    `Raydium CLMM swap quote: ${side} ${amount} ${baseTokenSymbol}/${quoteTokenSymbol} in pool ${poolAddress}`,
    {
      inputToken: inputToken.symbol,
      outputToken: outputToken.symbol,
      responseType: side === 'BUY' ? 'ReturnTypeComputeAmountOutBaseOut' : 'ReturnTypeComputeAmountOutFormat',
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
    }
  );

  if (side === 'BUY') {
    const exactOutResponse = response as ReturnTypeComputeAmountOutBaseOut;
    const estimatedAmountOut = exactOutResponse.realAmountOut.amount.toNumber() / 10 ** outputToken.decimals;

    // amountIn/maxAmountIn come in RAW units but Raydium SDK scales them by outputToken decimals when output has more decimals.
    // Normalize to inputToken decimals by removing the decimal gap if needed.
    const decimalGap = Math.max(0, outputToken.decimals - inputToken.decimals);
    const amountInAdj = decimalGap
      ? exactOutResponse.amountIn.amount.div(new BN(10 ** decimalGap))
      : exactOutResponse.amountIn.amount;
    const maxAmountInAdj = decimalGap
      ? exactOutResponse.maxAmountIn.amount.div(new BN(10 ** decimalGap))
      : exactOutResponse.maxAmountIn.amount;

    const estimatedAmountIn = amountInAdj.toNumber() / 10 ** inputToken.decimals;
    const maxAmountIn = maxAmountInAdj.toNumber() / 10 ** inputToken.decimals;

    const price = estimatedAmountOut > 0 ? estimatedAmountIn / estimatedAmountOut : 0;

    // Calculate price impact percentage - ensure it's a valid number
    const priceImpactRaw = exactOutResponse.priceImpact ? Number(exactOutResponse.priceImpact) * 100 : 0;
    const priceImpactPct = isNaN(priceImpactRaw) || !isFinite(priceImpactRaw) ? 0 : priceImpactRaw;

    // Determine token addresses for computed fields
    const tokenIn = inputToken.address;
    const tokenOut = outputToken.address;

    // Validate all numeric values before returning
    const result = {
      // Base QuoteSwapResponse fields in correct order
      poolAddress,
      tokenIn,
      tokenOut,
      amountIn: isNaN(estimatedAmountIn) || !isFinite(estimatedAmountIn) ? 0 : estimatedAmountIn,
      amountOut: isNaN(estimatedAmountOut) || !isFinite(estimatedAmountOut) ? 0 : estimatedAmountOut,
      price: isNaN(price) || !isFinite(price) ? 0 : price,
      slippagePct: slippagePct || 1, // Default 1% if not provided
      minAmountOut: isNaN(estimatedAmountOut) || !isFinite(estimatedAmountOut) ? 0 : estimatedAmountOut,
      maxAmountIn: isNaN(maxAmountIn) || !isFinite(maxAmountIn) ? 0 : maxAmountIn,
      // CLMM-specific fields
      priceImpactPct: isNaN(priceImpactPct) || !isFinite(priceImpactPct) ? 0 : priceImpactPct,
    };

    logger.debug(`Returning CLMM quote result (BUY):`, result);
    return result;
  } else {
    const exactInResponse = response as ReturnTypeComputeAmountOutFormat;
    const estimatedAmountIn = exactInResponse.realAmountIn.amount.raw.toNumber() / 10 ** inputToken.decimals;
    const estimatedAmountOut = exactInResponse.amountOut.amount.raw.toNumber() / 10 ** outputToken.decimals;

    // Calculate minAmountOut using slippage
    const effectiveSlippage =
      slippagePct === undefined || slippagePct === null ? RaydiumConfig.config.slippagePct : Number(slippagePct);
    const minAmountOut = estimatedAmountOut * (1 - effectiveSlippage / 100);

    const price = estimatedAmountIn > 0 ? estimatedAmountOut / estimatedAmountIn : 0;

    // Calculate price impact percentage - ensure it's a valid number
    const priceImpactRaw = exactInResponse.priceImpact ? Number(exactInResponse.priceImpact) * 100 : 0;
    const priceImpactPct = isNaN(priceImpactRaw) || !isFinite(priceImpactRaw) ? 0 : priceImpactRaw;

    // Determine token addresses for computed fields
    const tokenIn = inputToken.address;
    const tokenOut = outputToken.address;

    // Validate all numeric values before returning
    const result = {
      // Base QuoteSwapResponse fields in correct order
      poolAddress,
      tokenIn,
      tokenOut,
      amountIn: isNaN(estimatedAmountIn) || !isFinite(estimatedAmountIn) ? 0 : estimatedAmountIn,
      amountOut: isNaN(estimatedAmountOut) || !isFinite(estimatedAmountOut) ? 0 : estimatedAmountOut,
      price: isNaN(price) || !isFinite(price) ? 0 : price,
      slippagePct: slippagePct || 1, // Default 1% if not provided
      minAmountOut: isNaN(minAmountOut) || !isFinite(minAmountOut) ? 0 : minAmountOut,
      maxAmountIn: isNaN(estimatedAmountIn) || !isFinite(estimatedAmountIn) ? 0 : estimatedAmountIn,
      // CLMM-specific fields
      priceImpactPct: isNaN(priceImpactPct) || !isFinite(priceImpactPct) ? 0 : priceImpactPct,
    };

    logger.info(`Returning CLMM quote result:`, result);
    return result;
  }
}

export const quoteSwapRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{
    Querystring: QuoteSwapRequestType;
    Reply: QuoteSwapResponseType;
  }>(
    '/quote-swap',
    {
      schema: {
        description: 'Get swap quote for Raydium CLMM',
        tags: ['/connector/raydium'],
        querystring: RaydiumClmmQuoteSwapRequest,
        response: { 200: QuoteSwapResponse },
      },
    },
    async (request) => {
      try {
        const { network, baseToken, quoteToken, amount, side, poolAddress, slippagePct } =
          request.query as typeof RaydiumClmmQuoteSwapRequest._type;
        const networkToUse = network;

        // Validate essential parameters
        if (!baseToken || !quoteToken || !amount || !side) {
          throw fastify.httpErrors.badRequest('baseToken, quoteToken, amount, and side are required');
        }

        const solana = await Solana.getInstance(networkToUse);

        let poolAddressToUse = poolAddress;

        // If poolAddress is not provided, look it up by token pair
        if (!poolAddressToUse) {
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

        const result = await formatSwapQuote(
          fastify,
          networkToUse,
          baseToken,
          quoteToken,
          amount,
          side as 'BUY' | 'SELL',
          poolAddressToUse,
          slippagePct
        );

        let gasEstimation = null;
        try {
          gasEstimation = await estimateGasSolana(fastify, networkToUse);
        } catch (error) {
          logger.warn(`Failed to estimate gas for swap quote: ${error.message}`);
        }

        return {
          poolAddress: poolAddressToUse,
          ...result,
        };
      } catch (e) {
        logger.error(e);
        // Preserve the original error if it's a FastifyError
        if (e.statusCode) {
          throw e;
        }
        throw fastify.httpErrors.internalServerError('Failed to get swap quote');
      }
    }
  );
};

export default quoteSwapRoute;
