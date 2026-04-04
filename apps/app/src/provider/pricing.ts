interface ModelPricing {
  prompt: number; // USD per token
  completion: number; // USD per token
}

let pricingCache: Map<string, ModelPricing> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 3_600_000; // 1 hour

async function fetchPricing(): Promise<Map<string, ModelPricing>> {
  if (pricingCache && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return pricingCache;
  }

  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    console.warn(`[pricing] OpenRouter API returned ${response.status}`);
    return pricingCache ?? new Map();
  }

  const data = (await response.json()) as {
    data: Array<{
      id: string;
      pricing?: { prompt?: string; completion?: string };
    }>;
  };

  const map = new Map<string, ModelPricing>();
  for (const model of data.data) {
    if (model.pricing) {
      map.set(model.id, {
        prompt: parseFloat(model.pricing.prompt ?? "0") || 0,
        completion: parseFloat(model.pricing.completion ?? "0") || 0,
      });
    }
  }

  pricingCache = map;
  cacheTimestamp = Date.now();
  console.error(`[pricing] cached pricing for ${map.size} models`);
  return map;
}

export async function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): Promise<number> {
  try {
    const pricing = await fetchPricing();
    const model = pricing.get(modelId);
    if (!model) return 0;
    return promptTokens * model.prompt + completionTokens * model.completion;
  } catch (error) {
    console.warn(`[pricing] failed to estimate cost: ${error}`);
    return 0;
  }
}
