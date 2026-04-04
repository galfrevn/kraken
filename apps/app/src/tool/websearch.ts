import { z } from "zod";
import { defineTool } from "@/tool/tool.ts";

const TAVILY_API_URL = "https://api.tavily.com/search";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
const SEARCH_TIMEOUT_MILLISECONDS = 15000;

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

export const websearchTool = defineTool({
  id: "websearch",
  description:
    "Search the web for real-time information. Returns summarized results with titles, URLs, and snippets. If TAVILY_API_KEY is missing, ask the user for the key and pass it via the 'setup' parameter to persist it. Never set the key via bash — only the 'setup' parameter saves it permanently.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    numResults: z
      .number()
      .optional()
      .describe(
        `Number of results to return (default: ${DEFAULT_NUM_RESULTS}, max: ${MAX_NUM_RESULTS})`,
      ),
    includeAnswer: z
      .boolean()
      .optional()
      .describe("Include an AI-generated answer summary (default: true)"),
    setup: z
      .string()
      .optional()
      .describe(
        "The Tavily API key to persist. Saves the key to ~/.kraken/.env so it is available in future sessions, then performs the search. You MUST use this parameter when the user provides their key — do not use bash or env vars.",
      ),
  }),
  async execute(args, context) {
    if (args.setup) {
      const saved = await saveTavilyKey(args.setup);
      if (!saved.ok) {
        return { title: "Web Search Setup", content: saved.error };
      }
      process.env.TAVILY_API_KEY = args.setup;
    }

    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return {
        title: "Web Search Setup Required",
        content: `STOP: TAVILY_API_KEY is not configured. You MUST ask the user for their Tavily API key before proceeding. Do NOT attempt to use other tools as a workaround.

Tell the user:
- They need a Tavily API key (free at https://app.tavily.com/home, 1000 searches/month)
- Once they have the key, they can paste it in the chat
- You will save it automatically and retry the search

When the user provides the key, call: websearch({ query: "${args.query}", setup: "the-key-here" })`,
      };
    }

    const numResults = Math.min(args.numResults ?? DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
    const includeAnswer = args.includeAnswer ?? true;

    const fetchAbortController = new AbortController();
    const timeoutId = setTimeout(() => fetchAbortController.abort(), SEARCH_TIMEOUT_MILLISECONDS);
    const contextAbortHandler = () => fetchAbortController.abort();
    context.abortSignal.addEventListener("abort", contextAbortHandler, { once: true });

    try {
      const response = await fetch(TAVILY_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: apiKey,
          query: args.query,
          max_results: numResults,
          include_answer: includeAnswer,
          search_depth: "basic",
        }),
        signal: fetchAbortController.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        return {
          title: `Search: ${args.query}`,
          content: `Error: Tavily API returned status ${response.status}${errorBody ? `: ${errorBody}` : ""}`,
        };
      }

      const data = (await response.json()) as TavilyResponse;

      let output = "";

      if (includeAnswer && data.answer) {
        output += `## Answer\n\n${data.answer}\n\n`;
      }

      if (data.results.length === 0) {
        output += "No results found.";
      } else {
        output += "## Results\n\n";
        for (const result of data.results) {
          output += `### ${result.title}\n`;
          output += `${result.url}\n\n`;
          output += `${result.content}\n\n---\n\n`;
        }
      }

      return {
        title: `Search: ${args.query}`,
        content: output.trim(),
        metadata: { resultCount: data.results.length },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes("abort")) {
        return {
          title: `Search: ${args.query}`,
          content: "Error: search request timed out or was aborted",
        };
      }

      return {
        title: `Search: ${args.query}`,
        content: `Error: ${errorMessage}`,
      };
    } finally {
      clearTimeout(timeoutId);
      context.abortSignal.removeEventListener("abort", contextAbortHandler);
    }
  },
});

async function saveTavilyKey(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { getDaemon } = await import("@/daemon/client.ts");
    await getDaemon().secrets.set({ key: "TAVILY_API_KEY", value: key });
    return { ok: true };
  } catch {
    const { appendFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
    const envPath = join(home, ".kraken", ".env");
    try {
      appendFileSync(envPath, `\nTAVILY_API_KEY=${key}\n`);
      return { ok: true };
    } catch (fsError) {
      return {
        ok: false,
        error: `Failed to save key: ${fsError instanceof Error ? fsError.message : String(fsError)}`,
      };
    }
  }
}
