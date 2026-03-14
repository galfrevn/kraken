import type { SchedulerClient } from "@/clients/scheduler.ts";
import type { SchedulerConfiguration } from "@/configuration/schema.ts";

export interface RegisteredCronJob {
  cronId: string;
  name: string;
  taskTemplate: string;
}

export interface RegisteredWatcher {
  watcherId: string;
  name: string;
}

export async function synchronizeCronJobs(
  schedulerClient: SchedulerClient,
  schedulerConfiguration: SchedulerConfiguration,
): Promise<RegisteredCronJob[]> {
  const existingCrons = await schedulerClient.listCrons({});
  for (const existingCron of existingCrons.crons) {
    await schedulerClient.unregisterCron({ cronId: existingCron.cronId });
  }

  const registeredCronJobs: RegisteredCronJob[] = [];

  for (const cronJobConfiguration of schedulerConfiguration.crons) {
    if (!cronJobConfiguration.enabled) continue;

    const response = await schedulerClient.registerCron({
      name: cronJobConfiguration.name,
      cronExpression: cronJobConfiguration.expression,
      taskTemplate: cronJobConfiguration.task,
      parameters: cronJobConfiguration.parameters,
    });

    registeredCronJobs.push({
      cronId: response.cronId,
      name: cronJobConfiguration.name,
      taskTemplate: cronJobConfiguration.task,
    });

    console.log(
      `  cron registered: ${cronJobConfiguration.name} (${cronJobConfiguration.expression}) next: ${response.nextRun}`,
    );
  }

  return registeredCronJobs;
}

export async function synchronizeWatchers(
  schedulerClient: SchedulerClient,
  schedulerConfiguration: SchedulerConfiguration,
): Promise<RegisteredWatcher[]> {
  const existingWatchers = await schedulerClient.listWatchers({});
  for (const w of existingWatchers.watchers) {
    await schedulerClient.unregisterWatcher({ watcherId: w.watcherId });
  }

  const registeredWatchers: RegisteredWatcher[] = [];

  for (const watcherConfiguration of schedulerConfiguration.watchers) {
    const response = await schedulerClient.registerWatcher({
      name: watcherConfiguration.name,
      paths: watcherConfiguration.paths,
      ignorePatterns: watcherConfiguration.ignore,
      debounceMs: watcherConfiguration.debounceMs,
    });

    registeredWatchers.push({
      watcherId: response.watcherId,
      name: watcherConfiguration.name,
    });

    console.log(
      `  watcher registered: ${watcherConfiguration.name} (${watcherConfiguration.paths.join(", ")})`,
    );
  }

  return registeredWatchers;
}
