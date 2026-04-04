import { embed } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { loadConfig } from "@/config/index.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const EMBEDDING_TIMEOUT_MILLISECONDS = 3000;

let cachedEmbeddingModel: {
  key: string;
  model: ReturnType<ReturnType<typeof createOpenAI>["embedding"]>;
} | null = null;

function resolveEmbeddingModel() {
  const config = loadConfig();
  const cacheKey = `${config.embeddingModel}`;

  if (cachedEmbeddingModel && cachedEmbeddingModel.key === cacheKey) {
    return cachedEmbeddingModel.model;
  }

  const apiKey = config.apiKey;
  if (!apiKey) return null;

  const client = createOpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
  });
  const model = client.embedding(config.embeddingModel);

  cachedEmbeddingModel = { key: cacheKey, model };
  return model;
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const model = resolveEmbeddingModel();
  if (!model) return null;

  try {
    const result = await Promise.race([
      embed({ model, value: text }),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), EMBEDDING_TIMEOUT_MILLISECONDS),
      ),
    ]);
    return result?.embedding ?? null;
  } catch {
    return null;
  }
}

export function encodeEmbeddingToBase64(embedding: number[]): string {
  const buffer = new Float32Array(embedding);
  const bytes = new Uint8Array(buffer.buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset++) {
    binary += String.fromCharCode(bytes[offset]!);
  }
  return btoa(binary);
}
