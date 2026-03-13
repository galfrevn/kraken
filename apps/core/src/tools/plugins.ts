import { resolve } from "node:path";
import { homedir } from "node:os";
import { rmSync, existsSync } from "node:fs";
import type { Tool, ToolResult } from "@/tools/schema.ts";
import type { ToolRegistry } from "@/tools/registry.ts";
import { PluginRegistry, type MissingConfigField } from "@/plugins/registry.ts";
import type { PluginContext, PluginConfigField } from "@kraken/sdk";
import { fetchRegistry, installPluginFromRegistry, isPluginInstalled } from "@/plugins/installer.ts";
import { appendToGlobalEnvFile } from "@/configuration/loader.ts";

export interface SetupFieldForPrompt {
  pluginName: string;
  fieldName: string;
  field: PluginConfigField;
}

export interface PluginManagerDependencies {
  pluginRegistry: PluginRegistry;
  toolRegistry: ToolRegistry;
  workingDirectory: string;
  baseContext: Omit<PluginContext, "config">;
  onToolDisplayNamesChanged?: (names: Record<string, string>) => void;
  onSetupRequired?: (fields: SetupFieldForPrompt[]) => Promise<void>;
}

export function createPluginManagerTool(dependencies: PluginManagerDependencies): Tool {
  const { pluginRegistry, toolRegistry, workingDirectory, baseContext, onToolDisplayNamesChanged, onSetupRequired } =
    dependencies;

  return {
    definition: {
      name: "plugin_manager",
      description: "Manage plugins (list, install, configure, update, remove).",
      parameters: [
        {
          name: "action",
          type: "string" as const,
          description:
            "The action to perform: 'list', 'store', 'inspect', 'check_updates', 'update', 'install_from_store', 'install', 'uninstall', 'disable', 'enable', 'remove'.",
          required: true,
        },
        {
          name: "plugin_name",
          type: "string" as const,
          description:
            "The plugin name, path, or search query (required for inspect, install, disable, enable, remove, configure; optional for store).",
          required: false,
        },
        {
          name: "field",
          type: "string" as const,
          description: "Config field name (required for configure action).",
          required: false,
        },
        {
          name: "value",
          type: "string" as const,
          description: "Config field value (required for configure action).",
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
      const fieldName = ((parameters["field"] as string) ?? "").trim();
      const fieldValue = ((parameters["value"] as string) ?? "").trim();
      const confirmed = (parameters["confirmed"] as boolean) ?? false;

      switch (action) {
        case "list":
          return handleList(pluginRegistry);
        case "store":
        case "browse":
          return handleStore(pluginRegistry, pluginName);
        case "configure":
          return handleConfigure(
            pluginRegistry,
            toolRegistry,
            pluginName,
            fieldName,
            fieldValue,
            onToolDisplayNamesChanged,
          );
        case "inspect":
          return handleInspect(pluginRegistry, pluginName);
        case "check_updates":
          return handleCheckUpdates(pluginRegistry);
        case "update":
          return handleUpdate(
            pluginRegistry,
            toolRegistry,
            pluginName,
            workingDirectory,
            baseContext,
            onToolDisplayNamesChanged,
          );
        case "install_from_store":
          return handleInstallFromStore(
            pluginRegistry,
            toolRegistry,
            pluginName,
            workingDirectory,
            baseContext,
            onToolDisplayNamesChanged,
            onSetupRequired,
          );
        case "install":
          return handleInstall(
            pluginRegistry,
            toolRegistry,
            pluginName,
            workingDirectory,
            baseContext,
            onToolDisplayNamesChanged,
            onSetupRequired,
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
            error: `unknown action "${action}". Available: list, store, inspect, check_updates, update, install_from_store, install, uninstall, disable, enable, remove`,
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

async function handleConfigure(
  registry: PluginRegistry,
  toolReg: ToolRegistry,
  pluginName: string,
  fieldName: string,
  value: string,
  onToolDisplayNamesChanged?: (names: Record<string, string>) => void,
): Promise<ToolResult> {
  if (!pluginName) {
    return { success: false, output: "", error: "plugin_name is required for configure" };
  }
  if (!fieldName) {
    return { success: false, output: "", error: "field is required for configure" };
  }
  if (!value) {
    return { success: false, output: "", error: "value is required for configure" };
  }

  // Check if it's a deferred plugin
  const deferred = registry.getDeferredPlugins();
  const deferredEntry = deferred.find((d) => d.name === pluginName);

  // Check if it's a loaded plugin
  const loadedEntry = registry.getPluginByName(pluginName);

  if (!deferredEntry && !loadedEntry) {
    return { success: false, output: "", error: `plugin "${pluginName}" not found` };
  }

  // Find the config field definition
  let fieldDef: PluginConfigField | undefined;

  if (loadedEntry) {
    fieldDef = loadedEntry.plugin.configSchema?.[fieldName];
  } else if (deferredEntry) {
    const missing = deferredEntry.missing.find((m) => m.fieldName === fieldName);
    fieldDef = missing?.field;
  }
  if (!fieldDef) {
    return { success: false, output: "", error: `unknown config field "${fieldName}" for plugin "${pluginName}"` };
  }

  // Save the value
  if (fieldDef.envVar) {
    await appendToGlobalEnvFile(fieldDef.envVar, value);
  }

  // If this was a deferred plugin, try to activate it
  if (deferredEntry) {
    // Check if all required fields are now satisfied
    const stillMissing = deferredEntry.missing.filter((m) => {
      if (m.fieldName === fieldName) return false; // just configured this one
      if (m.field.envVar && process.env[m.field.envVar]) return false;
      return true;
    });

    if (stillMissing.length === 0) {
      const activateResult = await registry.activateDeferred();

      if (activateResult.loaded.length > 0) {
        for (const tool of registry.getTools()) {
          if (!toolReg.getTool(tool.definition.name)) {
            try { toolReg.register(tool); } catch { /* skip */ }
          }
        }
        if (onToolDisplayNamesChanged) {
          onToolDisplayNamesChanged(registry.getToolDisplayNames());
        }
        return {
          success: true,
          output:
            `Saved ${fieldName} for "${pluginName}". ` +
            `All configuration complete — plugin activated. ` +
            `Tools: ${activateResult.loaded.join(", ")}`,
        };
      }

      if (activateResult.failed.length > 0) {
        return {
          success: false,
          output: "",
          error: `Saved config but activation failed: ${activateResult.failed.map((f) => f.error).join(", ")}`,
        };
      }
    }

    return {
      success: true,
      output:
        `Saved ${fieldName} for "${pluginName}". ` +
        `Still missing: ${stillMissing.map((m) => m.fieldName).join(", ")}`,
    };
  }

  return {
    success: true,
    output: `Saved ${fieldName}="${value}" for "${pluginName}". Restart or reload the plugin for the change to take effect.`,
  };
}

async function promptAndActivateDeferred(
  registry: PluginRegistry,
  toolReg: ToolRegistry,
  pluginName: string,
  missingConfig: MissingConfigField[],
  onToolDisplayNamesChanged?: (names: Record<string, string>) => void,
  onSetupRequired?: (fields: SetupFieldForPrompt[]) => Promise<void>,
): Promise<string> {
  const setupFields: SetupFieldForPrompt[] = missingConfig.map((m) => ({
    pluginName,
    fieldName: m.fieldName,
    field: m.field,
  }));

  if (onSetupRequired) {
    await onSetupRequired(setupFields);
  }

  const activateResult = await registry.activateDeferred();

  if (activateResult.loaded.length > 0) {
    for (const tool of registry.getTools()) {
      if (!toolReg.getTool(tool.definition.name)) {
        try {
          toolReg.register(tool);
        } catch { /* skip */ }
      }
    }
    if (onToolDisplayNamesChanged) {
      onToolDisplayNamesChanged(registry.getToolDisplayNames());
    }
  }

  if (activateResult.failed.length > 0) {
    return `Configuration saved but activation failed: ${activateResult.failed.map((f) => f.error).join(", ")}`;
  }
  return "";
}

async function handleInstall(
  registry: PluginRegistry,
  toolReg: ToolRegistry,
  pluginPath: string,
  workingDirectory: string,
  baseContext: Omit<PluginContext, "config">,
  onToolDisplayNamesChanged?: (names: Record<string, string>) => void,
  onSetupRequired?: (fields: SetupFieldForPrompt[]) => Promise<void>,
): Promise<ToolResult> {
  if (!pluginPath) {
    return { success: false, output: "", error: "plugin_name (path) is required for install" };
  }

  const result = await registry.installPlugin(pluginPath, workingDirectory, baseContext, {}, true);

  if (!result.success) {
    return { success: false, output: "", error: result.error };
  }

  const plugin = result.plugin;

  if (result.missingConfig && result.missingConfig.length > 0) {
    const setupError = await promptAndActivateDeferred(
      registry, toolReg, plugin.name, result.missingConfig,
      onToolDisplayNamesChanged, onSetupRequired,
    );
    const toolNames = plugin.tools?.map((t) => t.definition.name).join(", ") ?? "none";
    return {
      success: !setupError,
      output:
        `plugin "${plugin.name}" v${plugin.version} installed.\n` +
        `tools: ${toolNames}\n` +
        (setupError || "Configuration saved and plugin activated."),
    };
  }

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

async function handleStore(localRegistry: PluginRegistry, query: string): Promise<ToolResult> {
  try {
    const registry = await fetchRegistry();
    const loadedPlugins = localRegistry.getLoadedPlugins();
    const loadedNames = new Set(loadedPlugins.map((p) => p.plugin.name));

    let plugins = registry.plugins;

    if (query) {
      const terms = query.toLowerCase().split(/\s+/);
      plugins = plugins.filter((entry) => {
        const searchable = [
          entry.name,
          entry.description,
          entry.author,
          ...entry.tools,
        ].join(" ").toLowerCase();
        return terms.every((term) => searchable.includes(term));
      });
    }

    if (plugins.length === 0) {
      return {
        success: true,
        output: query
          ? `No plugins found matching "${query}".`
          : "The plugin store is empty.",
      };
    }

    const lines = plugins.map((entry) => {
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

    const header = query
      ? `Plugin Store — ${plugins.length} result(s) for "${query}":`
      : `Plugin Store — ${plugins.length} plugin(s) available:`;

    return {
      success: true,
      output:
        `${header}\n\n${lines.join("\n\n")}\n\n` +
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
  onSetupRequired?: (fields: SetupFieldForPrompt[]) => Promise<void>,
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
    {},
    true,
  );

  if (!loadResult.success) {
    return {
      success: false,
      output: "",
      error: `Downloaded to ${installResult.installPath} but failed to load: ${loadResult.error}`,
    };
  }

  const plugin = loadResult.plugin;
  const warningLines = installResult.warnings.length > 0
    ? "\n\nWarnings:\n" + installResult.warnings.map((w) => `  - ${w}`).join("\n")
    : "";

  if (loadResult.missingConfig && loadResult.missingConfig.length > 0) {
    const setupError = await promptAndActivateDeferred(
      registry, toolReg, plugin.name, loadResult.missingConfig,
      onToolDisplayNamesChanged, onSetupRequired,
    );
    const toolNames = plugin.tools?.map((t) => t.definition.name).join(", ") ?? "none";
    return {
      success: !setupError,
      output:
        `Plugin "${plugin.name}" v${plugin.version} downloaded and installed.\n` +
        `Tools: ${toolNames}\n` +
        `Installed to: ${installResult.installPath}\n` +
        (setupError || "Configuration saved and plugin activated.") +
        warningLines,
    };
  }

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

async function handleCheckUpdates(localRegistry: PluginRegistry): Promise<ToolResult> {
  try {
    const remoteRegistry = await fetchRegistry();
    const loadedPlugins = localRegistry.getLoadedPlugins();

    if (loadedPlugins.length === 0) {
      return { success: true, output: "No plugins installed." };
    }

    const lines: string[] = [];
    let updatesAvailable = 0;

    for (const local of loadedPlugins) {
      const remote = remoteRegistry.plugins.find((p) => p.name === local.plugin.name);
      if (!remote) {
        lines.push(`- ${local.plugin.name} v${local.plugin.version} (local only, not in registry)`);
        continue;
      }

      if (remote.version !== local.plugin.version) {
        lines.push(`- ${local.plugin.name}: v${local.plugin.version} → v${remote.version} (update available)`);
        updatesAvailable++;
      } else {
        lines.push(`- ${local.plugin.name}: v${local.plugin.version} (up to date)`);
      }
    }

    const summary = updatesAvailable > 0
      ? `\n\n${updatesAvailable} update(s) available. Use action "update" with the plugin name to update.`
      : "\n\nAll plugins are up to date.";

    return { success: true, output: lines.join("\n") + summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, output: "", error: `Failed to check for updates: ${message}` };
  }
}

async function handleUpdate(
  registry: PluginRegistry,
  toolReg: ToolRegistry,
  pluginName: string,
  workingDirectory: string,
  baseContext: Omit<PluginContext, "config">,
  onToolDisplayNamesChanged?: (names: Record<string, string>) => void,
): Promise<ToolResult> {
  if (!pluginName) {
    return { success: false, output: "", error: "plugin_name is required for update" };
  }

  const existing = registry.getPluginByName(pluginName);
  if (!existing) {
    return { success: false, output: "", error: `Plugin "${pluginName}" is not installed. Use install_from_store to install it.` };
  }

  const oldVersion = existing.plugin.version;

  // Remove old tools from the tool registry
  if (existing.plugin.tools) {
    for (const tool of existing.plugin.tools) {
      toolReg.unregister(tool.definition.name);
    }
  }

  // Unload the plugin from the plugin registry
  await registry.removePlugin(pluginName);

  // Re-download from the store
  const installResult = await installPluginFromRegistry(pluginName);
  if (!installResult.success) {
    return { success: false, output: "", error: `Failed to download update: ${installResult.error}` };
  }

  // Re-load the updated plugin
  const loadResult = await registry.installPlugin(
    installResult.installPath,
    workingDirectory,
    baseContext,
  );

  if (!loadResult.success) {
    return {
      success: false,
      output: "",
      error: `Downloaded update but failed to load: ${loadResult.error}`,
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
  const versionChange = oldVersion !== plugin.version
    ? `v${oldVersion} → v${plugin.version}`
    : `v${plugin.version} (re-installed)`;

  return {
    success: true,
    output:
      `Plugin "${plugin.name}" updated: ${versionChange}\n` +
      `Tools registered: ${toolNames}\n` +
      "The updated tools are available immediately.",
  };
}
