import { providers } from 'ethers';

import { logger } from '../../services/logger';

type NonceState = {
  nextNonce: number;
  updatedAt: number;
};

const walletLocks = new Map<string, Promise<void>>();
const nonceState = new Map<string, NonceState>();

const buildKey = (scope: string | undefined, address: string) =>
  `${scope ?? 'default'}:${address.toLowerCase()}`;

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
};

const MAX_NONCE_GAP = parsePositiveInt(process.env.GATEWAY_MAX_NONCE_GAP, 5);
const MAX_NONCE_CACHE_AGE_MS = parsePositiveInt(process.env.GATEWAY_MAX_NONCE_CACHE_AGE_MS, 120000);

export async function acquireWalletLock(address: string, scope?: string): Promise<() => void> {
  const key = buildKey(scope, address);
  const previous = walletLocks.get(key) ?? Promise.resolve();

  let releaseNext: () => void;
  const next = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });

  walletLocks.set(key, previous.then(() => next));
  await previous;

  return () => {
    releaseNext();
    if (walletLocks.get(key) === next) {
      walletLocks.delete(key);
    }
  };
}

export async function getNextNonce(
  provider: providers.Provider,
  address: string,
  scope?: string
): Promise<number> {
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
