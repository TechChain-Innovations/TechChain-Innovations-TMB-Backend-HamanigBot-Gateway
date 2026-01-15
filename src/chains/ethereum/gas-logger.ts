import { ethers, utils } from 'ethers';

import { logger } from '../../services/logger';
import { Ethereum } from './ethereum';

const color = (code: number, text: string) => `\x1b[${code}m${text}\x1b[0m`;

export const GAS_LOG_TAGS = {
  approve: color(36, '[APPROVE GAS]'),
  swap: color(35, '[SWAP GAS]'),
};

export const normalizeGasOverrides = (gasMax?: number, gasMultiplierPct?: number) => ({
  gasMax: gasMax && gasMax > 0 ? gasMax : undefined,
  gasMultiplierPct: gasMultiplierPct && gasMultiplierPct > 0 ? gasMultiplierPct : undefined,
});

const formatGwei = (value?: ethers.BigNumber | null) => (value ? utils.formatUnits(value, 'gwei') : 'n/a');

export const logGasDetails = async (params: {
  ethereum: Ethereum;
  tag: string;
  stage: string;
  gasOptions: any;
  gasMax?: number;
  gasMultiplierPct?: number;
}) => {
  const { ethereum, tag, stage, gasOptions, gasMax, gasMultiplierPct } = params;
  let baseFeeGwei = 'n/a';
  try {
    const block = await ethereum.provider.getBlock('latest');
    baseFeeGwei = block?.baseFeePerGas ? utils.formatUnits(block.baseFeePerGas, 'gwei') : 'n/a';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`${tag} baseFee fetch failed: ${message}`);
  }

  const overridesLabel =
    gasMax !== undefined || gasMultiplierPct !== undefined
      ? `overrides(gasMax=${gasMax ?? 'n/a'} gwei, gasMultiplierPct=${gasMultiplierPct ?? 'n/a'}%)`
      : 'overrides(auto)';

  if (gasOptions?.type === 2) {
    logger.info(
      `${tag} ${stage} | baseFee=${baseFeeGwei} gwei | maxFee=${formatGwei(
        gasOptions.maxFeePerGas,
      )} gwei | priority=${formatGwei(gasOptions.maxPriorityFeePerGas)} gwei | ${overridesLabel}`,
    );
    return;
  }

  logger.info(`${tag} ${stage} | gasPrice=${formatGwei(gasOptions?.gasPrice)} gwei | ${overridesLabel}`);
};
