import { BigNumber, ethers } from 'ethers';

import { approveEthereumToken } from '../../../../src/chains/ethereum/routes/approve';
import { unwrapEthereum } from '../../../../src/chains/ethereum/routes/unwrap';
import { wrapEthereum } from '../../../../src/chains/ethereum/routes/wrap';
import { Ethereum } from '../../../../src/chains/ethereum/ethereum';
import { acquireWalletLock, getNextNonce, invalidateNonce } from '../../../../src/chains/ethereum/nonce-manager';
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

describe('ethereum nonce flows for wrap/unwrap/approve', () => {
  const walletAddress = '0x1234567890123456789012345678901234567890';
  const receipt = {
    transactionHash: '0xtx',
    status: 1,
    gasUsed: BigNumber.from('21000'),
    effectiveGasPrice: BigNumber.from('1000000000'),
  };

  const makeFastify = async () => {
    const server = fastifyWithTypeProvider();
    await server.register(require('@fastify/sensible'));
    return server;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (acquireWalletLock as jest.Mock).mockResolvedValue(jest.fn());
    (getNextNonce as jest.Mock).mockResolvedValue(3);
    (invalidateNonce as jest.Mock).mockResolvedValue(undefined);
  });

  it('wrap uses nonce manager and passes nonce to deposit', async () => {
    const fastify = await makeFastify();
    const releaseLock = jest.fn();
    (acquireWalletLock as jest.Mock).mockResolvedValue(releaseLock);

    const deposit = jest.fn().mockResolvedValue({});
    (ethers.Contract as unknown as jest.Mock).mockImplementation(() => ({
      populateTransaction: { deposit },
    }));

    const wallet = {
      address: walletAddress,
      sendTransaction: jest.fn().mockResolvedValue({
        hash: '0xtx',
        nonce: 3,
        wait: jest.fn().mockResolvedValue(receipt),
      }),
    };

    const provider = {};
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({
      init: jest.fn(),
      isHardwareWallet: jest.fn().mockResolvedValue(false),
      getWallet: jest.fn().mockResolvedValue(wallet),
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 50000 }),
      provider,
    });

    const result = await wrapEthereum(fastify, 'mainnet', walletAddress, '1.0');

    expect(result.status).toBe(1);
    expect(getNextNonce).toHaveBeenCalledWith(provider, walletAddress, 'mainnet');
    expect(deposit).toHaveBeenCalledWith(expect.objectContaining({ nonce: 3 }));
    expect(releaseLock).toHaveBeenCalled();
  });

  it('wrap invalidates nonce on nonce error', async () => {
    const fastify = await makeFastify();
    const releaseLock = jest.fn();
    (acquireWalletLock as jest.Mock).mockResolvedValue(releaseLock);

    const deposit = jest.fn().mockResolvedValue({});
    (ethers.Contract as unknown as jest.Mock).mockImplementation(() => ({
      populateTransaction: { deposit },
    }));

    const wallet = {
      address: walletAddress,
      sendTransaction: jest.fn().mockRejectedValue(new Error('nonce too low')),
    };

    const provider = {};
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({
      init: jest.fn(),
      isHardwareWallet: jest.fn().mockResolvedValue(false),
      getWallet: jest.fn().mockResolvedValue(wallet),
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 50000 }),
      provider,
    });

    await expect(wrapEthereum(fastify, 'mainnet', walletAddress, '1.0')).rejects.toThrow('Failed to wrap');

    expect(invalidateNonce).toHaveBeenCalledWith(walletAddress, 'mainnet');
    expect(releaseLock).toHaveBeenCalled();
  });

  it('unwrap uses nonce manager and passes nonce to withdraw', async () => {
    const fastify = await makeFastify();
    const releaseLock = jest.fn();
    (acquireWalletLock as jest.Mock).mockResolvedValue(releaseLock);

    const withdraw = jest.fn().mockResolvedValue({});
    const balanceOf = jest.fn().mockResolvedValue(BigNumber.from('1000000000000000000'));
    (ethers.Contract as unknown as jest.Mock).mockImplementation(() => ({
      balanceOf,
      populateTransaction: { withdraw },
    }));

    const wallet = {
      address: walletAddress,
      sendTransaction: jest.fn().mockResolvedValue({
        hash: '0xtx',
        nonce: 3,
        wait: jest.fn().mockResolvedValue(receipt),
      }),
    };

    const provider = {};
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({
      init: jest.fn(),
      isHardwareWallet: jest.fn().mockResolvedValue(false),
      getWallet: jest.fn().mockResolvedValue(wallet),
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 50000 }),
      provider,
    });

    const result = await unwrapEthereum(fastify, 'mainnet', walletAddress, '1.0');

    expect(result.status).toBe(1);
    expect(getNextNonce).toHaveBeenCalledWith(provider, walletAddress, 'mainnet');
    expect(withdraw).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ nonce: 3 }));
    expect(releaseLock).toHaveBeenCalled();
  });

  it('unwrap invalidates nonce on nonce error', async () => {
    const fastify = await makeFastify();
    const releaseLock = jest.fn();
    (acquireWalletLock as jest.Mock).mockResolvedValue(releaseLock);

    const withdraw = jest.fn().mockResolvedValue({});
    const balanceOf = jest.fn().mockResolvedValue(BigNumber.from('1000000000000000000'));
    (ethers.Contract as unknown as jest.Mock).mockImplementation(() => ({
      balanceOf,
      populateTransaction: { withdraw },
    }));

    const wallet = {
      address: walletAddress,
      sendTransaction: jest.fn().mockRejectedValue(new Error('nonce too low')),
    };

    const provider = {};
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({
      init: jest.fn(),
      isHardwareWallet: jest.fn().mockResolvedValue(false),
      getWallet: jest.fn().mockResolvedValue(wallet),
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 50000 }),
      provider,
    });

    await expect(unwrapEthereum(fastify, 'mainnet', walletAddress, '1.0')).rejects.toThrow('Failed to unwrap');

    expect(invalidateNonce).toHaveBeenCalledWith(walletAddress, 'mainnet');
    expect(releaseLock).toHaveBeenCalled();
  });

  it('approve uses nonce manager and passes nonce to approve', async () => {
    const fastify = await makeFastify();
    const releaseLock = jest.fn();
    (acquireWalletLock as jest.Mock).mockResolvedValue(releaseLock);

    const approve = jest.fn().mockResolvedValue({
      hash: '0xtx',
      nonce: 3,
      wait: jest.fn().mockResolvedValue(receipt),
    });

    const provider = {};
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({
      init: jest.fn(),
      isHardwareWallet: jest.fn().mockResolvedValue(false),
      getWallet: jest.fn().mockResolvedValue({ address: walletAddress }),
      getContract: jest.fn().mockReturnValue({ approve }),
      getToken: jest.fn().mockReturnValue({ address: '0xToken', decimals: 18, symbol: 'TKN' }),
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 100000 }),
      provider,
      buildInsufficientFundsMessage: jest.fn(),
    });

    const result = await approveEthereumToken(
      fastify,
      'mainnet',
      walletAddress,
      '0xSpender',
      'TKN',
      '1.0'
    );

    expect(result.status).toBe(1);
    expect(getNextNonce).toHaveBeenCalledWith(provider, walletAddress, 'mainnet');
    expect(approve).toHaveBeenCalledWith('0xSpender', expect.any(BigNumber), expect.objectContaining({ nonce: 3 }));
    expect(releaseLock).toHaveBeenCalled();
  });

  it('approve invalidates nonce on nonce error', async () => {
    const fastify = await makeFastify();
    const releaseLock = jest.fn();
    (acquireWalletLock as jest.Mock).mockResolvedValue(releaseLock);

    const approve = jest.fn().mockRejectedValue(new Error('nonce too low'));

    const provider = {};
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({
      init: jest.fn(),
      isHardwareWallet: jest.fn().mockResolvedValue(false),
      getWallet: jest.fn().mockResolvedValue({ address: walletAddress }),
      getContract: jest.fn().mockReturnValue({ approve }),
      getToken: jest.fn().mockReturnValue({ address: '0xToken', decimals: 18, symbol: 'TKN' }),
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 100000 }),
      provider,
      buildInsufficientFundsMessage: jest.fn(),
    });

    await expect(
      approveEthereumToken(
        fastify,
        'mainnet',
        walletAddress,
        '0xSpender',
        'TKN',
        '1.0'
      )
    ).rejects.toThrow('Failed to approve token');

    expect(invalidateNonce).toHaveBeenCalledWith(walletAddress, 'mainnet');
    expect(releaseLock).toHaveBeenCalled();
  });
});
