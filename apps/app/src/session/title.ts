import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV1 } from "ai";
import { loadConfig } from "@/config/index.ts";
import { Session } from "@/session/index.ts";

const MAX_TITLE_LENGTH = 97;
const TITLE_GENERATION_MAX_TOKENS = 80;
const TITLE_GENERATION_TEMPERATURE = 0.5;

const TITLE_LOG_PATH = join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".kraken",
  "title.log",
);

function logTitle(message: string): void {
  try {
    appendFileSync(TITLE_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

const TITLE_SYSTEM_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

Generate a brief title that would help the user find this conversation later.

Rules:
- CRITICAL: The title MUST be in the SAME language as the user message. If the user writes in Spanish, the title MUST be in Spanish. If in English, in English. If in French, in French. Never translate.
- Title must be a single line, 50 characters max
- No explanations, just the title
- Keep technical terms, numbers, filenames exact
- Never use tools or assume tech stack
- Never respond to questions, just generate a title

Examples:
"debug 500 errors in production" → Debugging production 500 errors
"refactor user service" → Refactoring user service
"why is app.js failing" → app.js failure investigation
"how do I connect postgres to my API" → Postgres API connection
"hola" → Saludo inicial
"quiero refactorizar el servicio de usuarios" → Refactorizar servicio de usuarios
"comment configurer postgres" → Configuration de Postgres`;

const smallModelsByProvider: Record<string, string[]> = {
  openrouter: ["google/gemini-2.5-flash-lite", "openai/gpt-oss-120b", "openai/gpt-5-nano"],
  anthropic: ["claude-3-5-haiku-latest"],
  openai: ["gpt-4o-mini"],
};

function resolveSmallModelCandidates(): LanguageModelV1[] {
  const config = loadConfig();
  if (!config.provider) return [];
  const modelIds = smallModelsByProvider[config.provider];
  if (!modelIds || modelIds.length === 0) return [];

  const apiKey =
    config.apiKey ??
    process.env[`KRAKEN_${config.provider.toUpperCase()}_API_KEY`] ??
    process.env[`${config.provider.toUpperCase()}_API_KEY`] ??
    "";

  if (config.provider === "openrouter") {
    const client = createOpenRouter({ apiKey });
    return modelIds.map((modelId) => client.chat(modelId));
  }
  if (config.provider === "anthropic") {
    const client = createAnthropic({ apiKey });
    return modelIds.map((modelId) => client(modelId));
  }
  if (config.provider === "openai") {
    const client = createOpenAI({ apiKey });
    return modelIds.map((modelId) => client(modelId));
  }
  return [];
}

export async function generateSessionTitle(sessionId: string, userMessage: string): Promise<void> {
  try {
    const existingSession = Session.get(sessionId);
    if (!existingSession) {
      logTitle("session not found: " + sessionId);
      return;
    }
    if (existingSession.title && existingSession.title.length > 0) {
      logTitle("title already exists");
      return;
    }

    const config = loadConfig();
    logTitle(`provider: ${config.provider}, resolving small model candidates...`);

    const candidates = resolveSmallModelCandidates();
    if (candidates.length === 0) {
      logTitle("no small model candidates found");
      return;
    }

    let generatedTitle = "";
    for (const candidate of candidates) {
      try {
        logTitle(`trying model candidate...`);
        const result = await generateText({
          model: candidate,
          system: TITLE_SYSTEM_PROMPT,
          prompt: `Generate a title for this conversation:\n${userMessage}`,
          temperature: TITLE_GENERATION_TEMPERATURE,
          maxTokens: TITLE_GENERATION_MAX_TOKENS,
        });
        logTitle("raw result: " + result.text);
        const parsed =
          result.text
            .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0) ?? "";
        if (parsed) {
          generatedTitle = parsed;
          break;
        }
        logTitle("candidate returned empty text, trying next...");
      } catch (candidateError) {
        logTitle("candidate failed: " + String(candidateError));
      }
    }

    if (generatedTitle.length > MAX_TITLE_LENGTH) {
      generatedTitle = generatedTitle.slice(0, MAX_TITLE_LENGTH) + "...";
    }

    if (!generatedTitle) {
      generatedTitle = userMessage.length > 50 ? userMessage.slice(0, 47) + "..." : userMessage;
    }

    logTitle("setting title: " + generatedTitle);
    Session.updateTitle(sessionId, generatedTitle);
  } catch (titleGenerationError) {
    logTitle("ERROR: " + String(titleGenerationError));
    const fallback = userMessage.length > 50 ? userMessage.slice(0, 47) + "..." : userMessage;
    Session.updateTitle(sessionId, fallback);
  }
}
