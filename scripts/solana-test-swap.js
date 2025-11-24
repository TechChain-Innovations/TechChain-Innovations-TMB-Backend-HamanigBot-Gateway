const axios = require('axios');

// --- Configuration ---
const config = {
  gatewayUrl: 'http://localhost:15888',
  walletAddress: 'YOUR_WALLET_ADDRESS', // <--- ⚠️ Please replace with your wallet address
  network: 'mainnet-beta',
  connector: 'raydium',
  baseToken: 'KITE',
  quoteToken: 'SOL', // Corrected from WSOL to SOL
  poolAddress: 'EtGJNigeWeS5qimtWEqch2RhrQbRR5o5BoPX4txodvvC', // KITE/WSOL pool
  amount: 100000, // ⚠️ Example: sell 100,000 KITE. Adjust based on the price.
  slippagePct: 1,
  confirmationTimeout: 60000, // 60 seconds
  pollingInterval: 2000, // 2 seconds
};

// --- Helper Functions ---
const gatewayApi = axios.create({
  baseURL: config.gatewayUrl,
  headers: {
    'Content-Type': 'application/json',
  },
});

const log = (level, message, data = '') => {
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`, data);
};

// --- Main Script ---
async function runSwap() {
  log('info', 'Starting Solana swap script for Raydium...');
  log('info', 'Configuration:', config);

  if (config.walletAddress === 'YOUR_WALLET_ADDRESS') {
    log('error', 'Please configure your walletAddress in the script before running.');
    return;
  }

  try {
    // For Raydium, we call `execute-swap` directly.
    // It gets a fresh quote and executes in one step.
    log('info', `Executing swap to sell ${config.amount} ${config.baseToken} for ${config.quoteToken}...`);

    const executePayload = {
      network: config.network,
      walletAddress: config.walletAddress,
      baseToken: config.baseToken,
      quoteToken: config.quoteToken,
      amount: config.amount,
      side: 'SELL',
      poolAddress: config.poolAddress,
      slippagePct: config.slippagePct,
    };

    const executeResponse = await gatewayApi.post(`/connectors/${config.connector}/amm/execute-swap`, executePayload);

    const { signature } = executeResponse.data;
    if (!signature) {
      throw new Error('Transaction execution did not return a signature.');
    }
    log('info', `Swap transaction sent with signature: ${signature}`);

    // Poll for transaction confirmation
    log('info', 'Polling for transaction confirmation...');
    const startTime = Date.now();
    let txData = null;

    while (Date.now() - startTime < config.confirmationTimeout) {
      try {
        const pollResponse = await gatewayApi.post('/chains/solana/poll', {
          network: config.network,
          signature: signature,
        });

        const txStatus = pollResponse.data.txStatus;
        log(
          'info',
          `Current transaction status: ${txStatus === 1 ? 'CONFIRMED' : txStatus === -1 ? 'FAILED' : 'PENDING'}`
        );

        if (txStatus === 1) {
          // CONFIRMED
          log('success', 'Transaction confirmed!');
          txData = pollResponse.data;
          break;
        } else if (txStatus === -1) {
          // FAILED
          throw new Error('Transaction failed on-chain.');
        }
      } catch (e) {
        log('warn', `Polling error: ${e.message}. Retrying...`);
      }
      await new Promise((resolve) => setTimeout(resolve, config.pollingInterval));
    }

    if (!txData) {
      throw new Error(`Transaction was not confirmed within ${config.confirmationTimeout / 1000} seconds.`);
    }

    log('success', 'Swap successful!', {
      signature: txData.signature,
      fee: txData.fee,
      block: txData.txBlock,
    });
  } catch (error) {
    log('error', 'Swap failed!');
    if (error.response) {
      log('error', 'API Error:', {
        status: error.response.status,
        data: error.response.data,
      });
    } else {
      log('error', 'Error:', error.message);
    }
  }
}

runSwap();
