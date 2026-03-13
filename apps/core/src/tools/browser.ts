import type { Tool, ToolResult } from "@/tools/schema.ts";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const FETCH_TIMEOUT_MILLISECONDS = 15_000;
const MAX_RESULTS = 10;

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: { results?: BraveSearchResult[] };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function resolveBraveApiKey(): string | undefined {
  return Bun.env["BRAVE_SEARCH_API_KEY"] ?? Bun.env["KRAKEN_BRAVE_SEARCH_API_KEY"] ?? undefined;
}

async function searchWithBrave(query: string, count: number): Promise<SearchResult[]> {
  const apiKey = resolveBraveApiKey();
  if (!apiKey) throw new Error("no_brave_key");

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brave Search returned ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as BraveSearchResponse;
  const webResults = payload.web?.results ?? [];

  return webResults.slice(0, count).map((result) => ({
    title: result.title,
    url: result.url,
    snippet: result.description,
  }));
}

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchWithDuckDuckGo(query: string, count: number): Promise<SearchResult[]> {
  const formBody = new URLSearchParams({ q: query });

  const response = await fetch(DUCKDUCKGO_HTML_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; Kraken/1.0)",
    },
    body: formBody.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo returned ${response.status}`);
  }

  const html = await response.text();
  const results: SearchResult[] = [];

  const resultBlockPattern =
    /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;

  while ((match = resultBlockPattern.exec(html)) !== null && results.length < count) {
    const rawUrl = match[1] ?? "";
    const title = extractTextFromHtml(match[2] ?? "");
    const snippet = extractTextFromHtml(match[3] ?? "");

    let url = rawUrl;
    const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
    if (uddgMatch?.[1]) {
      url = decodeURIComponent(uddgMatch[1]);
    }

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  if (results.length === 0) {
    const simpleLinkPattern = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((match = simpleLinkPattern.exec(html)) !== null && results.length < count) {
      const rawUrl = match[1] ?? "";
      const title = extractTextFromHtml(match[2] ?? "");

      let url = rawUrl;
      const uddgMatch = rawUrl.match(/uddg=([^&]+)/);
      if (uddgMatch?.[1]) {
        url = decodeURIComponent(uddgMatch[1]);
      }

      if (title && url && !url.startsWith("/")) {
        results.push({ title, url, snippet: "" });
      }
    }
  }

  return results;
}

function formatSearchResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return `no results found for "${query}"`;
  }

  const lines = results.map((result, index) => {
    const parts = [`${index + 1}. ${result.title}`, `   ${result.url}`];
    if (result.snippet) {
      parts.push(`   ${result.snippet}`);
    }
    return parts.join("\n");
  });

  return `${results.length} results for "${query}":\n\n${lines.join("\n\n")}`;
}

export const webSearchTool: Tool = {
  definition: {
    name: "web_search",
    description: "Search the web for information.",
    parameters: [
      {
        name: "query",
        type: "string",
        description: "The search query (e.g. 'bun sqlite documentation', 'react 19 new features')",
        required: true,
      },
      {
        name: "count",
        type: "number",
        description: "Number of results to return (default: 5, max: 10)",
        required: false,
      },
    ],
  },

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const query = parameters["query"] as string;
    if (!query) {
      return { success: false, output: "", error: "query is required" };
    }

    const count = Math.min(Math.max(Number(parameters["count"]) || 5, 1), MAX_RESULTS);

    try {
      const results = await searchWithBrave(query, count);
      return { success: true, output: formatSearchResults(results, query) };
    } catch (braveError) {
      const isMissingKey = braveError instanceof Error && braveError.message === "no_brave_key";

      if (!isMissingKey) {
        const message = braveError instanceof Error ? braveError.message : String(braveError);
        return { success: false, output: "", error: `brave search failed: ${message}` };
      }
    }

    try {
      const results = await searchWithDuckDuckGo(query, count);
      return { success: true, output: formatSearchResults(results, query) };
    } catch (ddgError) {
      const message = ddgError instanceof Error ? ddgError.message : String(ddgError);
      return { success: false, output: "", error: `web search failed: ${message}` };
    }
  },
};

export const fetchUrlTool: Tool = {
  definition: {
    name: "fetch_url",
    description: "Fetch a URL and extract readable text.",
    parameters: [
      {
        name: "url",
        type: "string",
        description: "The full URL to fetch (e.g. 'https://docs.bun.sh/api/sqlite')",
        required: true,
      },
    ],
  },

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const url = parameters["url"] as string;
    if (!url) {
      return { success: false, output: "", error: "url is required" };
    }

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Kraken/1.0)",
          Accept: "text/html,application/json,text/plain",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
      });

      if (!response.ok) {
        return { success: false, output: "", error: `fetch returned ${response.status}` };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const body = await response.text();

      if (contentType.includes("application/json")) {
        const truncated = body.length > 8000 ? body.slice(0, 8000) + "\n... (truncated)" : body;
        return { success: true, output: truncated };
      }

      const readable = extractReadableContent(body);
      const truncated =
        readable.length > 8000 ? readable.slice(0, 8000) + "\n... (truncated)" : readable;

      return { success: true, output: truncated || "(empty page)" };
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
      return { success: false, output: "", error: `fetch failed: ${message}` };
    }
  },
};

function extractReadableContent(html: string): string {
  let content = html;

  content = content.replace(/<script[\s\S]*?<\/script>/gi, "");
  content = content.replace(/<style[\s\S]*?<\/style>/gi, "");
  content = content.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  content = content.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  content = content.replace(/<header[\s\S]*?<\/header>/gi, "");
  content = content.replace(/<!--[\s\S]*?-->/g, "");

  content = content.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => {
    const prefix = "#".repeat(Number(level));
    return `\n${prefix} ${extractTextFromHtml(text)}\n`;
  });

  content = content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, text) => {
    return `- ${extractTextFromHtml(text)}`;
  });

  content = content.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    return `\n\`\`\`\n${extractTextFromHtml(code)}\n\`\`\`\n`;
  });

  content = content.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
    return `\`${extractTextFromHtml(code)}\``;
  });

  content = content.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const linkText = extractTextFromHtml(text);
    return linkText ? `[${linkText}](${href})` : "";
  });

  content = content.replace(/<br\s*\/?>/gi, "\n");
  content = content.replace(/<\/p>/gi, "\n\n");
  content = content.replace(/<\/div>/gi, "\n");
  content = content.replace(/<\/tr>/gi, "\n");
  content = content.replace(/<[^>]*>/g, "");

  content = content
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  content = content.replace(/\n{3,}/g, "\n\n");
  content = content.replace(/[ \t]+/g, " ");

  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}
