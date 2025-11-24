const axios = require('axios');

// --- Configuration ---
const config = {
  gatewayUrl: 'http://localhost:15888',
  network: 'mainnet-beta',
  // DEX connector. Raydium is used based on your data.
  connector: 'raydium',
  baseToken: 'KITE',
  quoteToken: 'SOL', // Corrected from WSOL to SOL
  // The specific liquidity pool for KITE/WSOL.
  poolAddress: 'EtGJNigeWeS5qimtWEqch2RhrQbRR5o5BoPX4txodvvC',
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
async function checkPrice() {
  log('info', 'Starting Solana price check script...');
  log('info', 'Configuration:', config);

  try {
    // Using a larger amount for a more meaningful price quote, as KITE's value is low.
    const amountToSell = 100000;

    log(
      'info',
      `Getting price for ${config.baseToken}/${config.quoteToken} by quoting a sale of ${amountToSell} ${config.baseToken}...`
    );

    const quoteParams = {
      network: config.network,
      baseToken: config.baseToken,
      quoteToken: config.quoteToken,
      amount: amountToSell,
      side: 'SELL',
      poolAddress: config.poolAddress,
    };

    // Using the AMM endpoint, which can route to CLMM if needed.
    const quoteResponse = await gatewayApi.get(`/connectors/${config.connector}/amm/quote-swap`, {
      params: quoteParams,
    });
    const { price, amountOut } = quoteResponse.data;

    log('info', '----------------------------------------');
    log('success', `Price for ${config.baseToken}/${config.quoteToken}`);
    log('info', `1 ${config.baseToken} is approximately ${price.toExponential(6)} ${config.quoteToken}`);
    log(
      'info',
      `Selling ${amountToSell} ${config.baseToken} would get you approximately ${amountOut} ${config.quoteToken}`
    );
    log('info', '----------------------------------------');
  } catch (error) {
    log('error', 'Failed to get price!');
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

checkPrice();
