import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult } from "@kraken/sdk";

// ---------------------------------------------------------------------------
// API Endpoints
// ---------------------------------------------------------------------------
const COINPAPRIKA_API = "https://api.coinpaprika.com/v1";
const EXCHANGE_RATE_API = "https://open.er-api.com/v6";

// ---------------------------------------------------------------------------
// Coin list cache (avoids fetching 10k+ coins on every price lookup)
// ---------------------------------------------------------------------------
interface CachedCoin {
  id: string;
  name: string;
  symbol: string;
  rank: number;
}

let coinCache: CachedCoin[] = [];
let coinCacheTimestamp = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function getCoinList(): Promise<CachedCoin[]> {
  if (coinCache.length > 0 && Date.now() - coinCacheTimestamp < CACHE_TTL_MS) {
    return coinCache;
  }

  const response = await fetch(`${COINPAPRIKA_API}/coins`);
  if (!response.ok) throw new Error(`CoinPaprika API error: ${response.status}`);

  const coins = (await response.json()) as Array<{
    id: string;
    name: string;
    symbol: string;
    rank: number;
    is_active: boolean;
  }>;

  coinCache = coins
    .filter((c) => c.is_active)
    .map((c) => ({ id: c.id, name: c.name, symbol: c.symbol, rank: c.rank }));
  coinCacheTimestamp = Date.now();
  return coinCache;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function fmtPrice(n: number): string {
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(4)}`;
}

function fmtLarge(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const cryptoListTool: Tool = {
  definition: {
    name: "crypto_list",
    description: "List top cryptocurrencies by market cap rank. Returns symbol, name, and rank.",
    parameters: [
      {
        name: "limit",
        type: "number",
        description: "Number of results (1-100). Default: 20.",
        required: false,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const limit = Math.min(Math.max(1, (parameters["limit"] as number) || 20), 100);

    try {
      const coins = await getCoinList();
      const lines = coins.slice(0, limit).map(
        (c) => `#${c.rank} ${c.symbol} — ${c.name}`,
      );
      return { success: true, output: lines.join("\n") };
    } catch (error) {
      return { success: false, output: `Failed to fetch coin list: ${error instanceof Error ? error.message : error}` };
    }
  },
};

const cryptoPriceTool: Tool = {
  definition: {
    name: "crypto_price",
    description: "Get the current price and market data of a cryptocurrency in USD. Supports BTC, ETH, SOL, and 1000+ coins.",
    parameters: [
      {
        name: "symbol",
        type: "string",
        description: "Cryptocurrency symbol (e.g., BTC, ETH, SOL, ADA, DOGE).",
        required: true,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const symbol = (parameters["symbol"] as string)?.toUpperCase();
    if (!symbol) return { success: false, output: "symbol is required" };

    try {
      const coins = await getCoinList();
      const coin = coins.find((c) => c.symbol === symbol);
      if (!coin) {
        return { success: false, output: `'${symbol}' not found. Use crypto_list to see available coins.` };
      }

      const response = await fetch(`${COINPAPRIKA_API}/tickers/${coin.id}`);
      if (!response.ok) return { success: false, output: `Failed to fetch price for ${symbol}` };

      const ticker = (await response.json()) as {
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
      };

      const usd = ticker.quotes.USD;

      const output = [
        `${ticker.name} (${ticker.symbol}) — Rank #${ticker.rank}`,
        `Price: ${fmtPrice(usd.price)}`,
        `24h: ${fmtPct(usd.percent_change_24h)}  7d: ${fmtPct(usd.percent_change_7d)}  30d: ${fmtPct(usd.percent_change_30d)}`,
        `Market cap: ${fmtLarge(usd.market_cap)}  Volume 24h: ${fmtLarge(usd.volume_24h)}`,
        `ATH: ${fmtPrice(usd.ath_price)} (${fmtPct(usd.percent_from_price_ath)} from ATH)`,
        `Updated: ${ticker.last_updated}`,
      ].join("\n");

      return { success: true, output };
    } catch (error) {
      return { success: false, output: `Failed to fetch price: ${error instanceof Error ? error.message : error}` };
    }
  },
};

const exchangeRateTool: Tool = {
  definition: {
    name: "exchange_rate",
    description: "Get exchange rates for a base currency. Optionally filter to specific target currencies instead of returning all 170+.",
    parameters: [
      {
        name: "base",
        type: "string",
        description: "Base currency (ISO 4217, e.g., USD, EUR, ARS). Default: USD.",
        required: false,
      },
      {
        name: "targets",
        type: "string",
        description: "Comma-separated target currencies to filter (e.g., 'EUR,GBP,ARS'). If omitted, returns top 20 by common usage.",
        required: false,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const base = ((parameters["base"] as string) || "USD").toUpperCase();
    const targetsRaw = parameters["targets"] as string | undefined;

    try {
      const response = await fetch(`${EXCHANGE_RATE_API}/latest/${base}`);
      if (!response.ok) {
        if (response.status === 404) return { success: false, output: `Currency '${base}' not found. Use 3-letter ISO 4217 codes.` };
        return { success: false, output: `ExchangeRate-API error: ${response.status}` };
      }

      const data = (await response.json()) as {
        result: string;
        base_code: string;
        rates: Record<string, number>;
        time_last_update_utc: string;
      };

      if (data.result !== "success") return { success: false, output: "Failed to fetch exchange rates" };

      const DEFAULT_TARGETS = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "MXN", "ARS", "BRL", "CLP", "COP", "INR", "KRW", "SGD", "HKD", "NZD", "SEK", "NOK"];

      let targets: string[];
      if (targetsRaw) {
        targets = targetsRaw.split(",").map((t) => t.trim().toUpperCase());
      } else {
        targets = DEFAULT_TARGETS.filter((t) => t !== base);
      }

      const lines = [`Exchange rates for 1 ${data.base_code}:`];
      for (const t of targets) {
        const rate = data.rates[t];
        if (rate !== undefined) {
          lines.push(`  ${t}: ${rate >= 1 ? rate.toFixed(4) : rate.toPrecision(4)}`);
        }
      }
      lines.push(`Updated: ${data.time_last_update_utc}`);

      return { success: true, output: lines.join("\n") };
    } catch (error) {
      return { success: false, output: `Failed to fetch rates: ${error instanceof Error ? error.message : error}` };
    }
  },
};

const exchangeConvertTool: Tool = {
  definition: {
    name: "exchange_convert",
    description: "Convert an amount between two currencies. Supports 170+ currencies.",
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
        description: "Source currency (ISO 4217, e.g., USD, EUR, MXN).",
        required: true,
      },
      {
        name: "to",
        type: "string",
        description: "Target currency (ISO 4217, e.g., ARS, GBP, JPY).",
        required: true,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const amount = parameters["amount"] as number;
    const from = (parameters["from"] as string)?.toUpperCase();
    const to = (parameters["to"] as string)?.toUpperCase();

    if (amount === undefined || amount === null || isNaN(amount)) return { success: false, output: "amount is required and must be a number" };
    if (!from) return { success: false, output: "from is required" };
    if (!to) return { success: false, output: "to is required" };

    try {
      const response = await fetch(`${EXCHANGE_RATE_API}/latest/${from}`);
      if (!response.ok) {
        if (response.status === 404) return { success: false, output: `Currency '${from}' not found.` };
        return { success: false, output: `ExchangeRate-API error: ${response.status}` };
      }

      const data = (await response.json()) as { result: string; rates: Record<string, number> };
      if (data.result !== "success") return { success: false, output: "Failed to fetch exchange rates" };

      const rate = data.rates[to];
      if (rate === undefined) return { success: false, output: `Target currency '${to}' not found.` };

      const converted = amount * rate;
      const fmtConverted = converted >= 1
        ? converted.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : converted.toPrecision(4);

      return {
        success: true,
        output: `${amount.toLocaleString("en-US")} ${from} = ${fmtConverted} ${to} (rate: ${rate.toPrecision(6)})`,
      };
    } catch (error) {
      return { success: false, output: `Failed to convert: ${error instanceof Error ? error.message : error}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default definePlugin({
  name: "cryptofinance",
  version: "0.2.0",
  description: "Cryptocurrency prices and exchange rates using free public APIs. No API keys needed.",
  author: "kraken",

  toolDisplayNames: {
    crypto_list: "List Cryptocurrencies",
    crypto_price: "Get Crypto Price",
    exchange_rate: "Get Exchange Rates",
    exchange_convert: "Convert Currency",
  },

  tools: [cryptoListTool, cryptoPriceTool, exchangeRateTool, exchangeConvertTool],

  promptExtension:
    "You have cryptocurrency and currency tools from the 'cryptofinance' plugin:\n" +
    "- crypto_list: Top cryptocurrencies by rank\n" +
    "- crypto_price: Current price + market data for any coin (use symbol: BTC, ETH, SOL, etc.)\n" +
    "- exchange_rate: Exchange rates for a base currency (supports targets filter)\n" +
    "- exchange_convert: Convert amounts between currencies\n" +
    "All use free APIs, no keys required. Use 3-letter ISO 4217 codes for fiat currencies.",

  activate: async () => {
    console.log("[cryptofinance] activated");
  },

  deactivate: async () => {
    coinCache = [];
    coinCacheTimestamp = 0;
    console.log("[cryptofinance] deactivated");
  },
});
