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
// OHLCV Chart
// ---------------------------------------------------------------------------

interface OHLCVData {
  time_open: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const PERIOD_CONFIG: Record<string, { days: number; defaultInterval: string }> = {
  "7d": { days: 7, defaultInterval: "4h" },
  "30d": { days: 30, defaultInterval: "1d" },
  "90d": { days: 90, defaultInterval: "1d" },
  "1y": { days: 365, defaultInterval: "1w" },
};

function aggregateCandles(data: OHLCVData[], interval: string): OHLCVData[] {
  if (interval === "1d" || data.length === 0) return data;

  let groupSize: number;
  if (interval === "1w") groupSize = 7;
  else if (interval === "4h") return data; // API returns daily; can't subdivide
  else return data;

  const result: OHLCVData[] = [];
  for (let i = 0; i < data.length; i += groupSize) {
    const group = data.slice(i, i + groupSize);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    result.push({
      time_open: first.time_open,
      open: first.open,
      high: Math.max(...group.map((g) => g.high)),
      low: Math.min(...group.map((g) => g.low)),
      close: last.close,
      volume: group.reduce((s, g) => s + g.volume, 0),
    });
  }
  return result;
}

function sampleUniform(data: OHLCVData[], maxCandles: number): OHLCVData[] {
  if (data.length <= maxCandles) return data;
  const step = data.length / maxCandles;
  const result: OHLCVData[] = [];
  for (let i = 0; i < maxCandles; i++) {
    result.push(data[Math.floor(i * step)]!);
  }
  return result;
}

function renderCandlestickChart(data: OHLCVData[], symbol: string, period: string, interval: string): string {
  const CHART_HEIGHT = 18;
  const MAX_CANDLES = 60;

  const candles = sampleUniform(data, MAX_CANDLES);
  if (candles.length === 0) return "No data available.";

  const globalHigh = Math.max(...candles.map((c) => c.high));
  const globalLow = Math.min(...candles.map((c) => c.low));
  const range = globalHigh - globalLow || 1;

  const mapToRow = (price: number): number =>
    Math.round(((price - globalLow) / range) * (CHART_HEIGHT - 1));

  // Build grid
  const grid: string[][] = Array.from({ length: CHART_HEIGHT }, () =>
    Array(candles.length).fill(" "),
  );

  for (let col = 0; col < candles.length; col++) {
    const c = candles[col]!;
    const highRow = mapToRow(c.high);
    const lowRow = mapToRow(c.low);
    const openRow = mapToRow(c.open);
    const closeRow = mapToRow(c.close);
    const bodyTop = Math.max(openRow, closeRow);
    const bodyBot = Math.min(openRow, closeRow);
    const isBull = c.close >= c.open;

    for (let row = lowRow; row <= highRow; row++) {
      if (row >= bodyBot && row <= bodyTop) {
        grid[row]![col] = isBull ? "\u2588" : "\u2592";
      } else {
        grid[row]![col] = "\u2502";
      }
    }
  }

  // Y-axis labels (6 ticks)
  const TICK_COUNT = 6;
  const tickRows = Array.from({ length: TICK_COUNT }, (_, i) =>
    Math.round((i / (TICK_COUNT - 1)) * (CHART_HEIGHT - 1)),
  );
  const tickPrices = tickRows.map((r) => globalLow + (r / (CHART_HEIGHT - 1)) * range);

  const maxLabelLen = Math.max(...tickPrices.map((p) => fmtPrice(p).length));

  const lines: string[] = [];
  lines.push(`${symbol.toUpperCase()}/USD \u2014 ${period} (${interval})\n`);

  for (let row = CHART_HEIGHT - 1; row >= 0; row--) {
    const tickIdx = tickRows.indexOf(row);
    const label = tickIdx !== -1
      ? fmtPrice(tickPrices[tickIdx]!).padStart(maxLabelLen)
      : " ".repeat(maxLabelLen);
    lines.push(`${label} \u2502${grid[row]!.join("")}`);
  }

  lines.push(`${" ".repeat(maxLabelLen)} \u2514${"─".repeat(candles.length)}`);

  // Date footer
  const firstCandle = candles[0]!;
  const lastCandle = candles[candles.length - 1]!;
  const firstDate = new Date(firstCandle.time_open).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const lastDate = new Date(lastCandle.time_open).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const dateLinePad = " ".repeat(maxLabelLen + 2);
  lines.push(`${dateLinePad}${firstDate}${" ".repeat(Math.max(1, candles.length - firstDate.length - lastDate.length))}${lastDate}`);

  // Summary
  const changePct = ((lastCandle.close - firstCandle.open) / firstCandle.open) * 100;

  lines.push("");
  lines.push(` Open: ${fmtPrice(firstCandle.open)}  Close: ${fmtPrice(lastCandle.close)}  High: ${fmtPrice(globalHigh)}  Low: ${fmtPrice(globalLow)}`);
  lines.push(` Change: ${fmtPct(changePct)}`);

  return lines.join("\n");
}

const cryptoChartTool: Tool = {
  definition: {
    name: "crypto_chart",
    description: "Display an ASCII candlestick chart for a cryptocurrency's historical price. Shows OHLCV data as a visual chart in the terminal.",
    parameters: [
      {
        name: "symbol",
        type: "string",
        description: "Cryptocurrency symbol (e.g., BTC, ETH, SOL).",
        required: true,
      },
      {
        name: "period",
        type: "string",
        description: "Time period: 7d, 30d, 90d, or 1y. Default: 30d.",
        required: false,
      },
      {
        name: "interval",
        type: "string",
        description: "Candle interval: 4h, 1d, or 1w. Auto-calculated from period if omitted.",
        required: false,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const symbol = (parameters["symbol"] as string)?.toUpperCase();
    if (!symbol) return { success: false, output: "symbol is required" };

    const period = (parameters["period"] as string) || "30d";
    const config = PERIOD_CONFIG[period];
    if (!config) return { success: false, output: `Invalid period '${period}'. Use: 7d, 30d, 90d, 1y.` };

    const interval = (parameters["interval"] as string) || config.defaultInterval;

    try {
      const coins = await getCoinList();
      const coin = coins.find((c) => c.symbol === symbol);
      if (!coin) {
        return { success: false, output: `'${symbol}' not found. Use crypto_list to see available coins.` };
      }

      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - config.days);

      const url = `${COINPAPRIKA_API}/coins/${coin.id}/ohlcv/historical?start=${start.toISOString().split("T")[0]}&end=${end.toISOString().split("T")[0]}`;
      const response = await fetch(url);
      if (!response.ok) return { success: false, output: `Failed to fetch OHLCV data: ${response.status}` };

      const raw = (await response.json()) as OHLCVData[];
      if (!Array.isArray(raw) || raw.length === 0) {
        return { success: false, output: `No historical data available for ${symbol}.` };
      }

      const aggregated = aggregateCandles(raw, interval);
      const chart = renderCandlestickChart(aggregated, symbol, period, interval);

      return { success: true, output: chart };
    } catch (error) {
      return { success: false, output: `Failed to generate chart: ${error instanceof Error ? error.message : error}` };
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
    crypto_chart: "Crypto Chart",
    exchange_rate: "Get Exchange Rates",
    exchange_convert: "Convert Currency",
  },

  tools: [cryptoListTool, cryptoPriceTool, cryptoChartTool, exchangeRateTool, exchangeConvertTool],

  promptExtension:
    "You have cryptocurrency and currency tools from the 'cryptofinance' plugin:\n" +
    "- crypto_list: Top cryptocurrencies by rank\n" +
    "- crypto_price: Current price + market data for any coin (use symbol: BTC, ETH, SOL, etc.)\n" +
    "- crypto_chart: ASCII candlestick chart for historical prices (supports period: 7d, 30d, 90d, 1y)\n" +
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
