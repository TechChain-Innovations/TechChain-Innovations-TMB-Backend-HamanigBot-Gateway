import { BigNumber, Contract, utils } from 'ethers';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';
import { approveEthereumToken } from '../../../chains/ethereum/routes/approve';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { EthereumLedger } from '../../../chains/ethereum/ethereum-ledger';
import { waitForTransactionWithTimeout } from '../../../chains/ethereum/ethereum.utils';
import { ExecuteSwapRequestType, SwapExecuteResponseType, SwapExecuteResponse } from '../../../schemas/router-schema';
import { logger } from '../../../services/logger';
import { UniswapExecuteSwapRequest } from '../schemas';
import { Uniswap } from '../uniswap';
import { getUniswapV3SwapRouter02Address, ISwapRouter02ABI } from '../uniswap.contracts';
import { formatTokenAmount } from '../uniswap.utils';

import { getUniswapClmmQuote } from './quoteSwap';

// Default gas limit for CLMM swap operations
const CLMM_SWAP_GAS_LIMIT = 350000;

// In-memory per-wallet lock to serialize tx submissions and avoid nonce collisions
const walletLocks = new Map<string, Promise<void>>();

const normalizeGasInput = (value?: number | null) => (value && value > 0 ? value : undefined);

async function buildGasOptions(
  ethereum: Ethereum,
  gasLimit: number,
  gasMax?: number,
  gasMultiplierPct?: number,
): Promise<any> {
  const cap = normalizeGasInput(gasMax);
  const multiplier = normalizeGasInput(gasMultiplierPct);
  const manual = cap !== undefined || multiplier !== undefined;

  if (!manual) {
    return ethereum.prepareGasOptions(undefined, gasLimit);
  }

  const baseGwei = await ethereum.estimateGasPrice();
  const withMultiplier = multiplier ? baseGwei * (1 + multiplier / 100) : baseGwei;
  const capped = cap ? Math.min(withMultiplier, cap) : withMultiplier;
  const effective = capped; // let chain/node decide if too low
  const gasPriceWei = utils.parseUnits(effective.toString(), 'gwei');

  return {
    type: 0, // legacy to honor manual gas price
    gasLimit: gasLimit ?? CLMM_SWAP_GAS_LIMIT,
    gasPrice: gasPriceWei,
  };
}

async function acquireWalletLock(address: string): Promise<() => void> {
  const key = address.toLowerCase();
  const prev = walletLocks.get(key) ?? Promise.resolve();

  let releaseNext: () => void;
  const next = new Promise<void>(resolve => {
    releaseNext = resolve;
  });

  walletLocks.set(key, prev.then(() => next));
  await prev;

  return () => {
    releaseNext();
    if (walletLocks.get(key) === next) {
      walletLocks.delete(key);
    }
  };
}

export async function executeClmmSwap(
  fastify: FastifyInstance,
  walletAddress: string,
  network: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct: number,
  poolAddress?: string,
  gasMax?: number,
  gasMultiplierPct?: number,
): Promise<SwapExecuteResponseType> {
  const releaseLock = await acquireWalletLock(walletAddress);
  let ethereum: Ethereum | undefined;
  let lastGasOptions: any;
  let lastTxValue: BigNumber | undefined;
  try {
  ethereum = await Ethereum.getInstance(network);
  await ethereum.init();

  const uniswap = await Uniswap.getInstance(network);

  // Find pool address
  const poolAddressToUse = poolAddress?.trim() || (await uniswap.findDefaultPool(baseToken, quoteToken, 'clmm'));
  if (!poolAddressToUse) {
    throw fastify.httpErrors.notFound(`No CLMM pool found for pair ${baseToken}-${quoteToken}`);
  }

  // Get quote using the shared quote function
  const { quote } = await getUniswapClmmQuote(
    fastify,
    network,
    poolAddressToUse,
    baseToken,
    quoteToken,
    amount,
    side,
    slippagePct
  );

  // Check if this is a hardware wallet
  const isHardwareWallet = await ethereum.isHardwareWallet(walletAddress);

  // Get SwapRouter02 contract address
  const routerAddress = getUniswapV3SwapRouter02Address(network);

  logger.info(`Executing swap using SwapRouter02:`);
  logger.info(`Router address: ${routerAddress}`);
  logger.info(`Pool address: ${poolAddressToUse}`);
  logger.info(`Input token: ${quote.inputToken.address}`);
  logger.info(`Output token: ${quote.outputToken.address}`);
  logger.info(`Side: ${side}`);
  logger.info(`Fee tier: ${quote.feeTier}`);

  // Check allowance for input token
  const amountNeeded = side === 'SELL' ? quote.rawAmountIn : quote.rawMaxAmountIn;

  // Use provider for both hardware and regular wallets to check allowance
  const tokenContract = ethereum.getContract(quote.inputToken.address, ethereum.provider);
  const allowance = await tokenContract.allowance(walletAddress, routerAddress);
  const currentAllowance = BigNumber.from(allowance);

  logger.info(
    `Current allowance: ${formatTokenAmount(currentAllowance.toString(), quote.inputToken.decimals)} ${
      quote.inputToken.symbol
    }`
  );
  logger.info(
    `Amount needed: ${formatTokenAmount(amountNeeded, quote.inputToken.decimals)} ${quote.inputToken.symbol}`
  );

  // Auto-approve if allowance is insufficient (10x buffer)
  if (currentAllowance.lt(amountNeeded)) {
    const approvalAmount = BigNumber.from(amountNeeded).mul(10);
    logger.warn(
      `Insufficient allowance for ${quote.inputToken.symbol}. Current=${formatTokenAmount(
        currentAllowance.toString(),
        quote.inputToken.decimals
      )} needed=${formatTokenAmount(amountNeeded, quote.inputToken.decimals)}. Approving ${formatTokenAmount(
        approvalAmount.toString(),
        quote.inputToken.decimals
      )}`
    );

    const approval = await approveEthereumToken(
      fastify,
      network,
      walletAddress,
      'uniswap',
      quote.inputToken.address,
      // amount parameter expects a string; we pass raw token amount (not human) to avoid rounding
      approvalAmount.toString()
    );

    logger.info(`Approval submitted: ${approval.signature}`);
  }

  logger.info(
    `Sufficient allowance exists: ${formatTokenAmount(currentAllowance.toString(), quote.inputToken.decimals)} ${
      quote.inputToken.symbol
    }`
  );

  // Balance check to avoid on-chain reverts
  const balanceRaw: BigNumber = await tokenContract.balanceOf(walletAddress);
  const balanceHuman = formatTokenAmount(balanceRaw.toString(), quote.inputToken.decimals);
  const requiredAmount = side === 'SELL' ? quote.rawAmountIn : quote.rawMaxAmountIn;
  logger.info(`Current balance: ${balanceHuman} ${quote.inputToken.symbol}`);
  logger.info(
    `Amount required for swap: ${formatTokenAmount(requiredAmount, quote.inputToken.decimals)} ${quote.inputToken.symbol}`,
  );

  if (balanceRaw.lt(requiredAmount)) {
    throw fastify.httpErrors.badRequest(
      `Insufficient ${quote.inputToken.symbol} balance. Need ${formatTokenAmount(
        requiredAmount,
        quote.inputToken.decimals,
      )}, available ${balanceHuman}`,
    );
  }

  // Build swap parameters
  const swapParams = {
    tokenIn: quote.inputToken.address,
    tokenOut: quote.outputToken.address,
    fee: quote.feeTier,
    recipient: walletAddress,
    amountIn: 0,
    amountOut: 0,
    amountInMaximum: 0,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  };

  let receipt;

  if (isHardwareWallet) {
      // Hardware wallet flow
      logger.info(`Hardware wallet detected for ${walletAddress}. Building swap transaction for Ledger signing.`);

      const ledger = new EthereumLedger();
      const nonce = await ethereum.provider.getTransactionCount(walletAddress, 'pending');

      // Build the swap transaction data
      const iface = new utils.Interface(ISwapRouter02ABI);
      let data;

      if (side === 'SELL') {
        // exactInputSingle - we know the exact input amount
        swapParams.amountIn = quote.rawAmountIn;
        swapParams.amountOutMinimum = quote.rawMinAmountOut;

        logger.info(`ExactInputSingle params:`);
        logger.info(`  amountIn: ${swapParams.amountIn}`);
        logger.info(`  amountOutMinimum: ${swapParams.amountOutMinimum}`);

        const exactInputParams = {
          tokenIn: swapParams.tokenIn,
          tokenOut: swapParams.tokenOut,
          fee: swapParams.fee,
          recipient: swapParams.recipient,
          amountIn: swapParams.amountIn,
          amountOutMinimum: swapParams.amountOutMinimum,
          sqrtPriceLimitX96: swapParams.sqrtPriceLimitX96,
        };

        data = iface.encodeFunctionData('exactInputSingle', [exactInputParams]);
      } else {
        // exactOutputSingle - we know the exact output amount
        swapParams.amountOut = quote.rawAmountOut;
        swapParams.amountInMaximum = quote.rawMaxAmountIn;

        logger.info(`ExactOutputSingle params:`);
        logger.info(`  amountOut: ${swapParams.amountOut}`);
        logger.info(`  amountInMaximum: ${swapParams.amountInMaximum}`);

        const exactOutputParams = {
          tokenIn: swapParams.tokenIn,
          tokenOut: swapParams.tokenOut,
          fee: swapParams.fee,
          recipient: swapParams.recipient,
          amountOut: swapParams.amountOut,
          amountInMaximum: swapParams.amountInMaximum,
          sqrtPriceLimitX96: swapParams.sqrtPriceLimitX96,
        };

        data = iface.encodeFunctionData('exactOutputSingle', [exactOutputParams]);
      }

      const gasOptions = await buildGasOptions(ethereum, CLMM_SWAP_GAS_LIMIT, gasMax, gasMultiplierPct);
      lastGasOptions = gasOptions;

      // Build unsigned transaction with gas parameters
      const unsignedTx = {
        to: routerAddress,
        data: data,
        nonce: nonce,
        chainId: ethereum.chainId,
        ...gasOptions, // Include gas parameters from prepareGasOptions
      };
      lastTxValue = (unsignedTx as any).value;

      // Sign with Ledger
      const signedTx = await ledger.signTransaction(walletAddress, unsignedTx as any);

      // Send the signed transaction
      const txResponse = await ethereum.provider.sendTransaction(signedTx);

      logger.info(`Transaction sent: ${txResponse.hash}`);

      // Wait for confirmation with timeout (30 seconds for hardware wallets)
      receipt = await waitForTransactionWithTimeout(txResponse, 30000);
    } else {
      // Regular wallet flow
      let wallet;
      try {
        wallet = await ethereum.getWallet(walletAddress);
      } catch (err) {
        logger.error(`Failed to load wallet: ${err.message}`);
        throw fastify.httpErrors.internalServerError(`Failed to load wallet: ${err.message}`);
      }

      const routerContract = new Contract(routerAddress, ISwapRouter02ABI, wallet);

      const txOptions = await buildGasOptions(ethereum, CLMM_SWAP_GAS_LIMIT, gasMax, gasMultiplierPct);
      lastGasOptions = txOptions;
      lastTxValue = (txOptions as any).value;

      let tx;
      if (side === 'SELL') {
        // exactInputSingle - we know the exact input amount
        swapParams.amountIn = quote.rawAmountIn;
        swapParams.amountOutMinimum = quote.rawMinAmountOut;

        logger.info(`ExactInputSingle params:`);
        logger.info(`  amountIn: ${swapParams.amountIn}`);
        logger.info(`  amountOutMinimum: ${swapParams.amountOutMinimum}`);

        const exactInputParams = {
          tokenIn: swapParams.tokenIn,
          tokenOut: swapParams.tokenOut,
          fee: swapParams.fee,
          recipient: swapParams.recipient,
          amountIn: swapParams.amountIn,
          amountOutMinimum: swapParams.amountOutMinimum,
          sqrtPriceLimitX96: swapParams.sqrtPriceLimitX96,
        };

        tx = await routerContract.exactInputSingle(exactInputParams, txOptions);
      } else {
        // exactOutputSingle - we know the exact output amount
        swapParams.amountOut = quote.rawAmountOut;
        swapParams.amountInMaximum = quote.rawMaxAmountIn;

        logger.info(`ExactOutputSingle params:`);
        logger.info(`  amountOut: ${swapParams.amountOut}`);
        logger.info(`  amountInMaximum: ${swapParams.amountInMaximum}`);

        const exactOutputParams = {
          tokenIn: swapParams.tokenIn,
          tokenOut: swapParams.tokenOut,
          fee: swapParams.fee,
          recipient: swapParams.recipient,
          amountOut: swapParams.amountOut,
          amountInMaximum: swapParams.amountInMaximum,
          sqrtPriceLimitX96: swapParams.sqrtPriceLimitX96,
        };

        tx = await routerContract.exactOutputSingle(exactOutputParams, txOptions);
      }

      logger.info(`Transaction sent: ${tx.hash}`);

      // Wait for transaction confirmation
      receipt = await tx.wait();
    }

  // Check if the transaction was successful
  if (receipt.status === 0) {
    logger.error(`Transaction failed on-chain. Receipt: ${JSON.stringify(receipt)}`);
    throw fastify.httpErrors.internalServerError(
      'Transaction reverted on-chain. This could be due to slippage, insufficient funds, or other blockchain issues.'
    );
  }

  logger.info(`Transaction confirmed: ${receipt.transactionHash}`);
  logger.info(`Gas used: ${receipt.gasUsed.toString()}`);

  // Calculate amounts using quote values
  const amountIn = quote.estimatedAmountIn;
  const amountOut = quote.estimatedAmountOut;

  // Calculate balance changes as numbers
  const baseTokenBalanceChange = side === 'BUY' ? amountOut : -amountIn;
  const quoteTokenBalanceChange = side === 'BUY' ? -amountIn : amountOut;

  // Calculate gas fee (formatTokenAmount already returns a number)
  const gasFee = formatTokenAmount(
    receipt.gasUsed.mul(receipt.effectiveGasPrice).toString(),
    18 // ETH has 18 decimals
  );

  // Determine token addresses for computed fields
  const tokenIn = quote.inputToken.address;
  const tokenOut = quote.outputToken.address;

  return {
    signature: receipt.transactionHash,
    status: 1, // CONFIRMED
    data: {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      fee: gasFee,
      baseTokenBalanceChange,
      quoteTokenBalanceChange,
    },
  };
  } catch (error) {
    logger.error(`Swap execution error: ${error.message}`);
    if (error.transaction) {
      logger.debug(`Transaction details: ${JSON.stringify(error.transaction)}`);
    }
    if (error.receipt) {
      logger.debug(`Transaction receipt: ${JSON.stringify(error.receipt)}`);
    }

    // Handle specific error cases
    if (error.message && error.message.includes('insufficient funds')) {
      const message = ethereum
        ? await ethereum.buildInsufficientFundsMessage({
            error,
            walletAddress,
            txParams: { ...lastGasOptions, value: lastTxValue },
          })
        : 'Insufficient funds for transaction. Please ensure you have enough ETH to cover gas costs.';
      throw fastify.httpErrors.badRequest(message);
    } else if (error.message.includes('rejected on Ledger')) {
      throw fastify.httpErrors.badRequest('Transaction rejected on Ledger device');
    } else if (error.message.includes('Ledger device is locked')) {
      throw fastify.httpErrors.badRequest(error.message);
    } else if (error.message.includes('Wrong app is open')) {
      throw fastify.httpErrors.badRequest(error.message);
    }

    // Re-throw if already a fastify error
    if (error.statusCode) {
      throw error;
    }

    throw fastify.httpErrors.internalServerError(`Failed to execute swap: ${error.message}`);
  } finally {
    releaseLock();
  }
}

export const executeSwapRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: ExecuteSwapRequestType;
    Reply: SwapExecuteResponseType;
  }>(
    '/execute-swap',
    {
      schema: {
        description: 'Execute a swap on Uniswap V3 CLMM using SwapRouter02',
        tags: ['/connector/uniswap'],
        body: UniswapExecuteSwapRequest,
        response: { 200: SwapExecuteResponse },
      },
    },
    async (request) => {
      try {
        const {
          walletAddress,
          network,
          baseToken,
          quoteToken,
          amount,
          side,
          slippagePct,
          poolAddress,
          gasMax,
          gasMultiplierPct,
        } = request.body as typeof UniswapExecuteSwapRequest._type;

        return await executeClmmSwap(
          fastify,
          walletAddress,
          network,
          baseToken,
          quoteToken,
          amount,
          side as 'BUY' | 'SELL',
          slippagePct,
          poolAddress,
          gasMax,
          gasMultiplierPct,
        );
      } catch (e) {
        if (e.statusCode) throw e;
        logger.error('Error executing swap:', e);
        throw fastify.httpErrors.internalServerError(e.message || 'Internal server error');
      }
    }
  );
};

export default executeSwapRoute;
