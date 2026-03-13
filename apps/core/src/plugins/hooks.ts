import type { KrakenPlugin, PluginHooks, PluginContext, ToolResult } from "@kraken/sdk";

interface RegisteredHooks {
  pluginName: string;
  hooks: PluginHooks;
}

export class HookDispatcher {
  private registrations: RegisteredHooks[] = [];

  register(plugin: KrakenPlugin): void {
    if (plugin.hooks) {
      this.registrations.push({ pluginName: plugin.name, hooks: plugin.hooks });
    }
  }

  clear(): void {
    this.registrations = [];
  }

  async dispatchConversationStart(context: PluginContext): Promise<void> {
    const promises = this.registrations
      .filter(({ hooks }) => hooks.onConversationStart)
      .map(({ pluginName, hooks }) =>
        Promise.resolve(hooks.onConversationStart!(context)).catch((error: unknown) => {
          console.error(`[plugin:${pluginName}] onConversationStart error:`, error);
        }),
      );

    await Promise.allSettled(promises);
  }

  async dispatchConversationEnd(context: PluginContext): Promise<void> {
    const promises = this.registrations
      .filter(({ hooks }) => hooks.onConversationEnd)
      .map(({ pluginName, hooks }) =>
        Promise.resolve(hooks.onConversationEnd!(context)).catch((error: unknown) => {
          console.error(`[plugin:${pluginName}] onConversationEnd error:`, error);
        }),
      );

    await Promise.allSettled(promises);
  }

  async dispatchBeforeToolCall(
    toolName: string,
    parameters: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let currentParameters = parameters;

    for (const { pluginName, hooks } of this.registrations) {
      if (!hooks.beforeToolCall) continue;
      try {
        currentParameters = await hooks.beforeToolCall(toolName, currentParameters);
      } catch (error) {
        console.error(`[plugin:${pluginName}] beforeToolCall error:`, error);
      }
    }

    return currentParameters;
  }

  async dispatchAfterToolCall(
    toolName: string,
    parameters: Record<string, unknown>,
    result: ToolResult,
  ): Promise<void> {
    const promises = this.registrations
      .filter(({ hooks }) => hooks.afterToolCall)
      .map(({ pluginName, hooks }) =>
        Promise.resolve(hooks.afterToolCall!(toolName, parameters, result)).catch(
          (error: unknown) => {
            console.error(`[plugin:${pluginName}] afterToolCall error:`, error);
          },
        ),
      );

    await Promise.allSettled(promises);
  }

  get hasHooks(): boolean {
    return this.registrations.length > 0;
  }
}
