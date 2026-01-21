import { Type, Static } from '@sinclair/typebox';

import { getEthereumChainConfig, networks as EthereumNetworks } from './ethereum.config';

// Get chain config for defaults
const ethereumChainConfig = getEthereumChainConfig();

// Example values
const EXAMPLE_TX_HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const EXAMPLE_BALANCE_TOKENS = ['ETH', 'USDC', 'WETH'];
const EXAMPLE_ALLOWANCE_TOKENS = ['USDC', 'WETH'];
const EXAMPLE_AMOUNT = '0.01';
const EXAMPLE_SPENDER = 'uniswap/router';

// Network parameter with proper defaults and enum
export const EthereumNetworkParameter = Type.Optional(
  Type.String({
    description: 'The Ethereum network to use',
    default: ethereumChainConfig.defaultNetwork,
    enum: EthereumNetworks,
  }),
);

// Address parameter with proper defaults
export const EthereumAddressParameter = Type.Optional(
  Type.String({
    description: 'Ethereum wallet address',
    default: ethereumChainConfig.defaultWallet,
  }),
);

// Status request schema
export const EthereumStatusRequest = Type.Object({
  network: EthereumNetworkParameter,
});

// Balance request schema
export const EthereumBalanceRequest = Type.Object({
  network: EthereumNetworkParameter,
  address: EthereumAddressParameter,
  tokens: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'A list of token symbols (ETH, USDC, WETH) or token addresses. Both formats are accepted and will be automatically detected. An empty array is treated the same as if the parameter was not provided, returning only non-zero balances (with the exception of ETH).',
      examples: [EXAMPLE_BALANCE_TOKENS],
    }),
  ),
});

// Estimate gas request schema
export const EthereumEstimateGasRequest = Type.Object({
  network: EthereumNetworkParameter,
});

// Poll request schema - map signature to txHash for Ethereum
export const EthereumPollRequest = Type.Object({
  network: EthereumNetworkParameter,
  signature: Type.String({
    description: 'Transaction hash to poll',
    examples: [EXAMPLE_TX_HASH],
  }),
});

// Allowances request schema (multiple tokens)
export const AllowancesRequestSchema = Type.Object({
  network: EthereumNetworkParameter,
  address: EthereumAddressParameter,
  walletAddress: Type.Optional(
    Type.String({
      description: 'Alias for address; if provided, this wallet will be used',
    }),
  ),
  spender: Type.String({
    description: 'Connector name (e.g., uniswap/clmm, uniswap/amm, 0x/router) or contract address',
    examples: [EXAMPLE_SPENDER],
  }),
  tokens: Type.Array(Type.String(), {
    description: 'Array of token symbols or addresses',
    examples: [EXAMPLE_ALLOWANCE_TOKENS],
  }),
});

// Allowances response schema
export const AllowancesResponseSchema = Type.Object({
  spender: Type.String(),
  approvals: Type.Record(Type.String(), Type.String()),
});

// Approve request schema
export const ApproveRequestSchema = Type.Object({
  network: EthereumNetworkParameter,
  address: EthereumAddressParameter,
  walletAddress: Type.Optional(
    Type.String({
      description: 'Alias for address; if provided, this wallet will be used',
    }),
  ),
  spender: Type.String({
    description: 'Connector name (e.g., uniswap/clmm, uniswap/amm, 0x/router) contract address',
    examples: [EXAMPLE_SPENDER],
  }),
  token: Type.String({
    description: 'Token symbol or address',
    examples: [EXAMPLE_ALLOWANCE_TOKENS[0]],
  }),
  amount: Type.Optional(
    Type.String({
      description: 'The amount to approve. If not provided, defaults to maximum amount (unlimited approval).',
      default: '',
    }),
  ),
  gasMax: Type.Optional(
    Type.Number({
      description: 'Maximum gas price in Gwei (EVM). If omitted or 0, gateway auto gas is used.',
      minimum: 0,
    }),
  ),
  gasMultiplierPct: Type.Optional(
    Type.Number({
      description: 'Gas multiplier percentage (e.g., 40 means +40% to base fee).',
      minimum: 0,
    }),
  ),
});

// Approve response schema
export const ApproveResponseSchema = Type.Object({
  signature: Type.String(),
  status: Type.Number({ description: 'TransactionStatus enum value' }),

  // Only included when status = CONFIRMED
  data: Type.Optional(
    Type.Object({
      tokenAddress: Type.String(),
      spender: Type.String(),
      amount: Type.String(),
      nonce: Type.Number(),
      fee: Type.String(),
    }),
  ),
});

// Wrap request schema
export const WrapRequestSchema = Type.Object({
  network: EthereumNetworkParameter,
  address: EthereumAddressParameter,
  walletAddress: Type.Optional(
    Type.String({
      description: 'Alias for address; if provided, this wallet will be used',
    }),
  ),
  amount: Type.String({
    description: 'The amount of native token to wrap (e.g., ETH, BNB, AVAX)',
    examples: [EXAMPLE_AMOUNT],
  }),
});

// Wrap response schema
export const WrapResponseSchema = Type.Object({
  signature: Type.String(),
  status: Type.Number({ description: 'TransactionStatus enum value' }),

  // Only included when status = CONFIRMED
  data: Type.Optional(
    Type.Object({
      nonce: Type.Number(),
      fee: Type.String(),
      amount: Type.String(),
      wrappedAddress: Type.String(),
      nativeToken: Type.String(),
      wrappedToken: Type.String(),
    }),
  ),
});

// Unwrap request schema
export const UnwrapRequestSchema = Type.Object({
  network: EthereumNetworkParameter,
  address: EthereumAddressParameter,
  walletAddress: Type.Optional(
    Type.String({
      description: 'Alias for address; if provided, this wallet will be used',
    }),
  ),
  amount: Type.String({
    description: 'The amount of wrapped token to unwrap (e.g., WETH, WBNB, WAVAX)',
    examples: [EXAMPLE_AMOUNT],
  }),
});

// Unwrap response schema
export const UnwrapResponseSchema = Type.Object({
  signature: Type.String(),
  status: Type.Number({ description: 'TransactionStatus enum value' }),

  // Only included when status = CONFIRMED
  data: Type.Optional(
    Type.Object({
      nonce: Type.Number(),
      fee: Type.String(),
      amount: Type.String(),
      wrappedAddress: Type.String(),
      nativeToken: Type.String(),
      wrappedToken: Type.String(),
    }),
  ),
});

// ============================================================================
// Nonce API Schemas (for wallet-service coordination)
// ============================================================================

// Nonce acquire request schema
export const NonceAcquireRequestSchema = Type.Object({
  network: EthereumNetworkParameter,
  walletAddress: Type.String({
    description: 'Wallet address to acquire nonce for',
  }),
  ttlMs: Type.Optional(
    Type.Number({
      description: 'Time-to-live for the lock in milliseconds (default: 60000)',
      default: 60000,
      minimum: 1000,
      maximum: 300000, // Max 5 minutes
    }),
  ),
});

// Nonce acquire response schema
export const NonceAcquireResponseSchema = Type.Object({
  lockId: Type.String({
    description: 'Unique lock identifier - must be used to release the lock',
  }),
  nonce: Type.Number({
    description: 'The nonce to use for the transaction',
  }),
  expiresAt: Type.Number({
    description: 'Unix timestamp (ms) when the lock will automatically expire',
  }),
});

// Nonce release request schema
export const NonceReleaseRequestSchema = Type.Object({
  network: EthereumNetworkParameter,
  walletAddress: Type.String({
    description: 'Wallet address the lock was acquired for',
  }),
  lockId: Type.String({
    description: 'Lock identifier from the acquire response',
  }),
  transactionSent: Type.Boolean({
    description: 'Whether the transaction was actually sent to blockchain. If false, nonce is rolled back.',
  }),
});

// Nonce release response schema
export const NonceReleaseResponseSchema = Type.Object({
  success: Type.Boolean({
    description: 'Whether the lock was successfully released',
  }),
  message: Type.Optional(
    Type.String({
      description: 'Additional information about the release',
    }),
  ),
});

// Nonce invalidate request schema
export const NonceInvalidateRequestSchema = Type.Object({
  network: EthereumNetworkParameter,
  walletAddress: Type.String({
    description: 'Wallet address to invalidate nonce cache for',
  }),
});

// Nonce invalidate response schema
export const NonceInvalidateResponseSchema = Type.Object({
  success: Type.Boolean(),
});

// Nonce status response schema
export const NonceStatusResponseSchema = Type.Object({
  activeLocks: Type.Number({
    description: 'Number of currently active (non-expired) locks',
  }),
  locks: Type.Array(
    Type.Object({
      lockId: Type.String(),
      address: Type.String(),
      scope: Type.Optional(Type.String()),
      nonce: Type.Number(),
      expiresAt: Type.Number(),
      isExpired: Type.Boolean(),
    }),
  ),
});

// Type exports
export type AllowancesRequestType = Static<typeof AllowancesRequestSchema>;
export type AllowancesResponseType = Static<typeof AllowancesResponseSchema>;
export type ApproveRequestType = Static<typeof ApproveRequestSchema>;
export type ApproveResponseType = Static<typeof ApproveResponseSchema>;
export type WrapRequestType = Static<typeof WrapRequestSchema>;
export type WrapResponseType = Static<typeof WrapResponseSchema>;
export type UnwrapRequestType = Static<typeof UnwrapRequestSchema>;
export type UnwrapResponseType = Static<typeof UnwrapResponseSchema>;

// Nonce API types
export type NonceAcquireRequestType = Static<typeof NonceAcquireRequestSchema>;
export type NonceAcquireResponseType = Static<typeof NonceAcquireResponseSchema>;
export type NonceReleaseRequestType = Static<typeof NonceReleaseRequestSchema>;
export type NonceReleaseResponseType = Static<typeof NonceReleaseResponseSchema>;
export type NonceInvalidateRequestType = Static<typeof NonceInvalidateRequestSchema>;
export type NonceInvalidateResponseType = Static<typeof NonceInvalidateResponseSchema>;
export type NonceStatusResponseType = Static<typeof NonceStatusResponseSchema>;
