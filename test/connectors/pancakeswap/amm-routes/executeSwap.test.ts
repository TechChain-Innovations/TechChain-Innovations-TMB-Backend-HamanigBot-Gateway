import { BigNumber, Contract } from 'ethers';

import { executeAmmSwap } from '../../../../src/connectors/pancakeswap/amm-routes/executeSwap';
import { getPancakeswapAmmQuote } from '../../../../src/connectors/pancakeswap/amm-routes/quoteSwap';
import { Ethereum } from '../../../../src/chains/ethereum/ethereum';
import { acquireWalletLock, getNextNonce, invalidateNonce } from '../../../../src/chains/ethereum/nonce-manager';
import { Pancakeswap } from '../../../../src/connectors/pancakeswap/pancakeswap';
import { fastifyWithTypeProvider } from '../../../utils/testUtils';

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  const Contract = jest.fn();
  return {
    ...actual,
    Contract,
    ethers: {
      ...actual.ethers,
      Contract,
    },
  };
});

jest.mock('../../../../src/chains/ethereum/ethereum');
jest.mock('../../../../src/chains/ethereum/nonce-manager');
jest.mock('../../../../src/connectors/pancakeswap/pancakeswap');
jest.mock('../../../../src/connectors/pancakeswap/amm-routes/quoteSwap');

describe('pancakeswap amm executeSwap nonce handling', () => {
  const walletAddress = '0x1234567890123456789012345678901234567890';
  const quote = {
    inputToken: { address: '0xTokenIn', decimals: 18, symbol: 'TOKENIN' },
    outputToken: { address: '0xTokenOut', decimals: 18, symbol: 'TOKENOUT' },
    rawAmountIn: '1000000000000000000',
    rawMinAmountOut: '900000000000000000',
    rawAmountOut: '900000000000000000',
    rawMaxAmountIn: '1100000000000000000',
    pathAddresses: ['0xTokenIn', '0xTokenOut'],
    estimatedAmountIn: 1,
    estimatedAmountOut: 0.9,
  };

  const makeFastify = async () => {
    const server = fastifyWithTypeProvider();
    await server.register(require('@fastify/sensible'));
    return server;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (acquireWalletLock as jest.Mock).mockResolvedValue(jest.fn());
    (getNextNonce as jest.Mock).mockResolvedValue(9);
    (invalidateNonce as jest.Mock).mockResolvedValue(undefined);
  });

  it('uses nonce manager and passes nonce to swap', async () => {
    const fastify = await makeFastify();
    const releaseLock = jest.fn();
    (acquireWalletLock as jest.Mock).mockResolvedValue(releaseLock);

    const allowanceContract = {
      allowance: jest.fn().mockResolvedValue(BigNumber.from('2000000000000000000')),
    };

    const txResponse = {
      hash: '0xtx',
      wait: jest.fn().mockResolvedValue({
        transactionHash: '0xtx',
        status: 1,
        gasUsed: BigNumber.from('21000'),
        effectiveGasPrice: BigNumber.from('1000000000'),
      }),
    };

    const routerContract = {
      swapExactTokensForTokens: jest.fn().mockResolvedValue(txResponse),
      swapTokensForExactTokens: jest.fn(),
    };
    (Contract as unknown as jest.Mock).mockImplementation(() => routerContract);

    const ethereumInstance = {
      init: jest.fn(),
      isHardwareWallet: jest.fn().mockResolvedValue(false),
      getContract: jest.fn().mockReturnValue(allowanceContract),
      getWallet: jest.fn().mockResolvedValue({ address: walletAddress }),
      provider: {},
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 300000 }),
      handleTransactionConfirmation: jest.fn().mockReturnValue({
        signature: '0xtx',
        status: 1,
        data: {
          tokenIn: quote.inputToken.address,
          tokenOut: quote.outputToken.address,
          amountIn: quote.estimatedAmountIn,
          amountOut: quote.estimatedAmountOut,
        },
      }),
    };

    (Ethereum.getInstance as jest.Mock).mockResolvedValue(ethereumInstance);
    (Pancakeswap.getInstance as jest.Mock).mockResolvedValue({
      findDefaultPool: jest.fn().mockResolvedValue('0xpool'),
    });
    (getPancakeswapAmmQuote as jest.Mock).mockResolvedValue({ quote });

    const result = await executeAmmSwap(
      fastify,
      walletAddress,
      'bsc',
      'TOKENIN',
      'TOKENOUT',
      1,
      'SELL',
      1
    );

    expect(result.status).toBe(1);
    expect(getNextNonce).toHaveBeenCalledWith(ethereumInstance.provider, walletAddress, 'bsc');
    expect(routerContract.swapExactTokensForTokens).toHaveBeenCalledWith(
      quote.rawAmountIn,
      quote.rawMinAmountOut,
      quote.pathAddresses,
      walletAddress,
      expect.any(Number),
      expect.objectContaining({ nonce: 9 })
    );
    expect(releaseLock).toHaveBeenCalled();
  });

  it('invalidates cached nonce on nonce error', async () => {
    const fastify = await makeFastify();
    const releaseLock = jest.fn();
    (acquireWalletLock as jest.Mock).mockResolvedValue(releaseLock);

    const allowanceContract = {
      allowance: jest.fn().mockResolvedValue(BigNumber.from('2000000000000000000')),
    };

    const routerContract = {
      swapExactTokensForTokens: jest.fn().mockRejectedValue(new Error('nonce too low')),
      swapTokensForExactTokens: jest.fn(),
    };
    (Contract as unknown as jest.Mock).mockImplementation(() => routerContract);

    const ethereumInstance = {
      init: jest.fn(),
      isHardwareWallet: jest.fn().mockResolvedValue(false),
      getContract: jest.fn().mockReturnValue(allowanceContract),
      getWallet: jest.fn().mockResolvedValue({ address: walletAddress }),
      provider: {},
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 300000 }),
      handleTransactionConfirmation: jest.fn(),
    };

    (Ethereum.getInstance as jest.Mock).mockResolvedValue(ethereumInstance);
    (Pancakeswap.getInstance as jest.Mock).mockResolvedValue({
      findDefaultPool: jest.fn().mockResolvedValue('0xpool'),
    });
    (getPancakeswapAmmQuote as jest.Mock).mockResolvedValue({ quote });

    await expect(
      executeAmmSwap(
        fastify,
        walletAddress,
        'bsc',
        'TOKENIN',
        'TOKENOUT',
        1,
        'SELL',
        1
      )
    ).rejects.toThrow('Failed to execute swap');

    expect(invalidateNonce).toHaveBeenCalledWith(walletAddress, 'bsc');
    expect(releaseLock).toHaveBeenCalled();
  });
});
