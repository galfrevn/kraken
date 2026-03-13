export { PluginRegistry, type LoadedPlugin, type MissingConfigField } from "@/plugins/registry.ts";
export { HookDispatcher } from "@/plugins/hooks.ts";
export { resolvePluginPaths, type ResolvedPlugin, type PluginEntry } from "@/plugins/resolver.ts";
export { loadPlugin, PluginLoadError } from "@/plugins/loader.ts";
export {
  fetchRegistry,
  installPluginFromRegistry,
  isPluginInstalled,
  getInstalledPluginNames,
  type PluginRegistryManifest,
  type RegistryPluginEntry,
  type InstallResult,
} from "@/plugins/installer.ts";
