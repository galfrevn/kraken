import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult } from "@kraken/sdk";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";

const KRAKEN_HOME = resolve(homedir(), ".kraken");
const IS_WINDOWS = process.platform === "win32";

// ---------------------------------------------------------------------------
// Playwright session — lazy-loaded to avoid import errors when not installed
// ---------------------------------------------------------------------------

let pw: typeof import("playwright") | null = null;
let browserInstance: import("playwright").Browser | null = null;
let currentPage: import("playwright").Page | null = null;

async function loadPlaywright(): Promise<typeof import("playwright")> {
  if (pw) return pw;
  try {
    pw = await import("playwright");
    return pw;
  } catch {
    throw new Error(
      "playwright is not installed. Use the browser_setup tool to install it.",
    );
  }
}

async function ensurePage(): Promise<import("playwright").Page> {
  if (currentPage && !currentPage.isClosed()) return currentPage;

  const playwright = await loadPlaywright();
  if (!browserInstance?.isConnected()) {
    browserInstance = await playwright.chromium.launch({ headless: true });
  }
  currentPage = await browserInstance.newPage();
  return currentPage;
}

// ---------------------------------------------------------------------------
// Accessibility snapshot — builds a ref map like agent-browser
// ---------------------------------------------------------------------------

interface SnapshotEntry {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  level?: number;
  children?: SnapshotEntry[];
}

let refMap: Map<string, import("playwright").Locator> = new Map();
let refCounter = 0;

function isInteractive(role: string): boolean {
  const interactiveRoles = new Set([
    "button", "link", "textbox", "checkbox", "radio", "combobox",
    "menuitem", "menuitemcheckbox", "menuitemradio", "option",
    "searchbox", "slider", "spinbutton", "switch", "tab", "treeitem",
  ]);
  return interactiveRoles.has(role);
}

type AXNode = {
  role: string;
  name: string;
  value?: string;
  description?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  level?: number;
  children?: AXNode[];
};

async function buildSnapshot(
  page: import("playwright").Page,
  interactiveOnly: boolean,
): Promise<string> {
  refMap.clear();
  refCounter = 0;

  const tree = await page.accessibility.snapshot() as AXNode | null;
  if (!tree) return "(empty page — no accessibility tree)";

  const lines: string[] = [];

  function walk(node: AXNode, depth: number): void {
    const role = node.role ?? "none";
    if (role === "none" || role === "generic" || role === "GenericContainer") {
      for (const child of node.children ?? []) {
        walk(child, depth);
      }
      return;
    }

    if (interactiveOnly && !isInteractive(role)) {
      for (const child of node.children ?? []) {
        walk(child, depth);
      }
      return;
    }

    refCounter++;
    const ref = `@e${refCounter}`;
    const indent = "  ".repeat(depth);
    const name = node.name ? ` "${node.name}"` : "";
    const value = node.value ? ` value="${node.value}"` : "";
    const extras: string[] = [];
    if (node.checked !== undefined) extras.push(`checked=${node.checked}`);
    if (node.disabled) extras.push("disabled");
    if (node.expanded !== undefined) extras.push(`expanded=${node.expanded}`);
    if (node.level !== undefined) extras.push(`level=${node.level}`);
    const extrasStr = extras.length > 0 ? ` [${extras.join(", ")}]` : "";

    lines.push(`${indent}${ref} ${role}${name}${value}${extrasStr}`);

    // Store a locator for this element by role + name
    if (node.name) {
      refMap.set(ref, page.getByRole(role as any, { name: node.name, exact: true }));
    }

    for (const child of node.children ?? []) {
      walk(child, depth + 1);
    }
  }

  walk(tree, 0);
  return lines.length > 0 ? lines.join("\n") : "(no matching elements found)";
}

function getLocator(ref: string): import("playwright").Locator | undefined {
  const normalized = ref.startsWith("@") ? ref : `@${ref}`;
  return refMap.get(normalized);
}

// ---------------------------------------------------------------------------
// Shell helper for setup commands
// ---------------------------------------------------------------------------

async function runShell(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = IS_WINDOWS ? ["cmd", "/c", ...args] : args;
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const browserSetupTool: Tool = {
  definition: {
    name: "browser_setup",
    description:
      "Install Playwright and download Chromium. Run this ONCE before using any other browser tools. " +
      "This installs the playwright npm package and downloads a compatible Chromium binary.",
    parameters: [],
  },
  async execute(): Promise<ToolResult> {
    const steps: string[] = [];

    // Step 1: Install playwright
    try {
      const result = await runShell(["bun", "i", "-g", "playwright"]);
      if (result.exitCode !== 0) {
        return { success: false, output: `Failed to install playwright: ${result.stderr || result.stdout}` };
      }
      steps.push("installed playwright globally");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to install playwright: ${message}` };
    }

    // Step 2: Download Chromium via playwright
    try {
      const result = await runShell(["bunx", "playwright", "install", "chromium"]);
      if (result.exitCode !== 0) {
        return { success: false, output: `playwright installed but Chromium download failed: ${result.stderr || result.stdout}` };
      }
      steps.push("Chromium downloaded");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `playwright installed but Chromium download failed: ${message}` };
    }

    // Reset module cache so next import picks up the install
    pw = null;

    return { success: true, output: steps.join("\n") };
  },
};

const browserOpenTool: Tool = {
  definition: {
    name: "browser_open",
    description: "Open a URL in the browser. Starts a new Chromium session or reuses the existing one.",
    parameters: [
      { name: "url", type: "string", description: "The URL to navigate to.", required: true },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const url = parameters["url"] as string;
    if (!url) return { success: false, output: "url parameter is required" };

    try {
      const page = await ensurePage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const title = await page.title();
      return { success: true, output: `Navigated to ${url}\nTitle: ${title}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: message };
    }
  },
};

const browserSnapshotTool: Tool = {
  definition: {
    name: "browser_snapshot",
    description:
      "Get an accessibility tree snapshot of the current page. Returns elements with refs (e.g. @e1, @e2) " +
      "that can be used with browser_click, browser_type, and browser_fill.",
    parameters: [
      {
        name: "interactive_only",
        type: "boolean",
        description: "If true, only return interactive elements (buttons, links, inputs). Default: true.",
        required: false,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const interactiveOnly = parameters["interactive_only"] !== false;

    try {
      const page = await ensurePage();
      const snapshot = await buildSnapshot(page, interactiveOnly);
      return { success: true, output: snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: message };
    }
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
  async execute(parameters): Promise<ToolResult> {
    const ref = parameters["ref"] as string;
    if (!ref) return { success: false, output: "ref parameter is required" };

    try {
      const locator = getLocator(ref);
      if (!locator) return { success: false, output: `ref ${ref} not found. Run browser_snapshot first.` };

      await locator.click({ timeout: 10_000 });

      // Wait for potential navigation/updates
      const page = await ensurePage();
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      const title = await page.title();
      return { success: true, output: `Clicked ${ref}\nPage title: ${title}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: message };
    }
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
  async execute(parameters): Promise<ToolResult> {
    const ref = parameters["ref"] as string;
    const text = parameters["text"] as string;
    if (!ref || !text) return { success: false, output: "ref and text parameters are required" };

    try {
      const locator = getLocator(ref);
      if (!locator) return { success: false, output: `ref ${ref} not found. Run browser_snapshot first.` };

      await locator.pressSequentially(text, { delay: 30 });
      return { success: true, output: `Typed "${text}" into ${ref}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: message };
    }
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
  async execute(parameters): Promise<ToolResult> {
    const ref = parameters["ref"] as string;
    const text = parameters["text"] as string;
    if (!ref || !text) return { success: false, output: "ref and text parameters are required" };

    try {
      const locator = getLocator(ref);
      if (!locator) return { success: false, output: `ref ${ref} not found. Run browser_snapshot first.` };

      await locator.fill(text);
      return { success: true, output: `Filled ${ref} with "${text}"` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: message };
    }
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
  async execute(parameters): Promise<ToolResult> {
    const filename = (parameters["filename"] as string) ?? `screenshot-${Date.now()}.png`;
    const fullPage = parameters["full_page"] === true;

    try {
      const page = await ensurePage();
      const screenshotsDir = resolve(KRAKEN_HOME, "screenshots");
      mkdirSync(screenshotsDir, { recursive: true });

      const outputPath = resolve(screenshotsDir, filename);
      await page.screenshot({ path: outputPath, fullPage });
      return { success: true, output: `Screenshot saved to ${outputPath}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: message };
    }
  },
};

const browserCloseTool: Tool = {
  definition: {
    name: "browser_close",
    description: "Close the browser session and free resources.",
    parameters: [],
  },
  async execute(): Promise<ToolResult> {
    try {
      if (currentPage && !currentPage.isClosed()) {
        await currentPage.close();
      }
      if (browserInstance?.isConnected()) {
        await browserInstance.close();
      }
      currentPage = null;
      browserInstance = null;
      refMap.clear();
      return { success: true, output: "Browser closed." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: message };
    }
  },
};

const browserEvalTool: Tool = {
  definition: {
    name: "browser_eval",
    description:
      "Execute JavaScript in the current page context and return the result. " +
      "Useful for extracting data, checking element states, or interacting with the page programmatically.",
    parameters: [
      {
        name: "expression",
        type: "string",
        description: "JavaScript expression to evaluate in the page (e.g. 'document.title', 'document.querySelectorAll(\"a\").length').",
        required: true,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const expression = parameters["expression"] as string;
    if (!expression) return { success: false, output: "expression parameter is required" };

    try {
      const page = await ensurePage();
      const result = await page.evaluate(expression);
      const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { success: true, output: output ?? "(undefined)" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: message };
    }
  },
};

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

function checkPlaywrightAvailable(): boolean {
  try {
    require.resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

export default definePlugin({
  name: "playwright",
  version: "0.1.0",
  description:
    "Native browser automation using Playwright. Open pages, take accessibility snapshots, " +
    "click, type, fill forms, take screenshots, and evaluate JavaScript — no external CLI needed.",
  author: "kraken",

  toolDisplayNames: {
    browser_setup: "Setup Browser",
    browser_open: "Open Browser",
    browser_snapshot: "Page Snapshot",
    browser_click: "Click Element",
    browser_type: "Type Text",
    browser_fill: "Fill Input",
    browser_screenshot: "Screenshot",
    browser_eval: "Evaluate JS",
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
    browserEvalTool,
    browserCloseTool,
  ],

  promptExtension:
    "You have native browser automation tools from the 'playwright' plugin.\n" +
    "FIRST TIME SETUP: If browser tools fail with 'playwright is not installed', call browser_setup first. " +
    "It installs Playwright and downloads Chromium. You only need to do this once.\n" +
    "Workflow: 1) browser_open to navigate to a URL. 2) browser_snapshot to get the page's accessibility tree with element refs like @e1, @e2. " +
    "3) Use browser_click, browser_type, or browser_fill with those refs to interact. 4) browser_snapshot again to verify the result. " +
    "5) browser_screenshot to capture the page. 6) browser_eval to run JS in the page. 7) browser_close when done.\n" +
    "IMPORTANT: Always call browser_snapshot before interacting with elements to get fresh refs. " +
    "Refs change after page navigation or dynamic content updates. " +
    "Use browser_fill to replace input content, browser_type to append text.\n" +
    "Documentation: https://playwright.dev/docs/api/class-page",

  activate: async () => {
    const available = checkPlaywrightAvailable();
    if (!available) {
      console.log("[playwright] WARNING: playwright is not installed. Use browser_setup tool to install it.");
    } else {
      console.log("[playwright] activated");
    }
  },

  deactivate: async () => {
    try {
      if (currentPage && !currentPage.isClosed()) await currentPage.close();
      if (browserInstance?.isConnected()) await browserInstance.close();
    } catch {
      /* may already be closed */
    }
    currentPage = null;
    browserInstance = null;
    refMap.clear();
    pw = null;
    console.log("[playwright] deactivated");
  },
});
