import { randomUUID } from 'crypto';

import { providers } from 'ethers';

import { logger } from '../../services/logger';

type NonceState = {
  nextNonce: number;
  updatedAt: number;
};

/**
 * Extended lock info for external API consumers (wallet-service)
 */
type ExternalLockInfo = {
  lockId: string;
  key: string;
  address: string;
  scope: string | undefined;
  nonce: number;
  expiresAt: number;
  release: () => void;
};

const walletLocks = new Map<string, Promise<void>>();
const nonceState = new Map<string, NonceState>();

/**
 * External locks acquired via API (for wallet-service coordination)
 * Key: lockId (UUID)
 */
const externalLocks = new Map<string, ExternalLockInfo>();

const buildKey = (scope: string | undefined, address: string) => `${scope ?? 'default'}:${address.toLowerCase()}`;

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const MAX_NONCE_GAP = parsePositiveInt(process.env.GATEWAY_MAX_NONCE_GAP, 5);
const MAX_NONCE_CACHE_AGE_MS = parsePositiveInt(process.env.GATEWAY_MAX_NONCE_CACHE_AGE_MS, 120000);

/** Default TTL for external locks: 60 seconds */
const DEFAULT_LOCK_TTL_MS = parsePositiveInt(process.env.GATEWAY_NONCE_LOCK_TTL_MS, 60000);

/** Cleanup interval for expired locks: 10 seconds */
const CLEANUP_INTERVAL_MS = 10000;

export async function acquireWalletLock(address: string, scope?: string): Promise<() => void> {
  const key = buildKey(scope, address);
  const previous = walletLocks.get(key) ?? Promise.resolve();

  let releaseNext: () => void;
  const next = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });

  walletLocks.set(
    key,
    previous.then(() => next),
  );
  await previous;

  return () => {
    releaseNext();
    if (walletLocks.get(key) === next) {
      walletLocks.delete(key);
    }
  };
}

export async function getNextNonce(provider: providers.Provider, address: string, scope?: string): Promise<number> {
  const key = buildKey(scope, address);
  const pendingNonce = await provider.getTransactionCount(address, 'pending');
  const current = nonceState.get(key);
  const cachedNonce = current?.nextNonce ?? 0;

  if (cachedNonce > pendingNonce && current) {
    const gap = cachedNonce - pendingNonce;
    const ageMs = Date.now() - current.updatedAt;
    if (gap >= MAX_NONCE_GAP || ageMs >= MAX_NONCE_CACHE_AGE_MS) {
      logger.warn(
        `[nonce] Resetting cached nonce for ${key}: pending=${pendingNonce} cached=${cachedNonce} gap=${gap} ageMs=${ageMs}`,
      );
      nonceState.set(key, { nextNonce: pendingNonce + 1, updatedAt: Date.now() });
      return pendingNonce;
    }
  }

  const nextNonce = Math.max(pendingNonce, cachedNonce);
  nonceState.set(key, { nextNonce: nextNonce + 1, updatedAt: Date.now() });
  return nextNonce;
}

export function invalidateNonce(address: string, scope?: string): void {
  const key = buildKey(scope, address);
  nonceState.delete(key);
}

// ============================================================================
// External API functions for wallet-service nonce coordination
// ============================================================================

/**
 * Acquire a nonce with an external lock (for wallet-service).
 * This acquires the internal wallet lock AND returns a lockId that must be
 * released via releaseNonceByLockId().
 *
 * @param provider - Ethers provider for fetching pending nonce
 * @param address - Wallet address
 * @param scope - Network scope (e.g., 'bsc', 'ethereum')
 * @param ttlMs - Time-to-live in milliseconds (default: 60000)
 * @returns Object with lockId, nonce, and expiresAt timestamp
 */
export async function acquireNonceWithLock(
  provider: providers.Provider,
  address: string,
  scope?: string,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
): Promise<{ lockId: string; nonce: number; expiresAt: number }> {
  const lockId = randomUUID();
  const key = buildKey(scope, address);

  logger.info(`🔒 [NONCE API] Acquiring lock | key=${key} | lockId=${lockId.substring(0, 8)}... | ttl=${ttlMs}ms`);

  // Acquire the internal wallet lock (this serializes access)
  const release = await acquireWalletLock(address, scope);

  // Get the next nonce
  const nonce = await getNextNonce(provider, address, scope);

  const expiresAt = Date.now() + ttlMs;

  // Store the lock info
  const lockInfo: ExternalLockInfo = {
    lockId,
    key,
    address: address.toLowerCase(),
    scope,
    nonce,
    expiresAt,
    release,
  };
  externalLocks.set(lockId, lockInfo);

  logger.info(
    `🔒 [NONCE API] ✅ Lock ACQUIRED | lockId=${lockId.substring(0, 8)}... | nonce=${nonce} | expires=${new Date(expiresAt).toISOString()}`,
  );

  return { lockId, nonce, expiresAt };
}

/**
 * Release an external lock by lockId.
 *
 * @param lockId - The lock ID returned from acquireNonceWithLock
 * @param transactionSent - Whether the transaction was actually sent to blockchain.
 *                          If false, the nonce is rolled back (decremented) so it can be reused.
 * @returns true if lock was found and released, false if not found
 */
export function releaseNonceByLockId(lockId: string, transactionSent: boolean): boolean {
  const lockInfo = externalLocks.get(lockId);

  if (!lockInfo) {
    logger.warn(
      `🔓 [NONCE API] ❌ Release FAILED | lockId=${lockId.substring(0, 8)}... | reason=not found (may have expired)`,
    );
    return false;
  }

  // If transaction was NOT sent, rollback the nonce cache
  if (!transactionSent) {
    const current = nonceState.get(lockInfo.key);
    if (current && current.nextNonce > lockInfo.nonce) {
      const rolledBackNonce = lockInfo.nonce;
      nonceState.set(lockInfo.key, {
        nextNonce: rolledBackNonce,
        updatedAt: Date.now(),
      });
      logger.info(
        `↩️ [NONCE API] Nonce ROLLED BACK | key=${lockInfo.key} | ${current.nextNonce} -> ${rolledBackNonce}`,
      );
    }
  }

  // Release the internal lock
  lockInfo.release();

  // Remove from external locks map
  externalLocks.delete(lockId);

  const emoji = transactionSent ? '✅' : '↩️';
  const action = transactionSent ? 'COMMITTED' : 'ROLLED_BACK';
  logger.info(`🔓 [NONCE API] ${emoji} Lock RELEASED (${action}) | lockId=${lockId.substring(0, 8)}...`);

  return true;
}

/**
 * Get status of all active external locks (for monitoring/debugging).
 */
export function getExternalLocksStatus(): {
  activeLocks: number;
  locks: Array<{
    lockId: string;
    address: string;
    scope: string | undefined;
    nonce: number;
    expiresAt: number;
    isExpired: boolean;
  }>;
} {
  const now = Date.now();
  const locks = Array.from(externalLocks.values()).map((lock) => ({
    lockId: lock.lockId,
    address: lock.address,
    scope: lock.scope,
    nonce: lock.nonce,
    expiresAt: lock.expiresAt,
    isExpired: lock.expiresAt <= now,
  }));

  return {
    activeLocks: locks.filter((l) => !l.isExpired).length,
    locks,
  };
}

/**
 * Cleanup expired external locks.
 * Should be called periodically (e.g., every 10 seconds).
 */
export function cleanupExpiredLocks(): number {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [lockId, lockInfo] of externalLocks.entries()) {
    if (lockInfo.expiresAt <= now) {
      logger.warn(
        `⏰ [NONCE API] Lock EXPIRED | lockId=${lockId.substring(0, 8)}... | ` +
          `wallet=${lockInfo.address.substring(0, 10)}... | nonce=${lockInfo.nonce}`,
      );

      // Release the internal lock
      lockInfo.release();

      // Rollback the nonce since the transaction presumably wasn't sent
      const current = nonceState.get(lockInfo.key);
      if (current && current.nextNonce > lockInfo.nonce) {
        nonceState.set(lockInfo.key, {
          nextNonce: lockInfo.nonce,
          updatedAt: Date.now(),
        });
        logger.info(
          `↩️ [NONCE API] Nonce auto-rollback on expiry | key=${lockInfo.key} | ${current.nextNonce} -> ${lockInfo.nonce}`,
        );
      }

      // Remove from map
      externalLocks.delete(lockId);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    logger.info(`🧹 [NONCE API] Cleanup complete | removed=${cleanedCount} expired lock(s)`);
  }

  return cleanedCount;
}

/**
 * Start the periodic cleanup of expired locks.
 * Call this once when the gateway starts.
 */
let cleanupIntervalId: NodeJS.Timeout | null = null;

export function startExternalLockCleanup(): void {
  if (cleanupIntervalId) {
    logger.warn('[nonce-api] Cleanup already running');
    return;
  }

  cleanupIntervalId = setInterval(() => {
    cleanupExpiredLocks();
  }, CLEANUP_INTERVAL_MS);

  // Don't block process exit
  cleanupIntervalId.unref();

  logger.info(`🚀 [NONCE API] Cleanup daemon started | interval=${CLEANUP_INTERVAL_MS}ms`);
}

/**
 * Stop the periodic cleanup (for testing or shutdown).
 */
export function stopExternalLockCleanup(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
    logger.info('🛑 [NONCE API] Cleanup daemon stopped');
  }
}
