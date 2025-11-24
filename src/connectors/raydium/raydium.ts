import {
  Raydium as RaydiumSDK,
  ApiV3PoolInfoConcentratedItem,
  ApiV3PoolInfoStandardItem,
  ApiV3PoolInfoStandardItemCpmm,
  PositionInfoLayout,
  CLMM_PROGRAM_ID,
  getPdaPersonalPositionAddress,
  PositionUtils,
  TickUtils,
  ClmmKeys,
  CpmmKeys,
  TxVersion,
  AmmV4Keys,
  AmmV5Keys,
} from '@raydium-io/raydium-sdk-v2';
import { Keypair, PublicKey, VersionedTransaction, Transaction } from '@solana/web3.js';

import { Solana } from '../../chains/solana/solana';
import { SolanaLedger } from '../../chains/solana/solana-ledger';
import { PoolInfo as AmmPoolInfo } from '../../schemas/amm-schema';
import { PoolInfo as ClmmPoolInfo, PositionInfo } from '../../schemas/clmm-schema';
import { logger } from '../../services/logger';

import { RaydiumConfig } from './raydium.config';
import { isValidClmm, isValidAmm, isValidCpmm } from './raydium.utils';

type RaydiumLoadParams = Parameters<(typeof RaydiumSDK)['load']>[0];
type ExtendedRaydiumLoadParams = RaydiumLoadParams & {
  // fetchToken exists in runtime implementation but missing from type definitions
  fetchToken?: () => Promise<unknown[]>;
};

// Internal type that includes poolType for internal use
interface InternalAmmPoolInfo extends AmmPoolInfo {
  poolType?: 'amm' | 'cpmm';
}

type PoolInfoResult = [
  ApiV3PoolInfoStandardItem | ApiV3PoolInfoStandardItemCpmm | ApiV3PoolInfoConcentratedItem,
  AmmV4Keys | AmmV5Keys | CpmmKeys | ClmmKeys | undefined
];

export class Raydium {
  private static _instances: { [name: string]: Raydium };
  public solana: Solana; // Changed to public for use in route handlers
  public raydiumSDK: RaydiumSDK;
  public config: RaydiumConfig.RootConfig;
  public txVersion: TxVersion;
  private owner?: Keypair;

  private constructor() {
    this.config = RaydiumConfig.config;
    this.solana = null;
    this.txVersion = TxVersion.V0;
  }

  private buildLoadParams(options: { owner?: Keypair }): ExtendedRaydiumLoadParams {
    const owner = options.owner;
    const raydiumCluster = this.solana.network == `mainnet-beta` ? 'mainnet' : 'devnet';
    return {
      connection: this.solana.connection,
      cluster: raydiumCluster,
      owner,
      disableFeatureCheck: true,
      blockhashCommitment: 'confirmed',
      fetchToken: () => Promise.resolve([]),
    };
  }

  /** Gets singleton instance of Raydium */
  public static async getInstance(network: string): Promise<Raydium> {
    if (!Raydium._instances) {
      Raydium._instances = {};
    }

    if (!Raydium._instances[network]) {
      const instance = new Raydium();
      await instance.init(network);
      Raydium._instances[network] = instance;
    }

    return Raydium._instances[network];
  }

  /** Initializes Raydium instance */
  private async init(network: string) {
    try {
      this.solana = await Solana.getInstance(network);

      // Skip loading owner wallet - it will be provided in each operation
      // Initialize Raydium SDK with optional owner
      const loadParams = this.buildLoadParams({ owner: this.owner });
      this.raydiumSDK = await RaydiumSDK.load(loadParams);

      logger.info('Raydium initialized with no default wallet');
    } catch (error) {
      logger.error('Raydium initialization failed:', error);
      throw error;
    }
  }

  /** Sets the owner for SDK operations */
  public async setOwner(owner: Keypair | PublicKey): Promise<void> {
    // If it's a PublicKey (hardware wallet), we only set it for read operations
    // For transaction building, we'll use the public key but sign externally
    this.owner = owner as Keypair;
    // For hardware wallets (PublicKey), we need to create a dummy Keypair for SDK initialization
    // The SDK will use this for reading owner's positions, but we'll handle signing separately
    let sdkOwner: Keypair;
    if (owner instanceof PublicKey) {
      // Create a dummy keypair with the same public key for read-only operations
      sdkOwner = Keypair.generate();
      // Override the publicKey getter to return the hardware wallet's public key
      Object.defineProperty(sdkOwner, 'publicKey', {
        get: () => owner,
        configurable: true,
      });
    } else {
      sdkOwner = owner;
    }

    // Reinitialize SDK with the owner
    const loadParams = this.buildLoadParams({ owner: sdkOwner });
    this.raydiumSDK = await RaydiumSDK.load(loadParams);

    logger.info('Raydium SDK reinitialized with owner');
  }

  async getClmmPoolfromRPC(poolAddress: string): Promise<any | null> {
    const poolInfoResponse = await this.raydiumSDK.clmm.getRpcClmmPoolInfo({ poolId: poolAddress });
    return poolInfoResponse;
  }

  async getClmmPoolfromAPI(poolAddress: string): Promise<[ApiV3PoolInfoConcentratedItem, ClmmKeys] | null> {
    const poolInfoResponse = await this.raydiumSDK.api.fetchPoolById({
      ids: poolAddress,
    });
    let poolInfo: ApiV3PoolInfoConcentratedItem;
    let poolKeys: ClmmKeys | undefined;

    if (this.solana.network === 'mainnet-beta') {
      const data = await this.raydiumSDK.api.fetchPoolById({
        ids: poolAddress,
      });
      poolInfo = data[0] as ApiV3PoolInfoConcentratedItem;
    } else {
      const data = await this.raydiumSDK.clmm.getPoolInfoFromRpc(poolAddress);
      poolInfo = data.poolInfo;
      poolKeys = data.poolKeys;
    }
    if (!poolInfoResponse || !poolInfoResponse[0]) {
      logger.error('Pool not found for address: ' + poolAddress);
      return null;
    }
    return [poolInfo, poolKeys];
  }

  async getClmmPoolInfo(poolAddress: string): Promise<ClmmPoolInfo | null> {
    try {
      const rawPool = await this.getClmmPoolfromRPC(poolAddress);

      // Fetch AMM config account data
      let ammConfigData;
      if (rawPool.ammConfig) {
        try {
          const configAccount = await this.solana.connection.getAccountInfo(rawPool.ammConfig);
          if (configAccount) {
            const dataBuffer = configAccount.data;
            ammConfigData = {
              // 47 is the offset for tradeFeeRate in the dataBuffer
              tradeFeeRate: dataBuffer.readUInt32LE(47) / 10000,
            };
          }
        } catch (e) {
          logger.error(`Error fetching CLMM pool info for ${poolAddress}: ${e}`);
        }
      }

      const vaultABalance = (await this.solana.connection.getTokenAccountBalance(rawPool.vaultA)).value.uiAmount;
      const vaultBBalance = (await this.solana.connection.getTokenAccountBalance(rawPool.vaultB)).value.uiAmount;

      const poolInfo: ClmmPoolInfo = {
        address: poolAddress,
        baseTokenAddress: rawPool.mintA.toString(),
        quoteTokenAddress: rawPool.mintB.toString(),
        binStep: Number(rawPool.tickSpacing),
        feePct: ammConfigData?.tradeFeeRate,
        price: Number(rawPool.currentPrice),
        baseTokenAmount: Number(vaultABalance),
        quoteTokenAmount: Number(vaultBBalance),
        activeBinId: Number(rawPool.tickCurrent),
      };
      return poolInfo;
    } catch (error) {
      logger.error(`Error getting CLMM pool info for ${poolAddress}:`, error);
      return null;
    }
  }

  async getClmmPosition(positionAddress: string): Promise<any> {
    const positionNftMint = new PublicKey(positionAddress);
    const positionPubKey = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, positionNftMint).publicKey;
    const positionAccount = await this.solana.connection.getAccountInfo(new PublicKey(positionPubKey));

    if (!positionAccount) {
      logger.warn(`Position account not found: ${positionAddress}`);
      return null;
    }

    const position = PositionInfoLayout.decode(positionAccount.data);
    return position;
  }

  async getPositionInfo(positionAddress: string): Promise<PositionInfo | null> {
    try {
      const position = await this.getClmmPosition(positionAddress);
      const poolIdString = position.poolId.toBase58();
      const [poolInfo, poolKeys] = await this.getClmmPoolfromAPI(poolIdString);

      const epochInfo = await this.solana.connection.getEpochInfo();

      const priceLower = TickUtils.getTickPrice({
        poolInfo,
        tick: position.tickLower,
        baseIn: true,
      });
      const priceUpper = TickUtils.getTickPrice({
        poolInfo,
        tick: position.tickUpper,
        baseIn: true,
      });

      const amounts = PositionUtils.getAmountsFromLiquidity({
        poolInfo: poolInfo,
        ownerPosition: position,
        liquidity: position.liquidity,
        slippage: 0,
        add: false,
        epochInfo,
      });
      const { amountA, amountB } = amounts;

      return {
        address: positionAddress,
        poolAddress: poolIdString,
        baseTokenAddress: poolInfo.mintA.address,
        quoteTokenAddress: poolInfo.mintB.address,
        lowerPrice: Number(priceLower.price),
        upperPrice: Number(priceUpper.price),
        price: Number(poolInfo.price),
        baseTokenAmount: Number(amountA.amount) / 10 ** Number(poolInfo.mintA.decimals),
        quoteTokenAmount: Number(amountB.amount) / 10 ** Number(poolInfo.mintB.decimals),
        baseFeeAmount: Number(position.tokenFeesOwedA?.toString() || '0'),
        quoteFeeAmount: Number(position.tokenFeesOwedB?.toString() || '0'),
        lowerBinId: position.tickLower,
        upperBinId: position.tickUpper,
      };
    } catch (error) {
      logger.error('Error in getPositionInfo:', error);
      return null;
    }
  }

  private async fetchPoolInfoFromRpc(poolAddress: string): Promise<PoolInfoResult | null> {
    // Try standard AMM/Stable pools first
    try {
      const data = await this.raydiumSDK.liquidity.getPoolInfoFromRpc({ poolId: poolAddress });
      if (data?.poolInfo) {
        return [data.poolInfo as ApiV3PoolInfoStandardItem, data.poolKeys as AmmV4Keys | AmmV5Keys];
      }
    } catch (error) {
      logger.debug(`Failed to fetch AMM pool info from RPC for ${poolAddress}: ${(error as Error)?.message}`);
    }

    // Try CPMM pools
    try {
      const data = await this.raydiumSDK.cpmm.getPoolInfoFromRpc(poolAddress);
      if (data?.poolInfo) {
        return [data.poolInfo as ApiV3PoolInfoStandardItemCpmm, data.poolKeys as CpmmKeys];
      }
    } catch (error) {
      logger.debug(`Failed to fetch CPMM pool info from RPC for ${poolAddress}: ${(error as Error)?.message}`);
    }

    // Finally, try CLMM pools so AMM endpoints can detect and reroute
    try {
      const data = await this.raydiumSDK.clmm.getPoolInfoFromRpc(poolAddress);
      if (data?.poolInfo) {
        return [data.poolInfo as ApiV3PoolInfoConcentratedItem, data.poolKeys as ClmmKeys];
      }
    } catch (error) {
      logger.debug(`Failed to fetch CLMM pool info from RPC for ${poolAddress}: ${(error as Error)?.message}`);
    }

    return null;
  }

  // General Pool Methods
  async getPoolfromAPI(poolAddress: string): Promise<PoolInfoResult | null> {
    let poolInfo: PoolInfoResult | null = null;

    if (this.solana.network === 'mainnet-beta') {
      try {
        const data = await this.raydiumSDK.api.fetchPoolById({
          ids: poolAddress,
        });
        const apiInfo = data?.[0];

        if (apiInfo) {
          poolInfo = [
            apiInfo as ApiV3PoolInfoStandardItem | ApiV3PoolInfoStandardItemCpmm | ApiV3PoolInfoConcentratedItem,
            undefined,
          ];
        } else {
          logger.warn(`Raydium API returned no data for pool ${poolAddress}, falling back to RPC`);
        }
      } catch (error) {
        logger.warn(
          `Raydium API fetchPoolById failed for ${poolAddress}, falling back to RPC: ${(error as Error)?.message}`
        );
      }
    }

    if (!poolInfo) {
      poolInfo = await this.fetchPoolInfoFromRpc(poolAddress);
    }

    if (!poolInfo) {
      logger.error('Pool not found for address: ' + poolAddress);
    }

    return poolInfo;
  }

  async getPoolType(poolAddress: string): Promise<string> {
    const poolData = await this.getPoolfromAPI(poolAddress);
    if (!poolData) {
      logger.error(`Unable to determine pool type for ${poolAddress}`);
      return null;
    }
    const [poolInfo] = poolData;
    if (isValidClmm(poolInfo.programId)) {
      return 'clmm';
    } else if (isValidAmm(poolInfo.programId)) {
      return 'amm';
    } else if (isValidCpmm(poolInfo.programId)) {
      return 'cpmm';
    }
    return null;
  }

  // AMM Pool Methods
  async getAmmPoolInfo(poolAddress: string): Promise<InternalAmmPoolInfo | null> {
    try {
      const poolType = await this.getPoolType(poolAddress);
      let poolInfo: InternalAmmPoolInfo;
      if (poolType === 'amm') {
        const rawPool = await this.raydiumSDK.liquidity.getRpcPoolInfos([poolAddress]);

        poolInfo = {
          address: poolAddress,
          baseTokenAddress: rawPool[poolAddress].baseMint.toString(),
          quoteTokenAddress: rawPool[poolAddress].quoteMint.toString(),
          feePct: Number(rawPool[poolAddress].tradeFeeNumerator) / Number(rawPool[poolAddress].tradeFeeDenominator),
          price: Number(rawPool[poolAddress].poolPrice),
          baseTokenAmount: Number(rawPool[poolAddress].mintAAmount) / 10 ** Number(rawPool[poolAddress].baseDecimal),
          quoteTokenAmount: Number(rawPool[poolAddress].mintBAmount) / 10 ** Number(rawPool[poolAddress].quoteDecimal),
          poolType: poolType,
        };
        return poolInfo;
      } else if (poolType === 'cpmm') {
        const rawPool = await this.raydiumSDK.cpmm.getRpcPoolInfos([poolAddress]);

        poolInfo = {
          address: poolAddress,
          baseTokenAddress: rawPool[poolAddress].mintA.toString(),
          quoteTokenAddress: rawPool[poolAddress].mintB.toString(),
          feePct: Number(rawPool[poolAddress].configInfo?.tradeFeeRate || 0),
          price: Number(rawPool[poolAddress].poolPrice),
          baseTokenAmount: Number(rawPool[poolAddress].baseReserve) / 10 ** Number(rawPool[poolAddress].mintDecimalA),
          quoteTokenAmount: Number(rawPool[poolAddress].quoteReserve) / 10 ** Number(rawPool[poolAddress].mintDecimalB),
          poolType: poolType,
        };
        return poolInfo;
      }
    } catch (error) {
      logger.error(`Error getting AMM pool info for ${poolAddress}:`, error);
      return null;
    }
  }

  private getPairKey(baseToken: string, quoteToken: string): string {
    return `${baseToken}-${quoteToken}`;
  }

  /**
   * Execute a transaction using the SDK V2 execute pattern
   * This provides a unified way to handle transaction execution
   *
   * @param executeFunc The execute function returned by SDK methods
   * @returns Transaction ID
   */
  async executeTransaction(executeFunc: () => Promise<{ txId: string }>): Promise<string> {
    try {
      const result = await executeFunc();
      logger.info(`Transaction executed successfully: ${result.txId}`);
      return result.txId;
    } catch (error: any) {
      logger.error('Transaction execution failed:', error);

      // Handle common Solana errors
      if (error.message?.includes('insufficient funds')) {
        throw new Error('Insufficient SOL balance for transaction fees');
      }
      if (error.message?.includes('slippage')) {
        throw new Error('Transaction failed due to slippage. Try increasing slippage tolerance.');
      }
      if (error.message?.includes('blockhash')) {
        throw new Error('Transaction expired. Please try again.');
      }

      throw error;
    }
  }

  async findDefaultPool(_baseToken: string, _quoteToken: string, _routeType: 'amm' | 'clmm'): Promise<string | null> {
    // Pools are now managed separately, return null for dynamic pool discovery
    return null;
  }

  /**
   * Helper function to prepare wallet for transaction operations
   * Returns the wallet/public key and whether it's a hardware wallet
   */
  public async prepareWallet(walletAddress: string): Promise<{
    wallet: Keypair | PublicKey;
    isHardwareWallet: boolean;
  }> {
    const isHardwareWallet = await this.solana.isHardwareWallet(walletAddress);
    const wallet = isHardwareWallet
      ? await this.solana.getPublicKey(walletAddress)
      : await this.solana.getWallet(walletAddress);

    // Set the owner for SDK operations
    await this.setOwner(wallet);

    return { wallet, isHardwareWallet };
  }

  /**
   * Helper function to sign transaction with hardware or regular wallet
   */
  public async signTransaction(
    transaction: VersionedTransaction | Transaction,
    walletAddress: string,
    isHardwareWallet: boolean,
    wallet: Keypair | PublicKey
  ): Promise<VersionedTransaction | Transaction> {
    if (isHardwareWallet) {
      logger.info(`Hardware wallet detected for ${walletAddress}. Signing transaction with Ledger.`);
      const ledger = new SolanaLedger();
      return await ledger.signTransaction(walletAddress, transaction);
    } else {
      // Regular wallet - sign normally
      if (transaction instanceof VersionedTransaction) {
        transaction.sign([wallet as Keypair]);
      } else {
        (transaction as Transaction).sign(wallet as Keypair);
      }
      return transaction;
    }
  }
}
