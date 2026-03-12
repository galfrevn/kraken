import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult } from "@kraken/sdk";
import { resolve } from "node:path";
import { homedir } from "node:os";

const KRAKEN_HOME = resolve(homedir(), ".kraken");
const IS_WINDOWS = process.platform === "win32";

let agentBrowserAvailable = false;

async function runAgentBrowser(args: string[]): Promise<ToolResult> {
  try {
    const spawnedProcess = IS_WINDOWS
      ? Bun.spawn(["cmd", "/c", "agent-browser", ...args], { stdout: "pipe", stderr: "pipe" })
      : Bun.spawn(["agent-browser", ...args], { stdout: "pipe", stderr: "pipe" });

    const exitCode = await spawnedProcess.exited;
    const stdout = await new Response(spawnedProcess.stdout).text();
    const stderr = await new Response(spawnedProcess.stderr).text();

    if (exitCode !== 0) {
      const errorOutput = stderr.trim() || stdout.trim() || `agent-browser exited with code ${exitCode}`;
      return { success: false, output: errorOutput };
    }

    return { success: true, output: stdout.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT") || message.includes("not found") || message.includes("program not foun")) {
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

const browserSetupTool: Tool = {
  definition: {
    name: "browser_setup",
    description:
      "Install and set up agent-browser. Run this ONCE before using any other browser tools. " +
      "Installs agent-browser globally via bun and runs the initial setup (downloads Chromium).",
    parameters: [],
  },
  async execute(): Promise<ToolResult> {
    const steps: string[] = [];

    // Step 1: Install agent-browser globally
    try {
      const installCmd = IS_WINDOWS
        ? ["cmd", "/c", "bun", "i", "-g", "agent-browser"]
        : ["bun", "i", "-g", "agent-browser"];
      const installProcess = Bun.spawn(installCmd, { stdout: "pipe", stderr: "pipe" });
      const installExit = await installProcess.exited;
      const installStdout = await new Response(installProcess.stdout).text();
      const installStderr = await new Response(installProcess.stderr).text();

      if (installExit !== 0) {
        return {
          success: false,
          output: `Failed to install agent-browser: ${installStderr.trim() || installStdout.trim()}`,
        };
      }
      steps.push("installed agent-browser globally");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to install agent-browser: ${message}` };
    }

    // Step 2: Run agent-browser install (downloads Chromium)
    try {
      const setupCmd = IS_WINDOWS
        ? ["cmd", "/c", "agent-browser", "install"]
        : ["agent-browser", "install"];
      const setupProcess = Bun.spawn(setupCmd, { stdout: "pipe", stderr: "pipe" });
      const setupExit = await setupProcess.exited;
      const setupStdout = await new Response(setupProcess.stdout).text();
      const setupStderr = await new Response(setupProcess.stderr).text();

      if (setupExit !== 0) {
        return {
          success: false,
          output: `agent-browser installed but setup failed: ${setupStderr.trim() || setupStdout.trim()}`,
        };
      }
      steps.push("browser setup complete (Chromium downloaded)");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `agent-browser installed but setup failed: ${message}` };
    }

    agentBrowserAvailable = true;
    return { success: true, output: steps.join("\n") };
  },
};

function checkAgentBrowserInstalled(): boolean {
  try {
    const cmd = IS_WINDOWS
      ? ["cmd", "/c", "agent-browser", "--version"]
      : ["agent-browser", "--version"];
    const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export default definePlugin({
  name: "browser",
  version: "0.2.0",
  description: "Browser automation using Vercel's agent-browser CLI. Open pages, take snapshots, click, type, fill forms, and take screenshots.",
  author: "kraken",

  toolDisplayNames: {
    browser_setup: "Setup Browser",
    browser_open: "Open Browser",
    browser_snapshot: "Page Snapshot",
    browser_click: "Click Element",
    browser_type: "Type Text",
    browser_fill: "Fill Input",
    browser_screenshot: "Screenshot",
    browser_close: "Close Browser",
  },

  tools: [
    browserSetupTool,
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
    "FIRST TIME SETUP: If browser tools fail with 'not installed' or 'program not found', call browser_setup first. " +
    "It installs agent-browser and downloads Chromium. You only need to do this once.\n" +
    "Workflow: 1) browser_open to navigate to a URL. 2) browser_snapshot to get the page's accessibility tree with element refs like @e1, @e2. " +
    "3) Use browser_click, browser_type, or browser_fill with those refs to interact. 4) browser_snapshot again to verify the result. " +
    "5) browser_screenshot to capture the page. 6) browser_close when done.\n" +
    "IMPORTANT: Always call browser_snapshot before interacting with elements to get fresh refs. " +
    "Refs change after page navigation or dynamic content updates. " +
    "Use browser_fill to replace input content, browser_type to append text.\n" +
    "Documentation & troubleshooting: https://agent-browser.dev/",

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
