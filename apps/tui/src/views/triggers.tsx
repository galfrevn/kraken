import { useState, useEffect } from "react";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { COLORS } from "@/theme.ts";

const KRAKEN_CONFIGURATION_FILE_PATH = resolve(homedir(), ".kraken", "kraken.yml");
const ALTERNATIVE_CONFIGURATION_FILE_PATH = resolve(homedir(), ".kraken", "kraken.yaml");

interface CronTriggerEntry {
  name: string;
  expression: string;
  task: string;
  enabled: boolean;
}

interface WebhookTriggerEntry {
  name: string;
  provider: string;
  events: string[];
}

interface FileWatcherTriggerEntry {
  name: string;
  paths: string[];
}

interface ParsedTriggersConfiguration {
  cronSchedules: CronTriggerEntry[];
  webhooks: WebhookTriggerEntry[];
  fileWatchers: FileWatcherTriggerEntry[];
  loadError: string | null;
}

async function loadTriggersFromConfigurationFile(): Promise<ParsedTriggersConfiguration> {
  const emptyConfiguration: ParsedTriggersConfiguration = {
    cronSchedules: [],
    webhooks: [],
    fileWatchers: [],
    loadError: null,
  };

  try {
    const overridePath = Bun.env["KRAKEN_CONFIGURATION_FILE"];
    let configurationFilePath = overridePath ?? KRAKEN_CONFIGURATION_FILE_PATH;

    if (!(await Bun.file(configurationFilePath).exists())) {
      configurationFilePath = ALTERNATIVE_CONFIGURATION_FILE_PATH;
      if (!(await Bun.file(configurationFilePath).exists())) {
        return { ...emptyConfiguration, loadError: "no configuration file found" };
      }
    }

    const rawFileContents = await Bun.file(configurationFilePath).text();
    const parsedYamlContent = parseYaml(rawFileContents);

    if (!parsedYamlContent || typeof parsedYamlContent !== "object") {
      return { ...emptyConfiguration, loadError: "configuration file is empty or invalid" };
    }

    const rawConfiguration = parsedYamlContent as Record<string, unknown>;
    const schedulerSection = rawConfiguration["scheduler"] as Record<string, unknown> | undefined;
    const webhooksSection = rawConfiguration["webhooks"] as unknown[] | undefined;

    const cronSchedules: CronTriggerEntry[] = [];
    const fileWatchers: FileWatcherTriggerEntry[] = [];
    const webhooks: WebhookTriggerEntry[] = [];

    if (schedulerSection) {
      const rawCrons = schedulerSection["crons"] as unknown[] | undefined;
      if (Array.isArray(rawCrons)) {
        for (const rawCron of rawCrons) {
          const cronEntry = rawCron as Record<string, unknown>;
          cronSchedules.push({
            name: String(cronEntry["name"] ?? "unnamed"),
            expression: String(cronEntry["expression"] ?? ""),
            task: String(cronEntry["task"] ?? ""),
            enabled: cronEntry["enabled"] !== false,
          });
        }
      }

      const rawWatchers = schedulerSection["watchers"] as unknown[] | undefined;
      if (Array.isArray(rawWatchers)) {
        for (const rawWatcher of rawWatchers) {
          const watcherEntry = rawWatcher as Record<string, unknown>;
          const watcherPaths = Array.isArray(watcherEntry["paths"])
            ? (watcherEntry["paths"] as string[])
            : [];
          fileWatchers.push({
            name: String(watcherEntry["name"] ?? "unnamed"),
            paths: watcherPaths,
          });
        }
      }
    }

    if (Array.isArray(webhooksSection)) {
      for (const rawWebhook of webhooksSection) {
        const webhookEntry = rawWebhook as Record<string, unknown>;
        const webhookEvents = Array.isArray(webhookEntry["events"])
          ? (webhookEntry["events"] as string[])
          : [];
        webhooks.push({
          name: String(webhookEntry["name"] ?? "unnamed"),
          provider: String(webhookEntry["provider"] ?? "unknown"),
          events: webhookEvents,
        });
      }
    }

    return { cronSchedules, webhooks, fileWatchers, loadError: null };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { ...emptyConfiguration, loadError: errorMessage };
  }
}

interface TriggersViewProps {
  focused: boolean;
}

export function TriggersView({ focused: _focused }: TriggersViewProps) {
  const [triggersConfiguration, setTriggersConfiguration] = useState<ParsedTriggersConfiguration>({
    cronSchedules: [],
    webhooks: [],
    fileWatchers: [],
    loadError: null,
  });

  useEffect(() => {
    loadTriggersFromConfigurationFile().then(setTriggersConfiguration);
  }, []);

  const { cronSchedules, webhooks, fileWatchers, loadError } = triggersConfiguration;
  const totalTriggerCount = cronSchedules.length + webhooks.length + fileWatchers.length;

  if (loadError) {
    return (
      <box flexDirection="column" flexGrow={1} width="100%">
        <box paddingBottom={1}>
          <text fg={COLORS.textSecondary}>triggers</text>
        </box>
        <box padding={2}>
          <text fg={COLORS.red}>{"error loading configuration: " + loadError}</text>
        </box>
      </box>
    );
  }

  if (totalTriggerCount === 0) {
    return (
      <box flexDirection="column" flexGrow={1} width="100%">
        <box paddingBottom={1}>
          <text fg={COLORS.textSecondary}>triggers</text>
        </box>
        <box padding={2} flexDirection="column" gap={1}>
          <text fg={COLORS.textMuted}>no triggers configured</text>
          <text fg={COLORS.textMuted}>
            {"add them to ~/.kraken/kraken.yml under 'scheduler:' and 'webhooks:'"}
          </text>
        </box>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box paddingBottom={1}>
        <text fg={COLORS.textSecondary}>
          {totalTriggerCount + " trigger" + (totalTriggerCount === 1 ? "" : "s") + " configured"}
        </text>
      </box>

      <scrollbox flexGrow={1} width="100%">
        <box flexDirection="column" gap={1}>
          {cronSchedules.length > 0 && (
            <box flexDirection="column" backgroundColor={COLORS.card} padding={1}>
              <text fg={COLORS.textSecondary}>cron schedules</text>
              <text fg={COLORS.textMuted}>{"─".repeat(40)}</text>
              {cronSchedules.map((cronEntry) => (
                <box key={cronEntry.name} flexDirection="row" paddingTop={0}>
                  <text fg={cronEntry.enabled ? COLORS.green : COLORS.textMuted}>
                    {cronEntry.enabled ? "  ● " : "  ○ "}
                  </text>
                  <text fg={cronEntry.enabled ? COLORS.text : COLORS.textMuted}>
                    {cronEntry.name}
                  </text>
                  <box flexGrow={1} />
                  <text fg={COLORS.textSecondary}>{cronEntry.expression}</text>
                </box>
              ))}
            </box>
          )}

          {webhooks.length > 0 && (
            <box flexDirection="column" backgroundColor={COLORS.card} padding={1}>
              <text fg={COLORS.textSecondary}>webhooks</text>
              <text fg={COLORS.textMuted}>{"─".repeat(40)}</text>
              {webhooks.map((webhookEntry) => (
                <box key={webhookEntry.name} flexDirection="row" paddingTop={0}>
                  <text fg={COLORS.green}>{"  ● "}</text>
                  <text fg={COLORS.text}>{webhookEntry.name}</text>
                  <box flexGrow={1} />
                  <text fg={COLORS.purple}>{webhookEntry.provider}</text>
                  <text fg={COLORS.textSecondary}>
                    {"  " + webhookEntry.events.length + " event" + (webhookEntry.events.length === 1 ? "" : "s")}
                  </text>
                </box>
              ))}
            </box>
          )}

          {fileWatchers.length > 0 && (
            <box flexDirection="column" backgroundColor={COLORS.card} padding={1}>
              <text fg={COLORS.textSecondary}>file watchers</text>
              <text fg={COLORS.textMuted}>{"─".repeat(40)}</text>
              {fileWatchers.map((watcherEntry) => (
                <box key={watcherEntry.name} flexDirection="column" paddingTop={0}>
                  <box flexDirection="row">
                    <text fg={COLORS.green}>{"  ● "}</text>
                    <text fg={COLORS.text}>{watcherEntry.name}</text>
                    <box flexGrow={1} />
                    <text fg={COLORS.textSecondary}>
                      {watcherEntry.paths.length + " path" + (watcherEntry.paths.length === 1 ? "" : "s")}
                    </text>
                  </box>
                  {watcherEntry.paths.map((watchedPath) => (
                    <text key={watchedPath} fg={COLORS.textMuted}>{"      " + watchedPath}</text>
                  ))}
                </box>
              ))}
            </box>
          )}
        </box>
      </scrollbox>
    </box>
  );
}
