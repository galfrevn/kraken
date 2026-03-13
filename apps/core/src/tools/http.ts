import type { Tool, ToolResult } from "@/tools/schema.ts";

const REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const MAX_RESPONSE_CHARACTERS = 16_000;

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal",
  "169.254.169.254",
]);

export const httpRequestTool: Tool = {
  definition: {
    name: "http_request",
    description: "Make an HTTP request to an external API.",
    parameters: [
      {
        name: "url",
        type: "string",
        description: "The full URL to request (e.g. 'https://api.example.com/data')",
        required: true,
      },
      {
        name: "method",
        type: "string",
        description: "HTTP method: GET, POST, PUT, PATCH, DELETE (default: GET)",
        required: false,
      },
      {
        name: "body",
        type: "string",
        description: "Request body (typically JSON string for POST/PUT/PATCH)",
        required: false,
      },
      {
        name: "headers",
        type: "string",
        description: 'JSON object of headers (e.g. \'{"Authorization": "Bearer token"}\')',
        required: false,
      },
    ],
  },

  async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
    const url = parameters["url"] as string;
    const method = ((parameters["method"] as string) || "GET").toUpperCase();
    const body = parameters["body"] as string | undefined;
    const headersRaw = parameters["headers"] as string | undefined;

    if (!url) {
      return { success: false, output: "", error: "url is required" };
    }

    const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
    if (!validMethods.includes(method)) {
      return { success: false, output: "", error: `invalid method: ${method}` };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { success: false, output: "", error: `invalid URL: ${url}` };
    }

    if (BLOCKED_HOSTS.has(parsedUrl.hostname)) {
      return { success: false, output: "", error: `blocked host: ${parsedUrl.hostname}` };
    }

    if (
      parsedUrl.hostname.startsWith("10.") ||
      parsedUrl.hostname.startsWith("192.168.") ||
      parsedUrl.hostname.match(/^172\.(1[6-9]|2\d|3[01])\./)
    ) {
      return { success: false, output: "", error: "private network addresses are blocked" };
    }

    let headers: Record<string, string> = {};
    if (headersRaw) {
      try {
        headers = JSON.parse(headersRaw);
      } catch {
        return { success: false, output: "", error: "headers must be valid JSON object" };
      }
    }

    if (!headers["Content-Type"] && body) {
      headers["Content-Type"] = "application/json";
    }
    if (!headers["User-Agent"]) {
      headers["User-Agent"] = "Kraken/1.0";
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
      });

      let responseBody = await response.text();

      if (responseBody.length > MAX_RESPONSE_CHARACTERS) {
        responseBody = responseBody.slice(0, MAX_RESPONSE_CHARACTERS) + "\n... (truncated)";
      }

      const statusLine = `${response.status} ${response.statusText}`;
      const relevantHeaders = [
        "content-type",
        "content-length",
        "x-request-id",
        "x-ratelimit-remaining",
      ]
        .map((header) => {
          const value = response.headers.get(header);
          return value ? `${header}: ${value}` : null;
        })
        .filter(Boolean)
        .join("\n");

      const output = [
        `${method} ${url} → ${statusLine}`,
        relevantHeaders ? `\n${relevantHeaders}` : "",
        `\n\n${responseBody || "(empty body)"}`,
      ].join("");

      return {
        success: response.ok,
        output,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: `request failed: ${message}` };
    }
  },
};
