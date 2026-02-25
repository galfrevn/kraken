import type { KrakenPlugin, Tool, PluginContext } from "@kraken/sdk";
import { resolvePluginPaths, type PluginEntry } from "@/plugins/resolver.ts";
import { loadPlugin, PluginLoadError } from "@/plugins/loader.ts";
import { HookDispatcher } from "@/plugins/hooks.ts";

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

  async loadAll(
    entries: PluginEntry[],
    workingDirectory: string,
    baseContext: Omit<PluginContext, "config">,
  ): Promise<{ loaded: string[]; failed: Array<{ entry: string; error: string }> }> {
    if (entries.length === 0) {
      return { loaded: [], failed: [] };
    }

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
    return { loaded, failed };
  }

  async installPlugin(
    pluginPath: string,
    workingDirectory: string,
    baseContext: Omit<PluginContext, "config">,
    config: Record<string, unknown> = {},
  ): Promise<{ success: true; plugin: KrakenPlugin } | { success: false; error: string }> {
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
    return this.plugins
      .filter((p) => p.enabled)
      .map((p) => p.plugin.promptExtension)
      .filter((extension): extension is string => !!extension);
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
