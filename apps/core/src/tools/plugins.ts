import { resolve } from "node:path";
import { homedir } from "node:os";
import { rmSync, existsSync } from "node:fs";
import type { Tool, ToolResult } from "@/tools/schema.ts";
import type { ToolRegistry } from "@/tools/registry.ts";
import type { PluginRegistry } from "@/plugins/registry.ts";
import type { PluginContext } from "@kraken/sdk";
import { fetchRegistry, installPluginFromRegistry, isPluginInstalled } from "@/plugins/installer.ts";

export interface PluginManagerDependencies {
  pluginRegistry: PluginRegistry;
  toolRegistry: ToolRegistry;
  workingDirectory: string;
  baseContext: Omit<PluginContext, "config">;
  onToolDisplayNamesChanged?: (names: Record<string, string>) => void;
}

export function createPluginManagerTool(dependencies: PluginManagerDependencies): Tool {
  const { pluginRegistry, toolRegistry, workingDirectory, baseContext, onToolDisplayNamesChanged } =
    dependencies;

  return {
    definition: {
      name: "plugin_manager",
      description:
        "Manage plugins. Actions:\n" +
        "  - list: Show all installed plugins with their status and tools\n" +
        "  - store: Browse available plugins from the official registry\n" +
        "  - inspect <name>: Detailed info about a specific installed plugin\n" +
        "  - install_from_store <name>: Download and install a plugin from the registry\n" +
        "  - install <path>: Load a plugin from a local path at runtime\n" +
        "  - uninstall <name>: Delete a plugin from disk and unload it [destructive]\n" +
        "  - disable <name>: Deactivate a plugin for the current session [destructive]\n" +
        "  - enable <name>: Re-activate a disabled plugin\n" +
        "  - remove <name>: Unload a plugin from the current session (keeps files) [destructive]\n\n" +
        "For destructive actions (disable, remove, uninstall), set confirmed=true after user confirmation.",
      parameters: [
        {
          name: "action",
          type: "string" as const,
          description:
            "The action to perform: 'list', 'store', 'inspect', 'install_from_store', 'install', 'uninstall', 'disable', 'enable', 'remove'.",
          required: true,
        },
        {
          name: "plugin_name",
          type: "string" as const,
          description:
            "The plugin name or path (required for inspect, install, disable, enable, remove).",
          required: false,
        },
        {
          name: "confirmed",
          type: "boolean" as const,
          description: "Set to true to confirm destructive actions (disable, remove).",
          required: false,
        },
      ],
    },

    async execute(parameters: Record<string, unknown>): Promise<ToolResult> {
      const action = ((parameters["action"] as string) ?? "").toLowerCase().trim();
      const pluginName = ((parameters["plugin_name"] as string) ?? "").trim();
      const confirmed = (parameters["confirmed"] as boolean) ?? false;

      switch (action) {
        case "list":
          return handleList(pluginRegistry);
        case "store":
        case "browse":
          return handleStore(pluginRegistry);
        case "inspect":
          return handleInspect(pluginRegistry, pluginName);
        case "install_from_store":
          return handleInstallFromStore(
            pluginRegistry,
            toolRegistry,
            pluginName,
            workingDirectory,
            baseContext,
            onToolDisplayNamesChanged,
          );
        case "install":
          return handleInstall(
            pluginRegistry,
            toolRegistry,
            pluginName,
            workingDirectory,
            baseContext,
            onToolDisplayNamesChanged,
          );
        case "uninstall":
          return handleUninstall(pluginRegistry, pluginName, confirmed);
        case "disable":
          return handleDisable(pluginRegistry, pluginName, confirmed);
        case "enable":
          return handleEnable(pluginRegistry, pluginName);
        case "remove":
          return handleRemove(pluginRegistry, pluginName, confirmed);
        default:
          return {
            success: false,
            output: "",
            error: `unknown action "${action}". Available: list, store, inspect, install_from_store, install, uninstall, disable, enable, remove`,
          };
      }
    },
  };
}

function handleList(registry: PluginRegistry): ToolResult {
  const plugins = registry.getLoadedPlugins();

  if (plugins.length === 0) {
    return { success: true, output: "no plugins installed" };
  }

  const lines = plugins.map((entry) => {
    const status = entry.enabled ? "enabled" : "disabled";
    const toolCount = entry.plugin.tools?.length ?? 0;
    const hookCount = entry.plugin.hooks ? Object.keys(entry.plugin.hooks).length : 0;
    const hasPrompt = entry.plugin.promptExtension ? "yes" : "no";

    const tools =
      toolCount > 0 ? (entry.plugin.tools ?? []).map((t) => t.definition.name).join(", ") : "none";

    const desc = entry.plugin.description ? `\n  ${entry.plugin.description}` : "";

    return (
      `- ${entry.plugin.name} v${entry.plugin.version} [${status}] (${entry.source})${desc}\n` +
      `  tools: ${tools}\n` +
      `  hooks: ${hookCount} | prompt extension: ${hasPrompt}`
    );
  });

  return {
    success: true,
    output: `${plugins.length} plugin(s) installed:\n\n${lines.join("\n\n")}`,
  };
}

function handleInspect(registry: PluginRegistry, name: string): ToolResult {
  if (!name) {
    return { success: false, output: "", error: "plugin_name is required for inspect" };
  }

  const entry = registry.getPluginByName(name);
  if (!entry) {
    return { success: false, output: "", error: `plugin "${name}" not found` };
  }

  const plugin = entry.plugin;
  const sections: string[] = [`name: ${plugin.name}`, `version: ${plugin.version}`];

  if (plugin.description) {
    sections.push(`description: ${plugin.description}`);
  }

  if (plugin.author) {
    sections.push(`author: ${plugin.author}`);
  }

  sections.push(`status: ${entry.enabled ? "enabled" : "disabled"}`);
  sections.push(`source: ${entry.source} (${entry.entry})`);

  const configKeys = Object.keys(entry.pluginContext.config);
  if (configKeys.length > 0) {
    const configLines = configKeys.map(
      (key) => `  ${key}: ${JSON.stringify(entry.pluginContext.config[key])}`,
    );
    sections.push(`config:\n${configLines.join("\n")}`);
  }

  if (plugin.tools && plugin.tools.length > 0) {
    const toolDetails = plugin.tools.map((t) => {
      const params = t.definition.parameters.map((p) => `${p.name}: ${p.type}`).join(", ");
      return `  - ${t.definition.name}(${params}): ${t.definition.description}`;
    });
    sections.push(`tools:\n${toolDetails.join("\n")}`);
  } else {
    sections.push("tools: none");
  }

  if (plugin.hooks) {
    const hookNames = Object.keys(plugin.hooks).filter(
      (key) => typeof (plugin.hooks as Record<string, unknown>)[key] === "function",
    );
    sections.push(`hooks: ${hookNames.length > 0 ? hookNames.join(", ") : "none"}`);
  } else {
    sections.push("hooks: none");
  }

  if (plugin.promptExtension) {
    sections.push(`prompt extension: "${plugin.promptExtension}"`);
  }

  return { success: true, output: sections.join("\n") };
}

async function handleInstall(
  registry: PluginRegistry,
  toolReg: ToolRegistry,
  pluginPath: string,
  workingDirectory: string,
  baseContext: Omit<PluginContext, "config">,
  onToolDisplayNamesChanged?: (names: Record<string, string>) => void,
): Promise<ToolResult> {
  if (!pluginPath) {
    return { success: false, output: "", error: "plugin_name (path) is required for install" };
  }

  const result = await registry.installPlugin(pluginPath, workingDirectory, baseContext);

  if (!result.success) {
    return { success: false, output: "", error: result.error };
  }

  const plugin = result.plugin;
  if (plugin.tools) {
    for (const tool of plugin.tools) {
      try {
        toolReg.register(tool);
      } catch {
        /* tool name collision - skip */
      }
    }
  }

  if (onToolDisplayNamesChanged) {
    onToolDisplayNamesChanged(registry.getToolDisplayNames());
  }

  const toolNames = plugin.tools?.map((t) => t.definition.name).join(", ") ?? "none";
  return {
    success: true,
    output:
      `plugin "${plugin.name}" v${plugin.version} installed and activated.\n` +
      `tools registered: ${toolNames}\n` +
      "The new tools are available immediately in the current conversation.",
  };
}

async function handleDisable(
  registry: PluginRegistry,
  name: string,
  confirmed: boolean,
): Promise<ToolResult> {
  if (!name) {
    return { success: false, output: "", error: "plugin_name is required for disable" };
  }

  const entry = registry.getPluginByName(name);
  if (!entry) {
    return { success: false, output: "", error: `plugin "${name}" not found` };
  }

  if (!entry.enabled) {
    return { success: false, output: "", error: `plugin "${name}" is already disabled` };
  }

  if (!confirmed) {
    return {
      success: false,
      output: "",
      error:
        `disabling "${name}" will deactivate its tools and hooks for this session. ` +
        "Ask the user for confirmation, then call again with confirmed=true.",
    };
  }

  const disabled = await registry.disablePlugin(name);
  return disabled
    ? { success: true, output: `plugin "${name}" has been disabled` }
    : { success: false, output: "", error: `failed to disable plugin "${name}"` };
}

async function handleEnable(registry: PluginRegistry, name: string): Promise<ToolResult> {
  if (!name) {
    return { success: false, output: "", error: "plugin_name is required for enable" };
  }

  const entry = registry.getPluginByName(name);
  if (!entry) {
    return { success: false, output: "", error: `plugin "${name}" not found` };
  }

  if (entry.enabled) {
    return { success: false, output: "", error: `plugin "${name}" is already enabled` };
  }

  const enabled = await registry.enablePlugin(name);
  return enabled
    ? { success: true, output: `plugin "${name}" has been re-enabled` }
    : { success: false, output: "", error: `failed to enable plugin "${name}"` };
}

async function handleRemove(
  registry: PluginRegistry,
  name: string,
  confirmed: boolean,
): Promise<ToolResult> {
  if (!name) {
    return { success: false, output: "", error: "plugin_name is required for remove" };
  }

  const entry = registry.getPluginByName(name);
  if (!entry) {
    return { success: false, output: "", error: `plugin "${name}" not found` };
  }

  if (!confirmed) {
    return {
      success: false,
      output: "",
      error:
        `removing "${name}" will fully unload it from the current session. ` +
        "To make this permanent, also remove it from kraken.yml. " +
        "Ask the user for confirmation, then call again with confirmed=true.",
    };
  }

  const removed = await registry.removePlugin(name);
  return removed
    ? { success: true, output: `plugin "${name}" has been removed from this session` }
    : { success: false, output: "", error: `failed to remove plugin "${name}"` };
}

async function handleStore(localRegistry: PluginRegistry): Promise<ToolResult> {
  try {
    const registry = await fetchRegistry();
    const loadedPlugins = localRegistry.getLoadedPlugins();
    const loadedNames = new Set(loadedPlugins.map((p) => p.plugin.name));

    const lines = registry.plugins.map((entry) => {
      const installed = isPluginInstalled(entry.name);
      const loaded = loadedNames.has(entry.name);
      let status = "available";
      if (loaded) status = "loaded";
      else if (installed) status = "installed (not loaded)";

      const toolsList = entry.tools.join(", ");
      const requiresList = entry.requires.length > 0 ? `\n  requires: ${entry.requires.join(", ")}` : "";

      return (
        `- ${entry.name} v${entry.version} [${status}]\n` +
        `  ${entry.description}\n` +
        `  by ${entry.author} | tools: ${toolsList}${requiresList}`
      );
    });

    return {
      success: true,
      output:
        `Plugin Store — ${registry.plugins.length} plugin(s) available:\n\n${lines.join("\n\n")}\n\n` +
        'To install a plugin, use action "install_from_store" with the plugin name.',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, output: "", error: `Failed to fetch plugin store: ${message}` };
  }
}

async function handleInstallFromStore(
  registry: PluginRegistry,
  toolReg: ToolRegistry,
  pluginName: string,
  workingDirectory: string,
  baseContext: Omit<PluginContext, "config">,
  onToolDisplayNamesChanged?: (names: Record<string, string>) => void,
): Promise<ToolResult> {
  if (!pluginName) {
    return { success: false, output: "", error: "plugin_name is required for install_from_store" };
  }

  const existing = registry.getPluginByName(pluginName);
  if (existing) {
    return { success: false, output: "", error: `plugin "${pluginName}" is already loaded` };
  }

  const installResult = await installPluginFromRegistry(pluginName);
  if (!installResult.success) {
    return { success: false, output: "", error: installResult.error ?? "Installation failed" };
  }

  const loadResult = await registry.installPlugin(
    installResult.installPath,
    workingDirectory,
    baseContext,
  );

  if (!loadResult.success) {
    return {
      success: false,
      output: "",
      error: `Downloaded to ${installResult.installPath} but failed to load: ${loadResult.error}`,
    };
  }

  const plugin = loadResult.plugin;
  if (plugin.tools) {
    for (const tool of plugin.tools) {
      try {
        toolReg.register(tool);
      } catch {
        /* tool name collision */
      }
    }
  }

  if (onToolDisplayNamesChanged) {
    onToolDisplayNamesChanged(registry.getToolDisplayNames());
  }

  const toolNames = plugin.tools?.map((t) => t.definition.name).join(", ") ?? "none";
  const warningLines = installResult.warnings.length > 0
    ? "\n\nWarnings:\n" + installResult.warnings.map((w) => `  - ${w}`).join("\n")
    : "";

  return {
    success: true,
    output:
      `Plugin "${plugin.name}" v${plugin.version} downloaded, installed, and activated.\n` +
      `Tools registered: ${toolNames}\n` +
      `Installed to: ${installResult.installPath}` +
      warningLines,
  };
}

async function handleUninstall(
  registry: PluginRegistry,
  name: string,
  confirmed: boolean,
): Promise<ToolResult> {
  if (!name) {
    return { success: false, output: "", error: "plugin_name is required for uninstall" };
  }

  if (!confirmed) {
    return {
      success: false,
      output: "",
      error:
        `uninstalling "${name}" will delete it from disk and unload it. This is permanent. ` +
        "Ask the user for confirmation, then call again with confirmed=true.",
    };
  }

  const loadedEntry = registry.getPluginByName(name);
  if (loadedEntry) {
    await registry.removePlugin(name);
  }

  const pluginDirectory = resolve(homedir(), ".kraken", "plugins", name);
  if (!existsSync(pluginDirectory)) {
    return { success: false, output: "", error: `plugin "${name}" is not installed on disk` };
  }

  rmSync(pluginDirectory, { recursive: true, force: true });

  return {
    success: true,
    output: `Plugin "${name}" has been uninstalled and removed from ${pluginDirectory}`,
  };
}
