import { BigNumber, utils } from 'ethers';
import { FastifyPluginAsync, FastifyInstance } from 'fastify';

import { Ethereum } from '../../../chains/ethereum/ethereum';
import { EthereumLedger } from '../../../chains/ethereum/ethereum-ledger';
import { acquireWalletLock, getNextNonce, invalidateNonce } from '../../../chains/ethereum/nonce-manager';
import { getEthereumChainConfig } from '../../../chains/ethereum/ethereum.config';
import { waitForTransactionWithTimeout } from '../../../chains/ethereum/ethereum.utils';
import { ExecuteQuoteRequestType, SwapExecuteResponseType, SwapExecuteResponse } from '../../../schemas/router-schema';
import { logger } from '../../../services/logger';
import { quoteCache } from '../../../services/quote-cache';
import { getPancakeswapPermit2Address } from '../pancakeswap.contracts';
import { PancakeswapExecuteQuoteRequest } from '../schemas';

async function executeQuote(
  fastify: FastifyInstance,
  walletAddress: string,
  network: string,
  quoteId: string
): Promise<SwapExecuteResponseType> {
  // Retrieve cached quote
  const cached = quoteCache.get(quoteId);
  if (!cached) {
    throw fastify.httpErrors.badRequest('Quote not found or expired');
  }

  const { quote, request } = cached;
  const { inputToken, outputToken, side, amount, gasMax, gasMultiplierPct } = request;

  const ethereum = await Ethereum.getInstance(network);

  // Check if this is a hardware wallet
  const isHardwareWallet = await ethereum.isHardwareWallet(walletAddress);

  logger.info(
    `Executing quote ${quoteId} for ${amount} ${inputToken.symbol} -> ${outputToken.symbol}${
      isHardwareWallet ? ' with hardware wallet' : ''
    }`
  );

  // Check and approve allowance if needed
  if (inputToken.address !== ethereum.nativeTokenSymbol) {
    const requiredAllowance = BigNumber.from(quote.trade.inputAmount.quotient.toString());
    const universalRouterAddress = quote.methodParameters.to;
    const permit2Address = getPancakeswapPermit2Address(network);

    // Step 1: Check Permit2 allowance (owner -> Permit2 -> UniversalRouter)
    logger.info(`Checking Permit2 allowance for ${inputToken.symbol}`);
    const permit2Abi = [
      'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
      'function approve(address token, address spender, uint160 amount, uint48 expiration)',
    ];
    const permit2Contract = new (await import('ethers')).Contract(permit2Address, permit2Abi, ethereum.provider);
    const allowanceStruct = await permit2Contract.allowance(walletAddress, inputToken.address, universalRouterAddress);
    const currentPermitAllowance = BigNumber.from(allowanceStruct.amount.toString());
    const expiration = Number(allowanceStruct.expiration);
    const now = Math.floor(Date.now() / 1000);

    if (currentPermitAllowance.gte(requiredAllowance) && (expiration === 0 || expiration > now)) {
      logger.info(`Permit2 allowance is sufficient and not expired`);
    } else {
      logger.info(
        `Insufficient Permit2 allowance. Current: ${utils.formatUnits(
          currentPermitAllowance,
          inputToken.decimals
        )}, required: ${utils.formatUnits(requiredAllowance, inputToken.decimals)}`
      );

      // If hardware wallet, ask user to pre-approve via API to avoid STF
      if (isHardwareWallet) {
        throw fastify.httpErrors.badRequest(
          `Permit2 allowance missing/expired for ${inputToken.symbol}. ` +
            `Please call /chains/ethereum/approve with spender "${permit2Address}" and token "${inputToken.symbol}", ` +
            `or connect a software wallet.`
        );
      }

      // Auto-approve via Permit2.approve (owner -> Permit2 -> UniversalRouter)
      const wallet = await ethereum.getWallet(walletAddress);
      const signerPermit2 = permit2Contract.connect(wallet);
      const MAX_UINT160 = BigNumber.from(2).pow(160).sub(1);
      const amountToApprove = requiredAllowance.gt(MAX_UINT160) ? MAX_UINT160 : requiredAllowance;
      const newExpiration = now + 60 * 60 * 24 * 30; // 30 days

      logger.info(
        `Sending Permit2.approve for ${inputToken.symbol} -> UniversalRouter (amount=${amountToApprove.toString()}, exp=${newExpiration})`
      );
      const releaseApproveLock = await acquireWalletLock(walletAddress, network);
      let approveTx;
      try {
        approveTx = await signerPermit2.approve(
          inputToken.address,
          universalRouterAddress,
          amountToApprove,
          newExpiration,
          {
            nonce: await getNextNonce(ethereum.provider, walletAddress, network),
          }
        );
      } finally {
        releaseApproveLock();
      }
      const approveReceipt = await waitForTransactionWithTimeout(approveTx, 30000);
      if (!approveReceipt || approveReceipt.status !== 1) {
        throw fastify.httpErrors.internalServerError('Permit2 approval transaction failed or timed out');
      }
      logger.info(`Permit2 approval confirmed: ${approveTx.hash}`);
    }
  }

  // Execute the swap transaction
  let txReceipt;
  let txHash: string | undefined;

  const releaseLock = await acquireWalletLock(walletAddress, network);
  try {
    if (isHardwareWallet) {
      // Hardware wallet flow
      logger.info('Hardware wallet detected. Building swap transaction for Ledger signing.');

      const ledger = new EthereumLedger();
      const nonce = await getNextNonce(ethereum.provider, walletAddress, network);

      // Get gas options with increased gas limit for Universal Router V2
      const gasLimit = 500000; // Increased for Universal Router V2
      const gasOptions = await ethereum.prepareGasOptions(undefined, gasLimit, {
        gasMax,
        gasMultiplierPct,
      });

      // Build unsigned transaction with gas parameters
      const unsignedTx = {
        to: quote.methodParameters.to,
        data: quote.methodParameters.calldata,
        value: quote.methodParameters.value,
        nonce: nonce,
        chainId: ethereum.chainId,
        ...gasOptions, // Include gas parameters from prepareGasOptions (includes gasLimit)
      };

      // Sign with Ledger
      const signedTx = await ledger.signTransaction(walletAddress, unsignedTx as any);

      // Send the signed transaction
      const txResponse = await ethereum.provider.sendTransaction(signedTx);
      txHash = txResponse.hash;
      logger.info(`Transaction sent: ${txHash}`);

      // Wait for confirmation with timeout (30 seconds for hardware wallets)
      txReceipt = await waitForTransactionWithTimeout(txResponse, 30000);
    } else {
      // Regular wallet flow
      let wallet;
      try {
        wallet = await ethereum.getWallet(walletAddress);
      } catch (err) {
        logger.error(`Failed to load wallet: ${err.message}`);
        throw fastify.httpErrors.internalServerError(`Failed to load wallet: ${err.message}`);
      }

      // Get gas options with increased gas limit for Universal Router V2
      // Pancakeswap Universal Router V2 swaps typically use between 200k-500k gas
      const gasLimit = 500000; // Increased for Universal Router V2
      const gasOptions = await ethereum.prepareGasOptions(undefined, gasLimit, {
        gasMax,
        gasMultiplierPct,
      });
      logger.info(`Using gas limit: ${gasOptions.gasLimit?.toString() || gasLimit}`);

      // Build transaction parameters with gas options
      const txData = {
        to: quote.methodParameters.to,
        data: quote.methodParameters.calldata,
        value: quote.methodParameters.value,
        nonce: await getNextNonce(ethereum.provider, walletAddress, network),
        ...gasOptions, // Include gas parameters from prepareGasOptions (includes gasLimit)
      };

      logger.info(`Using gas options: ${JSON.stringify({ ...gasOptions, gasLimit: gasLimit.toString() })}`);

      // Send transaction directly without relying on ethers' automatic gas estimation
      const txResponse = await wallet.sendTransaction(txData);
      txHash = txResponse.hash;
      logger.info(`Transaction sent: ${txHash}`);

      // Wait for transaction confirmation with timeout
      txReceipt = await waitForTransactionWithTimeout(txResponse);
    }

    // Log transaction info if available
    if (txReceipt) {
      logger.info(`Transaction hash: ${txReceipt.transactionHash}`);
      logger.info(`Gas used: ${txReceipt.gasUsed?.toString() || 'unknown'}`);
    }
  } catch (error) {
    logger.error(`Swap execution error: ${error.message}`);
    if (error?.code === 'NONCE_EXPIRED' || error?.message?.toLowerCase().includes('nonce')) {
      invalidateNonce(walletAddress, network);
    }
    // Log more details about the error for debugging Universal Router issues
    if (error.error && error.error.data) {
      logger.error(`Error data: ${error.error.data}`);
    }
    if (error.reason) {
      logger.error(`Error reason: ${error.reason}`);
    }
    if (error.transaction) {
      logger.debug(`Transaction details: ${JSON.stringify(error.transaction)}`);
    }
    if (error.receipt) {
      logger.debug(`Transaction receipt: ${JSON.stringify(error.receipt)}`);
    }

    // Handle specific error cases
    if (error.message && error.message.includes('insufficient funds')) {
      throw fastify.httpErrors.badRequest(
        'Insufficient funds for transaction. Please ensure you have enough ETH to cover gas costs.'
      );
    } else if (error.message && error.message.includes('cannot estimate gas')) {
      throw fastify.httpErrors.badRequest(
        'Transaction would fail. This could be due to an expired quote, insufficient token balance, or market conditions have changed. Please request a new quote.'
      );
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

  // Calculate expected amounts from the trade
  const expectedAmountIn = parseFloat(quote.trade.inputAmount.toExact());
  const expectedAmountOut = parseFloat(quote.trade.outputAmount.toExact());

  // Use the new handleTransactionConfirmation helper
  // Pass txHash so it's returned even when receipt is not yet available (pending transactions)
  const result = ethereum.handleTransactionConfirmation(
    txReceipt,
    inputToken.address,
    outputToken.address,
    expectedAmountIn,
    expectedAmountOut,
    side,
    txHash
  );

  // Handle different transaction states
  if (result.status === -1) {
    // Transaction failed
    logger.error(`Transaction failed on-chain. Receipt: ${JSON.stringify(txReceipt)}`);
    throw fastify.httpErrors.internalServerError(
      'Transaction reverted on-chain. This could be due to slippage, expired quote, insufficient funds, or other blockchain issues.'
    );
  }

  if (result.status === 0) {
    // Transaction is still pending
    logger.info(`Transaction ${result.signature || 'pending'} is still pending`);
    return result;
  }

  // Transaction confirmed (status === 1)
  logger.info(
    `Swap executed successfully: ${expectedAmountIn} ${inputToken.symbol} -> ${expectedAmountOut} ${outputToken.symbol}`
  );

  // Remove quote from cache only after successful execution (confirmed)
  quoteCache.delete(quoteId);

  return result;
}

export { executeQuote };

export const executeQuoteRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: ExecuteQuoteRequestType;
    Reply: SwapExecuteResponseType;
  }>(
    '/execute-quote',
    {
      schema: {
        description: 'Execute a previously fetched quote from Pancakeswap Universal Router',
        tags: ['/connector/pancakeswap'],
        body: PancakeswapExecuteQuoteRequest,
        response: { 200: SwapExecuteResponse },
      },
    },
    async (request) => {
      try {
        const {
          walletAddress = getEthereumChainConfig().defaultWallet,
          network = getEthereumChainConfig().defaultNetwork,
          quoteId,
        } = request.body as typeof PancakeswapExecuteQuoteRequest._type;

        return await executeQuote(fastify, walletAddress, network, quoteId);
      } catch (e) {
        if (e.statusCode) throw e;
        logger.error('Error executing quote:', e);
        throw fastify.httpErrors.internalServerError(e.message || 'Internal server error');
      }
    }
  );
};

export default executeQuoteRoute;
