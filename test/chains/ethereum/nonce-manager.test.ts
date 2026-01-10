import { providers } from 'ethers';

import {
  acquireWalletLock,
  getNextNonce,
  invalidateNonce,
} from '../../../src/chains/ethereum/nonce-manager';

type MockProvider = Pick<providers.Provider, 'getTransactionCount'>;

const makeProvider = (values: number[] | number): MockProvider => {
  let call = 0;
  const getTransactionCount = jest.fn(async () => {
    if (Array.isArray(values)) {
      const index = Math.min(call, values.length - 1);
      call += 1;
      return values[index];
    }
    return values;
  });

  return { getTransactionCount } as MockProvider;
};

describe('nonce-manager', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the pending nonce and increments locally on subsequent calls', async () => {
    const provider = makeProvider(10);
    const address = '0x0000000000000000000000000000000000000001';

    const first = await getNextNonce(provider as providers.Provider, address);
    const second = await getNextNonce(provider as providers.Provider, address);

    expect(first).toBe(10);
    expect(second).toBe(11);
    expect(provider.getTransactionCount).toHaveBeenCalledWith(address, 'pending');
  });

  it('uses a higher pending nonce over cached state', async () => {
    const provider = makeProvider([5, 9]);
    const address = '0x0000000000000000000000000000000000000002';

    const first = await getNextNonce(provider as providers.Provider, address);
    const second = await getNextNonce(provider as providers.Provider, address);

    expect(first).toBe(5);
    expect(second).toBe(9);
  });

  it('resets the cached nonce when invalidated', async () => {
    const provider = makeProvider(7);
    const address = '0x0000000000000000000000000000000000000003';

    const first = await getNextNonce(provider as providers.Provider, address);
    const second = await getNextNonce(provider as providers.Provider, address);

    invalidateNonce(address);

    const third = await getNextNonce(provider as providers.Provider, address);

    expect(first).toBe(7);
    expect(second).toBe(8);
    expect(third).toBe(7);
  });

  it('serializes nonce allocation per wallet and scope', async () => {
    const address = '0x0000000000000000000000000000000000000004';
    const order: string[] = [];

    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    let resolveFirstAcquired!: () => void;
    const firstAcquired = new Promise<void>((resolve) => {
      resolveFirstAcquired = resolve;
    });

    const first = (async () => {
      const release = await acquireWalletLock(address, 'mainnet');
      order.push('first-acquired');
      resolveFirstAcquired();
      await hold;
      release();
      order.push('first-released');
    })();

    const second = (async () => {
      await firstAcquired;
      const release = await acquireWalletLock(address, 'mainnet');
      order.push('second-acquired');
      release();
    })();

    await firstAcquired;
    await Promise.resolve();
    expect(order).toEqual(['first-acquired']);

    releaseHold();
    await Promise.all([first, second]);

    expect(order).toEqual(['first-acquired', 'first-released', 'second-acquired']);
  });

  it('keeps locks independent across scopes', async () => {
    const address = '0x0000000000000000000000000000000000000005';
    const order: string[] = [];

    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    let resolveFirstAcquired!: () => void;
    const firstAcquired = new Promise<void>((resolve) => {
      resolveFirstAcquired = resolve;
    });

    let resolveSecondAcquired!: () => void;
    const secondAcquired = new Promise<void>((resolve) => {
      resolveSecondAcquired = resolve;
    });

    const first = (async () => {
      const release = await acquireWalletLock(address, 'scope-a');
      order.push('first-acquired');
      resolveFirstAcquired();
      await hold;
      release();
      order.push('first-released');
    })();

    const second = (async () => {
      await firstAcquired;
      const release = await acquireWalletLock(address, 'scope-b');
      order.push('second-acquired');
      resolveSecondAcquired();
      release();
    })();

    await firstAcquired;
    await Promise.race([
      secondAcquired,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Second scope lock did not acquire')), 25)
      ),
    ]);

    expect(order).toEqual(['first-acquired', 'second-acquired']);

    releaseHold();
    await Promise.all([first, second]);

    expect(order).toEqual(['first-acquired', 'second-acquired', 'first-released']);
  });
});
