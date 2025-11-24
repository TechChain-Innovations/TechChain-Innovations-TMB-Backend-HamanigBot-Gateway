import { Type } from '@sinclair/typebox';

// Pool list request
export const PoolListRequestSchema = Type.Object({
  connector: Type.String({
    description: 'Connector (raydium, meteora, uniswap)',
    examples: ['raydium', 'meteora', 'uniswap'],
  }),
  network: Type.Optional(
    Type.String({
      description: 'Optional: filter by network (mainnet, mainnet-beta, etc)',
      examples: ['mainnet', 'mainnet-beta', 'base'],
    })
  ),
  type: Type.Optional(
    Type.Union([Type.Literal('amm'), Type.Literal('clmm')], {
      description: 'Optional: filter by pool type',
    })
  ),
  search: Type.Optional(
    Type.String({
      description: 'Optional: search by token symbol or address',
    })
  ),
});

// Pool list response
export const PoolListResponseSchema = Type.Array(
  Type.Object({
    type: Type.Union([Type.Literal('amm'), Type.Literal('clmm')]),
    network: Type.String(),
    baseSymbol: Type.String(),
    quoteSymbol: Type.String(),
    address: Type.String(),
    baseAddress: Type.Optional(Type.String()),
    quoteAddress: Type.Optional(Type.String()),
    baseDecimals: Type.Optional(Type.Number()),
    quoteDecimals: Type.Optional(Type.Number()),
  })
);

// Add pool request
export const PoolAddRequestSchema = Type.Object({
  connector: Type.String({
    description: 'Connector (raydium, meteora, uniswap)',
    examples: ['raydium', 'meteora', 'uniswap'],
  }),
  type: Type.Union([Type.Literal('amm'), Type.Literal('clmm')], {
    description: 'Pool type',
  }),
  network: Type.String({
    description: 'Network name (mainnet, mainnet-beta, etc)',
    examples: ['mainnet', 'mainnet-beta'],
  }),
  baseSymbol: Type.String({
    description: 'Base token symbol',
    examples: ['ETH', 'SOL'],
  }),
  quoteSymbol: Type.String({
    description: 'Quote token symbol',
    examples: ['USDC', 'USDT'],
  }),
  address: Type.String({
    description: 'Pool contract address',
  }),
  baseAddress: Type.Optional(
    Type.String({
      description: 'Optional base token mint/contract address',
    })
  ),
  quoteAddress: Type.Optional(
    Type.String({
      description: 'Optional quote token mint/contract address',
    })
  ),
  baseDecimals: Type.Optional(
    Type.Number({
      description: 'Optional base token decimals',
      minimum: 0,
      maximum: 255,
    })
  ),
  quoteDecimals: Type.Optional(
    Type.Number({
      description: 'Optional quote token decimals',
      minimum: 0,
      maximum: 255,
    })
  ),
});

// Success response
export const PoolSuccessResponseSchema = Type.Object({
  message: Type.String(),
});
