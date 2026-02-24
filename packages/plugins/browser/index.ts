import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult } from "@kraken/sdk";
import { resolve } from "node:path";
import { homedir } from "node:os";

const KRAKEN_HOME = resolve(homedir(), ".kraken");

let agentBrowserAvailable = false;

async function runAgentBrowser(args: string[]): Promise<ToolResult> {
  try {
    const process = Bun.spawn(["agent-browser", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();
    const stderr = await new Response(process.stderr).text();

    if (exitCode !== 0) {
      const errorOutput = stderr.trim() || stdout.trim() || `agent-browser exited with code ${exitCode}`;
      return { success: false, output: errorOutput };
    }

    return { success: true, output: stdout.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT") || message.includes("not found")) {
      return {
        success: false,
        output: "agent-browser is not installed. Install it with: npm install -g agent-browser",
      };
    }
    return { success: false, output: `Failed to run agent-browser: ${message}` };
  }
}

const browserOpenTool: Tool = {
  definition: {
    name: "browser_open",
    description: "Open a URL in the browser. This starts or reuses a browser session.",
    parameters: [
      { name: "url", type: "string", description: "The URL to navigate to.", required: true },
    ],
  },
  async execute(parameters) {
    const url = parameters["url"] as string;
    if (!url) return { success: false, output: "url parameter is required" };
    return runAgentBrowser(["open", url]);
  },
};

const browserSnapshotTool: Tool = {
  definition: {
    name: "browser_snapshot",
    description:
      "Get an accessibility tree snapshot of the current page. Returns elements with refs (e.g. @e1, @e2) " +
      "that can be used with browser_click, browser_type, and browser_fill. " +
      "Use the -i flag variant to only show interactive elements.",
    parameters: [
      {
        name: "interactive_only",
        type: "boolean",
        description: "If true, only return interactive elements (buttons, links, inputs). Default: true.",
        required: false,
      },
    ],
  },
  async execute(parameters) {
    const interactiveOnly = parameters["interactive_only"] !== false;
    const args = interactiveOnly ? ["snapshot", "-i"] : ["snapshot"];
    return runAgentBrowser(args);
  },
};

const browserClickTool: Tool = {
  definition: {
    name: "browser_click",
    description: "Click an element on the page identified by its ref from a snapshot (e.g. @e1).",
    parameters: [
      { name: "ref", type: "string", description: "Element ref from snapshot (e.g. '@e1').", required: true },
    ],
  },
  async execute(parameters) {
    const ref = parameters["ref"] as string;
    if (!ref) return { success: false, output: "ref parameter is required" };
    return runAgentBrowser(["click", ref]);
  },
};

const browserTypeTool: Tool = {
  definition: {
    name: "browser_type",
    description: "Type text into an element (appends to existing content). Use browser_fill to replace content instead.",
    parameters: [
      { name: "ref", type: "string", description: "Element ref from snapshot (e.g. '@e3').", required: true },
      { name: "text", type: "string", description: "Text to type into the element.", required: true },
    ],
  },
  async execute(parameters) {
    const ref = parameters["ref"] as string;
    const text = parameters["text"] as string;
    if (!ref || !text) return { success: false, output: "ref and text parameters are required" };
    return runAgentBrowser(["type", ref, text]);
  },
};

const browserFillTool: Tool = {
  definition: {
    name: "browser_fill",
    description: "Clear an element and fill it with new text. Unlike browser_type, this replaces existing content.",
    parameters: [
      { name: "ref", type: "string", description: "Element ref from snapshot (e.g. '@e3').", required: true },
      { name: "text", type: "string", description: "Text to fill into the element.", required: true },
    ],
  },
  async execute(parameters) {
    const ref = parameters["ref"] as string;
    const text = parameters["text"] as string;
    if (!ref || !text) return { success: false, output: "ref and text parameters are required" };
    return runAgentBrowser(["fill", ref, text]);
  },
};

const browserScreenshotTool: Tool = {
  definition: {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page and save it to disk.",
    parameters: [
      {
        name: "filename",
        type: "string",
        description: "Filename for the screenshot (saved in ~/.kraken/screenshots/). Default: auto-generated.",
        required: false,
      },
      {
        name: "full_page",
        type: "boolean",
        description: "Capture the full scrollable page instead of just the viewport. Default: false.",
        required: false,
      },
    ],
  },
  async execute(parameters) {
    const filename = (parameters["filename"] as string) ?? `screenshot-${Date.now()}.png`;
    const fullPage = parameters["full_page"] === true;

    const screenshotsDirectory = resolve(KRAKEN_HOME, "screenshots");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(screenshotsDirectory, { recursive: true });

    const outputPath = resolve(screenshotsDirectory, filename);
    const args = fullPage ? ["screenshot", "--full", outputPath] : ["screenshot", outputPath];
    const result = await runAgentBrowser(args);

    if (result.success) {
      return { success: true, output: `Screenshot saved to ${outputPath}` };
    }
    return result;
  },
};

const browserCloseTool: Tool = {
  definition: {
    name: "browser_close",
    description: "Close the browser session.",
    parameters: [],
  },
  async execute() {
    return runAgentBrowser(["close"]);
  },
};

function checkAgentBrowserInstalled(): boolean {
  try {
    const result = Bun.spawnSync({ cmd: ["agent-browser", "--version"], stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export default definePlugin({
  name: "browser",
  version: "0.1.0",
  description: "Browser automation using Vercel's agent-browser CLI. Open pages, take snapshots, click, type, fill forms, and take screenshots.",
  author: "kraken",

  toolDisplayNames: {
    browser_open: "Open Browser",
    browser_snapshot: "Page Snapshot",
    browser_click: "Click Element",
    browser_type: "Type Text",
    browser_fill: "Fill Input",
    browser_screenshot: "Screenshot",
    browser_close: "Close Browser",
  },

  tools: [
    browserOpenTool,
    browserSnapshotTool,
    browserClickTool,
    browserTypeTool,
    browserFillTool,
    browserScreenshotTool,
    browserCloseTool,
  ],

  promptExtension:
    "You have browser automation tools from the 'browser' plugin (powered by agent-browser). " +
    "Workflow: 1) browser_open to navigate to a URL. 2) browser_snapshot to get the page's accessibility tree with element refs like @e1, @e2. " +
    "3) Use browser_click, browser_type, or browser_fill with those refs to interact. 4) browser_snapshot again to verify the result. " +
    "5) browser_screenshot to capture the page. 6) browser_close when done.\n" +
    "IMPORTANT: Always call browser_snapshot before interacting with elements to get fresh refs. " +
    "Refs change after page navigation or dynamic content updates. " +
    "Use browser_fill to replace input content, browser_type to append text.",

  activate: async () => {
    agentBrowserAvailable = checkAgentBrowserInstalled();
    if (!agentBrowserAvailable) {
      console.log("[browser] WARNING: agent-browser CLI is not installed. Install it with: npm install -g agent-browser");
    } else {
      console.log("[browser] activated (agent-browser found)");
    }
  },

  deactivate: async () => {
    try {
      await runAgentBrowser(["close"]);
    } catch {
      /* browser may already be closed */
    }
    console.log("[browser] deactivated");
  },
});
