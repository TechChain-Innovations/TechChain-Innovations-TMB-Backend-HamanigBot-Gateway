import { providers } from 'ethers';

type NonceState = {
  nextNonce: number;
  updatedAt: number;
};

const walletLocks = new Map<string, Promise<void>>();
const nonceState = new Map<string, NonceState>();

const buildKey = (scope: string | undefined, address: string) =>
  `${scope ?? 'default'}:${address.toLowerCase()}`;

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
  const nextNonce = Math.max(pendingNonce, current?.nextNonce ?? 0);

  nonceState.set(key, { nextNonce: nextNonce + 1, updatedAt: Date.now() });
  return nextNonce;
}

export function invalidateNonce(address: string, scope?: string): void {
  const key = buildKey(scope, address);
  nonceState.delete(key);
}
