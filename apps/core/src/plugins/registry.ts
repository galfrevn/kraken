import type { KrakenPlugin, Tool, PluginContext, PluginConfigField } from "@kraken/sdk";
import { resolvePluginPaths, type PluginEntry } from "@/plugins/resolver.ts";
import { loadPlugin, PluginLoadError } from "@/plugins/loader.ts";
import { ensureSdkResolvable } from "@/plugins/installer.ts";
import { HookDispatcher } from "@/plugins/hooks.ts";

export interface MissingConfigField {
  fieldName: string;
  field: PluginConfigField;
}

interface DeferredPlugin {
  plugin: KrakenPlugin;
  resolvedEntry: { entry: string; source: "local" | "npm"; config: Record<string, unknown> };
  missing: MissingConfigField[];
  baseContext: Omit<PluginContext, "config">;
}

export interface LoadedPlugin {
  plugin: KrakenPlugin;
  source: "local" | "npm";
  entry: string;
  enabled: boolean;
  pluginContext: PluginContext;
}

export class PluginRegistry {
  private plugins: LoadedPlugin[] = [];
  private hookDispatcher = new HookDispatcher();
  private activated = false;
  private deferredPlugins: DeferredPlugin[] = [];

  static getMissingRequiredConfig(
    plugin: KrakenPlugin,
    config: Record<string, unknown>,
  ): MissingConfigField[] {
    if (!plugin.configSchema) return [];
    const missing: MissingConfigField[] = [];
    for (const [fieldName, field] of Object.entries(plugin.configSchema)) {
      if (!field.required) continue;
      const hasConfig = config[fieldName] !== undefined && config[fieldName] !== "";
      const hasEnv = field.envVar ? !!process.env[field.envVar] : false;
      if (!hasConfig && !hasEnv) {
        missing.push({ fieldName, field });
      }
    }
    return missing;
  }

  async loadAll(
    entries: PluginEntry[],
    workingDirectory: string,
    baseContext: Omit<PluginContext, "config">,
    deferActivation?: boolean,
  ): Promise<{ loaded: string[]; failed: Array<{ entry: string; error: string }>; deferred: Array<{ name: string; missing: MissingConfigField[] }> }> {
    if (entries.length === 0) {
      return { loaded: [], failed: [], deferred: [] };
    }

    ensureSdkResolvable();

    const { resolved, failed: unresolvedEntries } = resolvePluginPaths(entries, workingDirectory);

    const loaded: string[] = [];
    const failed: Array<{ entry: string; error: string }> = unresolvedEntries.map((entry) => ({
      entry,
      error: "could not resolve plugin path",
    }));

    for (const resolvedPlugin of resolved) {
      try {
        const plugin = await loadPlugin(resolvedPlugin.absolutePath);

        const duplicate = this.plugins.find((p) => p.plugin.name === plugin.name);
        if (duplicate) {
          failed.push({
            entry: resolvedPlugin.entry,
            error: `duplicate plugin name: ${plugin.name}`,
          });
          continue;
        }

        const perPluginContext: PluginContext = {
          ...baseContext,
          config: resolvedPlugin.config,
        };

        const missingConfig = PluginRegistry.getMissingRequiredConfig(plugin, resolvedPlugin.config);

        if (missingConfig.length > 0 && deferActivation) {
          this.deferredPlugins.push({
            plugin,
            resolvedEntry: { entry: resolvedPlugin.entry, source: resolvedPlugin.source, config: resolvedPlugin.config },
            missing: missingConfig,
            baseContext,
          });
          continue;
        }

        if (plugin.activate) {
          await plugin.activate(perPluginContext);
        }

        this.hookDispatcher.register(plugin);
        this.plugins.push({
          plugin,
          source: resolvedPlugin.source,
          entry: resolvedPlugin.entry,
          enabled: true,
          pluginContext: perPluginContext,
        });
        loaded.push(plugin.name);
      } catch (error) {
        const message =
          error instanceof PluginLoadError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);

        failed.push({ entry: resolvedPlugin.entry, error: message });
      }
    }

    this.activated = true;
    const deferred = this.deferredPlugins.map((d) => ({ name: d.plugin.name, missing: d.missing }));
    return { loaded, failed, deferred };
  }

  getDeferredPlugins(): Array<{ name: string; missing: MissingConfigField[] }> {
    return this.deferredPlugins.map((d) => ({ name: d.plugin.name, missing: d.missing }));
  }

  async activateDeferred(): Promise<{ loaded: string[]; failed: Array<{ name: string; error: string }> }> {
    const loaded: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    for (const deferred of this.deferredPlugins) {
      try {
        const perPluginContext: PluginContext = {
          ...deferred.baseContext,
          config: deferred.resolvedEntry.config,
        };

        // Re-check env vars for missing fields and merge into config
        for (const { fieldName, field } of deferred.missing) {
          if (field.envVar && process.env[field.envVar]) {
            perPluginContext.config[fieldName] = process.env[field.envVar];
          }
        }

        if (deferred.plugin.activate) {
          await deferred.plugin.activate(perPluginContext);
        }

        this.hookDispatcher.register(deferred.plugin);
        this.plugins.push({
          plugin: deferred.plugin,
          source: deferred.resolvedEntry.source,
          entry: deferred.resolvedEntry.entry,
          enabled: true,
          pluginContext: perPluginContext,
        });
        loaded.push(deferred.plugin.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ name: deferred.plugin.name, error: message });
      }
    }

    this.deferredPlugins = [];
    return { loaded, failed };
  }

  async installPlugin(
    pluginPath: string,
    workingDirectory: string,
    baseContext: Omit<PluginContext, "config">,
    config: Record<string, unknown> = {},
    deferIfMissingConfig?: boolean,
  ): Promise<{ success: true; plugin: KrakenPlugin; missingConfig?: MissingConfigField[] } | { success: false; error: string }> {
    ensureSdkResolvable();

    const { resolved, failed } = resolvePluginPaths(
      [{ path: pluginPath, config }],
      workingDirectory,
    );

    if (failed.length > 0 || resolved.length === 0) {
      return { success: false, error: `could not resolve plugin path: ${pluginPath}` };
    }

    const resolvedPlugin = resolved[0]!;

    try {
      const plugin = await loadPlugin(resolvedPlugin.absolutePath);

      const duplicate = this.plugins.find((p) => p.plugin.name === plugin.name);
      if (duplicate) {
        return { success: false, error: `plugin "${plugin.name}" is already loaded` };
      }

      const missingConfig = PluginRegistry.getMissingRequiredConfig(plugin, resolvedPlugin.config);

      if (missingConfig.length > 0 && deferIfMissingConfig) {
        this.deferredPlugins.push({
          plugin,
          resolvedEntry: { entry: resolvedPlugin.entry, source: resolvedPlugin.source, config: resolvedPlugin.config },
          missing: missingConfig,
          baseContext,
        });
        return { success: true, plugin, missingConfig };
      }

      const perPluginContext: PluginContext = {
        ...baseContext,
        config: resolvedPlugin.config,
      };

      if (plugin.activate) {
        await plugin.activate(perPluginContext);
      }

      this.hookDispatcher.register(plugin);
      this.plugins.push({
        plugin,
        source: resolvedPlugin.source,
        entry: resolvedPlugin.entry,
        enabled: true,
        pluginContext: perPluginContext,
      });

      return { success: true, plugin };
    } catch (error) {
      const message =
        error instanceof PluginLoadError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      return { success: false, error: message };
    }
  }

  async shutdownAll(): Promise<void> {
    for (const { plugin } of this.plugins) {
      if (plugin.deactivate) {
        try {
          await plugin.deactivate();
        } catch (error) {
          console.error(`[plugin:${plugin.name}] deactivate error:`, error);
        }
      }
    }

    this.plugins = [];
    this.activated = false;
  }

  async disablePlugin(name: string): Promise<boolean> {
    const entry = this.plugins.find((p) => p.plugin.name === name && p.enabled);
    if (!entry) return false;

    if (entry.plugin.deactivate) {
      try {
        await entry.plugin.deactivate();
      } catch (error) {
        console.error(`[plugin:${name}] deactivate error:`, error);
      }
    }

    entry.enabled = false;
    this.rebuildHookDispatcher();
    return true;
  }

  async enablePlugin(name: string): Promise<boolean> {
    const entry = this.plugins.find((p) => p.plugin.name === name && !p.enabled);
    if (!entry) return false;

    if (entry.plugin.activate) {
      try {
        await entry.plugin.activate(entry.pluginContext);
      } catch (error) {
        console.error(`[plugin:${name}] activate error:`, error);
        return false;
      }
    }

    entry.enabled = true;
    this.rebuildHookDispatcher();
    return true;
  }

  async removePlugin(name: string): Promise<boolean> {
    const index = this.plugins.findIndex((p) => p.plugin.name === name);
    if (index === -1) return false;

    const entry = this.plugins[index]!;
    if (entry.enabled && entry.plugin.deactivate) {
      try {
        await entry.plugin.deactivate();
      } catch (error) {
        console.error(`[plugin:${name}] deactivate error:`, error);
      }
    }

    this.plugins.splice(index, 1);
    this.rebuildHookDispatcher();
    return true;
  }

  private rebuildHookDispatcher(): void {
    this.hookDispatcher.clear();
    for (const entry of this.plugins) {
      if (entry.enabled) {
        this.hookDispatcher.register(entry.plugin);
      }
    }
  }

  getTools(): Tool[] {
    return this.plugins.filter((p) => p.enabled).flatMap((p) => p.plugin.tools ?? []);
  }

  getPromptExtensions(): string[] {
    const extensions: string[] = this.plugins
      .filter((p) => p.enabled)
      .map((p) => p.plugin.promptExtension)
      .filter((extension): extension is string => !!extension);

    for (const deferred of this.deferredPlugins) {
      const base = deferred.plugin.promptExtension ?? "";
      const missingLines = deferred.missing.map((m) => {
        const envHint = m.field.envVar ? ` (env: ${m.field.envVar})` : "";
        return `  - ${m.fieldName}: ${m.field.description}${envHint}`;
      });
      const setupNote =
        `[SETUP REQUIRED] The '${deferred.plugin.name}' plugin is installed but not yet configured.\n` +
        `Missing configuration:\n${missingLines.join("\n")}\n` +
        `Ask the user for these values, then use plugin_manager with action "configure" to save each one ` +
        `(plugin_name="${deferred.plugin.name}", field="<fieldName>", value="<value>").` +
        `\nOnce all fields are configured the plugin will activate automatically.`;
      extensions.push(base ? `${base}\n\n${setupNote}` : setupNote);
    }

    return extensions;
  }

  getToolDisplayNames(): Record<string, string> {
    const names: Record<string, string> = {};
    for (const entry of this.plugins) {
      if (entry.enabled && entry.plugin.toolDisplayNames) {
        Object.assign(names, entry.plugin.toolDisplayNames);
      }
    }
    return names;
  }

  getHookDispatcher(): HookDispatcher {
    return this.hookDispatcher;
  }

  getLoadedPlugins(): LoadedPlugin[] {
    return [...this.plugins];
  }

  getPluginByName(name: string): LoadedPlugin | undefined {
    return this.plugins.find((p) => p.plugin.name === name);
  }

  get pluginCount(): number {
    return this.plugins.length;
  }

  get enabledCount(): number {
    return this.plugins.filter((p) => p.enabled).length;
  }

  get isActivated(): boolean {
    return this.activated;
  }
}
