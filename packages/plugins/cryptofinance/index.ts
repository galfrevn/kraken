import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult } from "@kraken/sdk";

// ---------------------------------------------------------------------------
// API Endpoints
// ---------------------------------------------------------------------------
const COINPAPRIKA_API_URL = "https://api.coinpaprika.com/v1";
const EXCHANGE_RATE_API_URL = "https://open.er-api.com/v6";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CoinPaprikaCoin {
  id: string;
  name: string;
  symbol: string;
  rank: number;
  is_new: boolean;
  is_active: boolean;
  type: string;
}

interface CoinPaprikaTicker {
  id: string;
  name: string;
  symbol: string;
  rank: number;
  quotes: {
    USD: {
      price: number;
      volume_24h: number;
      market_cap: number;
      percent_change_24h: number;
      percent_change_7d: number;
      percent_change_30d: number;
      ath_price: number;
      ath_date: string;
      percent_from_price_ath: number;
    };
  };
  last_updated: string;
}

interface ExchangeRateResponse {
  result: string;
  base_code: string;
  rates: Record<string, number>;
  time_last_update_utc: string;
  time_next_update_utc: string;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const cryptoListTool: Tool = {
  definition: {
    name: "crypto_list",
    description: "List the top 100 cryptocurrencies with their symbol, name, and rank using CoinPaprika API.",
    parameters: [
      {
        name: "limit",
        type: "number",
        description: "Number of cryptocurrencies to return (max 100). Default: 50.",
        required: false,
      },
    ],
  },
  async execute(parameters) {
    const limit = Math.min(Math.max(1, (parameters["limit"] as number) || 50), 100);

    try {
      const response = await fetch(`${COINPAPRIKA_API_URL}/coins`);
      if (!response.ok) {
        return { success: false, output: `CoinPaprika API error: ${response.status}` };
      }

      const coins = (await response.json()) as CoinPaprikaCoin[];
      const topCoins = coins
        .filter((coin) => coin.is_active)
        .slice(0, limit)
        .map((coin) => ({
          rank: coin.rank,
          symbol: coin.symbol,
          name: coin.name,
          id: coin.id,
        }));

      return {
        success: true,
        output: JSON.stringify(topCoins, null, 2),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to fetch cryptocurrency list: ${message}` };
    }
  },
};

const cryptoPriceTool: Tool = {
  definition: {
    name: "crypto_price",
    description: "Get the current price and market data of a cryptocurrency in USD using CoinPaprika API. Supports BTC, ETH, SOL, and 1000+ coins.",
    parameters: [
      {
        name: "symbol",
        type: "string",
        description: "Cryptocurrency symbol (e.g., BTC, ETH, SOL, ADA, XRP, DOGE).",
        required: true,
      },
    ],
  },
  async execute(parameters) {
    const symbol = (parameters["symbol"] as string)?.toUpperCase();
    if (!symbol) {
      return { success: false, output: "symbol parameter is required" };
    }

    try {
      // First, search for the coin ID by symbol
      const coinsResponse = await fetch(`${COINPAPRIKA_API_URL}/coins`);
      if (!coinsResponse.ok) {
        return { success: false, output: `CoinPaprika API error: ${coinsResponse.status}` };
      }

      const coins = (await coinsResponse.json()) as CoinPaprikaCoin[];
      const coin = coins.find((c) => c.symbol.toUpperCase() === symbol && c.is_active);

      if (!coin) {
        return { success: false, output: `Cryptocurrency with symbol '${symbol}' not found. Use crypto_list to see available coins.` };
      }

      // Get detailed price data
      const tickerResponse = await fetch(`${COINPAPRIKA_API_URL}/tickers/${coin.id}`);
      if (!tickerResponse.ok) {
        return { success: false, output: `Failed to fetch price data for ${symbol}` };
      }

      const ticker = (await tickerResponse.json()) as CoinPaprikaTicker;
      const usd = ticker.quotes.USD;

      const result = {
        symbol: ticker.symbol,
        name: ticker.name,
        rank: ticker.rank,
        price_usd: usd.price,
        volume_24h: usd.volume_24h,
        market_cap: usd.market_cap,
        change_24h: usd.percent_change_24h,
        change_7d: usd.percent_change_7d,
        change_30d: usd.percent_change_30d,
        ath_price: usd.ath_price,
        ath_date: usd.ath_date,
        percent_from_ath: usd.percent_from_price_ath,
        last_updated: ticker.last_updated,
      };

      return {
        success: true,
        output: JSON.stringify(result, null, 2),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to fetch cryptocurrency price: ${message}` };
    }
  },
};

const exchangeRateTool: Tool = {
  definition: {
    name: "exchange_rate",
    description: "Get exchange rates from any base currency to all other 170+ currencies using ExchangeRate-API. Supports USD, EUR, MXN, ARS, GBP, JPY, and all ISO 4217 codes.",
    parameters: [
      {
        name: "base",
        type: "string",
        description: "Base currency code (3-letter ISO 4217, e.g., USD, EUR, MXN, ARS, GBP). Default: USD.",
        required: false,
      },
    ],
  },
  async execute(parameters) {
    const base = ((parameters["base"] as string) || "USD").toUpperCase();

    try {
      const response = await fetch(`${EXCHANGE_RATE_API_URL}/latest/${base}`);
      if (!response.ok) {
        if (response.status === 404) {
          return { success: false, output: `Currency code '${base}' not found. Use 3-letter ISO 4217 codes (USD, EUR, MXN, etc.)` };
        }
        return { success: false, output: `ExchangeRate-API error: ${response.status}` };
      }

      const data = (await response.json()) as ExchangeRateResponse;

      if (data.result !== "success") {
        return { success: false, output: "Failed to fetch exchange rates" };
      }

      const result = {
        base: data.base_code,
        last_update: data.time_last_update_utc,
        next_update: data.time_next_update_utc,
        rates: data.rates,
      };

      return {
        success: true,
        output: JSON.stringify(result, null, 2),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to fetch exchange rates: ${message}` };
    }
  },
};

const exchangeConvertTool: Tool = {
  definition: {
    name: "exchange_convert",
    description: "Convert an amount from one currency to another using ExchangeRate-API. Supports 170+ currencies including USD, EUR, MXN, ARS, GBP, JPY, BRL, CLP, COP, etc.",
    parameters: [
      {
        name: "amount",
        type: "number",
        description: "Amount to convert.",
        required: true,
      },
      {
        name: "from",
        type: "string",
        description: "Source currency code (3-letter ISO 4217, e.g., USD, MXN, EUR).",
        required: true,
      },
      {
        name: "to",
        type: "string",
        description: "Target currency code (3-letter ISO 4217, e.g., EUR, USD, ARS).",
        required: true,
      },
    ],
  },
  async execute(parameters) {
    const amount = parameters["amount"] as number;
    const from = (parameters["from"] as string)?.toUpperCase();
    const to = (parameters["to"] as string)?.toUpperCase();

    if (amount === undefined || amount === null || isNaN(amount)) {
      return { success: false, output: "amount parameter is required and must be a number" };
    }
    if (!from) {
      return { success: false, output: "from parameter is required" };
    }
    if (!to) {
      return { success: false, output: "to parameter is required" };
    }

    try {
      const response = await fetch(`${EXCHANGE_RATE_API_URL}/latest/${from}`);
      if (!response.ok) {
        if (response.status === 404) {
          return { success: false, output: `Source currency '${from}' not found. Use 3-letter ISO 4217 codes.` };
        }
        return { success: false, output: `ExchangeRate-API error: ${response.status}` };
      }

      const data = (await response.json()) as ExchangeRateResponse;

      if (data.result !== "success") {
        return { success: false, output: "Failed to fetch exchange rates" };
      }

      const rate = data.rates[to];
      if (rate === undefined) {
        return { success: false, output: `Target currency '${to}' not found. Use 3-letter ISO 4217 codes.` };
      }

      const converted = amount * rate;

      const result = {
        amount,
        from,
        to,
        rate,
        converted,
        last_update: data.time_last_update_utc,
      };

      return {
        success: true,
        output: JSON.stringify(result, null, 2),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to convert currency: ${message}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default definePlugin({
  name: "cryptofinance",
  version: "0.1.0",
  description: "Cryptocurrency prices and exchange rates using free public APIs without authentication. Supports 170+ fiat currencies and 1000+ cryptocurrencies.",
  author: "kraken",

  toolDisplayNames: {
    crypto_list: "List Cryptocurrencies",
    crypto_price: "Get Crypto Price",
    exchange_rate: "Get Exchange Rates",
    exchange_convert: "Convert Currency",
  },

  tools: [cryptoListTool, cryptoPriceTool, exchangeRateTool, exchangeConvertTool],

  promptExtension:
    "You have access to cryptocurrency and exchange rate tools from the 'cryptofinance' plugin. " +
    "Available tools:\n" +
    "- crypto_list: List top cryptocurrencies with symbols and names\n" +
    "- crypto_price: Get current price of any cryptocurrency (BTC, ETH, SOL, etc.) in USD with market data\n" +
    "- exchange_rate: Get exchange rates from any base currency (USD, EUR, MXN, ARS, etc.) to all other 170+ currencies\n" +
    "- exchange_convert: Convert amounts between any two currencies\n" +
    "\n" +
    "All tools use free public APIs without authentication required. " +
    "For crypto_price, use the cryptocurrency symbol (BTC, ETH, SOL). " +
    "For exchange tools, use 3-letter ISO 4217 currency codes (USD, EUR, MXN, ARS, GBP, JPY, BRL, CLP, COP, etc.).",

  activate: async () => {
    console.log("[cryptofinance] activated - using CoinPaprika and ExchangeRate-API");
  },

  deactivate: async () => {
    console.log("[cryptofinance] deactivated");
  },
});
