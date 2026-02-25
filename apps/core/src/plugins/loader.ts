import type { KrakenPlugin } from "@kraken/sdk";

export class PluginLoadError extends Error {
  constructor(
    public readonly pluginPath: string,
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`failed to load plugin at "${pluginPath}": ${message}`);
    this.name = "PluginLoadError";
  }
}

function validatePlugin(plugin: unknown, pluginPath: string): asserts plugin is KrakenPlugin {
  if (!plugin || typeof plugin !== "object") {
    throw new PluginLoadError(pluginPath, "module does not export a valid plugin object");
  }

  const candidate = plugin as Record<string, unknown>;

  if (typeof candidate["name"] !== "string" || !candidate["name"]) {
    throw new PluginLoadError(pluginPath, "plugin must have a non-empty 'name' property");
  }

  if (typeof candidate["version"] !== "string" || !candidate["version"]) {
    throw new PluginLoadError(pluginPath, "plugin must have a non-empty 'version' property");
  }

  if (candidate["tools"] !== undefined && !Array.isArray(candidate["tools"])) {
    throw new PluginLoadError(pluginPath, "'tools' must be an array");
  }

  if (candidate["hooks"] !== undefined && typeof candidate["hooks"] !== "object") {
    throw new PluginLoadError(pluginPath, "'hooks' must be an object");
  }

  if (
    candidate["promptExtension"] !== undefined &&
    typeof candidate["promptExtension"] !== "string"
  ) {
    throw new PluginLoadError(pluginPath, "'promptExtension' must be a string");
  }
}

export async function loadPlugin(absolutePath: string): Promise<KrakenPlugin> {
  let module: Record<string, unknown>;

  try {
    module = await import(absolutePath);
  } catch (error) {
    throw new PluginLoadError(absolutePath, error);
  }

  const exported = (module["default"] as unknown) ?? module;
  validatePlugin(exported, absolutePath);

  return exported;
}
