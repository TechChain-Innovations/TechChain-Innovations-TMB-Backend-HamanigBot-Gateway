import { providers } from 'ethers';

import {
  acquireNonceWithLock,
  releaseNonceByLockId,
  getExternalLocksStatus,
  cleanupExpiredLocks,
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

describe('nonce-manager external locks (for wallet-service coordination)', () => {
  const testAddress = '0xTestWallet1234567890123456789012345678901';
  const testNetwork = 'bsc';

  afterEach(() => {
    // Clean up any locks from previous tests
    const status = getExternalLocksStatus();
    status.locks.forEach((lock) => {
      releaseNonceByLockId(lock.lockId, false);
    });
    invalidateNonce(testAddress, testNetwork);
    jest.restoreAllMocks();
  });

  describe('acquireNonceWithLock', () => {
    it('should acquire a lock and return lockId, nonce, expiresAt', async () => {
      const provider = makeProvider(42);

      const result = await acquireNonceWithLock(
        provider as providers.Provider,
        testAddress,
        testNetwork,
        5000, // 5 second TTL
      );

      expect(result).toHaveProperty('lockId');
      expect(result).toHaveProperty('nonce');
      expect(result).toHaveProperty('expiresAt');

      expect(typeof result.lockId).toBe('string');
      expect(result.lockId.length).toBeGreaterThan(0);
      expect(result.nonce).toBe(42);
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it('should increment nonce for subsequent acquisitions after release', async () => {
      const provider = makeProvider(10);

      // First acquisition
      const first = await acquireNonceWithLock(provider as providers.Provider, testAddress, testNetwork);
      expect(first.nonce).toBe(10);

      // Release with transactionSent=true (nonce consumed)
      const released = releaseNonceByLockId(first.lockId, true);
      expect(released).toBe(true);

      // Second acquisition should get next nonce
      const second = await acquireNonceWithLock(provider as providers.Provider, testAddress, testNetwork);
      expect(second.nonce).toBe(11);

      releaseNonceByLockId(second.lockId, true);
    });

    it('should serialize concurrent lock requests for the same wallet', async () => {
      const provider = makeProvider(100);
      const order: string[] = [];

      // First lock - acquired
      const firstPromise = acquireNonceWithLock(provider as providers.Provider, testAddress, testNetwork, 1000).then(
        (result) => {
          order.push('first-acquired');
          return result;
        },
      );

      const first = await firstPromise;

      // Second lock request - should wait
      const secondPromise = acquireNonceWithLock(provider as providers.Provider, testAddress, testNetwork, 1000).then(
        (result) => {
          order.push('second-acquired');
          return result;
        },
      );

      // Give a short delay to ensure second is waiting
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(order).toEqual(['first-acquired']);

      // Release first lock
      releaseNonceByLockId(first.lockId, true);
      order.push('first-released');

      // Now second should acquire
      const second = await secondPromise;
      releaseNonceByLockId(second.lockId, true);

      expect(order).toEqual(['first-acquired', 'first-released', 'second-acquired']);
    });
  });

  describe('releaseNonceByLockId', () => {
    it('should return true when releasing a valid lock', async () => {
      const provider = makeProvider(50);

      const { lockId } = await acquireNonceWithLock(provider as providers.Provider, testAddress, testNetwork);

      const result = releaseNonceByLockId(lockId, true);
      expect(result).toBe(true);
    });

    it('should return false when releasing a non-existent lock', () => {
      const result = releaseNonceByLockId('non-existent-lock-id', true);
      expect(result).toBe(false);
    });

    it('should rollback nonce when transactionSent=false', async () => {
      const provider = makeProvider(20);

      // Acquire nonce
      const { lockId, nonce } = await acquireNonceWithLock(provider as providers.Provider, testAddress, testNetwork);
      expect(nonce).toBe(20);

      // Release with transactionSent=false (rollback)
      releaseNonceByLockId(lockId, false);

      // Next acquisition should get the same nonce (rolled back)
      const second = await acquireNonceWithLock(provider as providers.Provider, testAddress, testNetwork);
      expect(second.nonce).toBe(20); // Same nonce, not incremented

      releaseNonceByLockId(second.lockId, true);
    });
  });

  describe('getExternalLocksStatus', () => {
    it('should return empty status when no locks exist', () => {
      const status = getExternalLocksStatus();
      expect(status.activeLocks).toBe(0);
      expect(status.locks).toEqual([]);
    });

    it('should return active lock info', async () => {
      const provider = makeProvider(77);

      const { lockId, nonce } = await acquireNonceWithLock(provider as providers.Provider, testAddress, testNetwork);

      const status = getExternalLocksStatus();
      expect(status.activeLocks).toBe(1);
      expect(status.locks).toHaveLength(1);
      expect(status.locks[0]).toMatchObject({
        lockId,
        address: testAddress.toLowerCase(),
        nonce,
        isExpired: false,
      });

      releaseNonceByLockId(lockId, true);
    });
  });

  describe('cleanupExpiredLocks', () => {
    it('should remove expired locks', async () => {
      const provider = makeProvider(33);

      // Acquire with very short TTL
      const { lockId } = await acquireNonceWithLock(
        provider as providers.Provider,
        testAddress,
        testNetwork,
        1, // 1ms TTL - will expire immediately
      );

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Cleanup should remove the expired lock
      const cleaned = cleanupExpiredLocks();
      expect(cleaned).toBeGreaterThanOrEqual(1);

      // Verify lock is gone
      const status = getExternalLocksStatus();
      const stillExists = status.locks.some((l) => l.lockId === lockId);
      expect(stillExists).toBe(false);
    });
  });

  describe('lock TTL expiration', () => {
    it('should mark locks as expired after TTL', async () => {
      const provider = makeProvider(55);

      const { lockId } = await acquireNonceWithLock(
        provider as providers.Provider,
        testAddress,
        testNetwork,
        1, // 1ms TTL
      );

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      const status = getExternalLocksStatus();
      const lock = status.locks.find((l) => l.lockId === lockId);

      // Lock should still exist but be marked as expired
      if (lock) {
        expect(lock.isExpired).toBe(true);
      }

      // Clean up
      cleanupExpiredLocks();
    });
  });
});
