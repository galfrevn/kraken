import { z } from "zod";
import TurndownService from "turndown";
import { defineTool } from "@/tool/tool.ts";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_RESPONSE_SIZE_BYTES = 5 * 1024 * 1024;

const CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const webfetchTool = defineTool({
  id: "webfetch",
  description:
    "Fetch content from a URL and return it in a readable format. Use this to read web pages, documentation, API responses, etc. Supports markdown, text, and raw HTML output formats.",
  parameters: z.object({
    url: z.string().describe("The URL to fetch (must start with http:// or https://)"),
    format: z
      .enum(["markdown", "text", "html"])
      .optional()
      .describe("Output format: markdown (default), text, or html"),
    timeout: z.number().optional().describe("Timeout in seconds (default: 30, max: 120)"),
  }),
  async execute(args, context) {
    if (!args.url.startsWith("http://") && !args.url.startsWith("https://")) {
      return {
        title: args.url,
        content: "Error: URL must start with http:// or https://",
      };
    }

    const format = args.format ?? "markdown";
    const timeoutSeconds = Math.min(args.timeout ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
    const timeoutMilliseconds = timeoutSeconds * 1000;

    const fetchAbortController = new AbortController();
    const timeoutId = setTimeout(() => fetchAbortController.abort(), timeoutMilliseconds);
    const contextAbortHandler = () => fetchAbortController.abort();
    context.abortSignal.addEventListener("abort", contextAbortHandler, { once: true });

    try {
      let response = await fetch(args.url, {
        signal: fetchAbortController.signal,
        headers: {
          "User-Agent": CHROME_USER_AGENT,
          Accept: format === "html" ? "text/html" : "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });

      if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
        response = await fetch(args.url, {
          signal: fetchAbortController.signal,
          headers: { "User-Agent": "kraken" },
          redirect: "follow",
        });
      }

      if (!response.ok) {
        return {
          title: args.url,
          content: `Error: request failed with status ${response.status}`,
        };
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE_BYTES) {
        return {
          title: args.url,
          content: `Error: response too large (${contentLength} bytes, max ${MAX_RESPONSE_SIZE_BYTES})`,
        };
      }

      const responseBuffer = await response.arrayBuffer();
      if (responseBuffer.byteLength > MAX_RESPONSE_SIZE_BYTES) {
        return {
          title: args.url,
          content: `Error: response too large (${responseBuffer.byteLength} bytes, max ${MAX_RESPONSE_SIZE_BYTES})`,
        };
      }

      const bodyText = new TextDecoder().decode(responseBuffer);
      const contentType = response.headers.get("content-type") ?? "";
      const isHtml = contentType.includes("text/html");

      if (!isHtml || format === "html") {
        return {
          title: `Fetched ${args.url}`,
          content: bodyText,
          metadata: { contentType, size: responseBuffer.byteLength },
        };
      }

      if (format === "text") {
        const plainText = extractTextFromHtml(bodyText);
        return {
          title: `Fetched ${args.url}`,
          content: plainText,
          metadata: { contentType, size: responseBuffer.byteLength, format: "text" },
        };
      }

      const markdown = convertHtmlToMarkdown(bodyText);
      return {
        title: `Fetched ${args.url}`,
        content: markdown,
        metadata: { contentType, size: responseBuffer.byteLength, format: "markdown" },
      };
    } catch (fetchError) {
      const errorMessage = fetchError instanceof Error ? fetchError.message : String(fetchError);

      if (errorMessage.includes("abort")) {
        return { title: args.url, content: "Error: request timed out or was aborted" };
      }

      return { title: args.url, content: `Error: ${errorMessage}` };
    } finally {
      clearTimeout(timeoutId);
      context.abortSignal.removeEventListener("abort", contextAbortHandler);
    }
  },
});

function convertHtmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });

  turndown.remove(["script", "style", "meta", "link", "noscript", "iframe", "object", "embed"]);

  return turndown.turndown(html);
}

function extractTextFromHtml(html: string): string {
  const rewriter = new HTMLRewriter();
  let output = "";
  let skipDepth = 0;

  const skipTags = new Set(["script", "style", "noscript", "iframe", "object", "embed"]);

  rewriter.on("*", {
    element(element) {
      const tagName = element.tagName.toLowerCase();
      if (skipTags.has(tagName)) {
        skipDepth++;
        element.onEndTag(() => {
          skipDepth--;
        });
      }
    },
    text(text) {
      if (skipDepth === 0) {
        output += text.text;
      }
    },
  });

  rewriter.transform(new Response(html));

  return output.replace(/\s+/g, " ").trim();
}
