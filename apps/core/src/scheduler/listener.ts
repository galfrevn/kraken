import type { SchedulerClient } from "@/clients/scheduler.ts";
import type { TaskQueueManager } from "@/queue/manager.ts";
import type { ApprovalPolicyResolver } from "@/approval/resolver.ts";
import { TRIGGER_TYPE } from "@/queue/schema.ts";

const RECONNECTION_DELAY_MILLISECONDS = 5_000;

export class SchedulerEventListener {
  private schedulerClient: SchedulerClient;
  private taskQueueManager: TaskQueueManager;
  private approvalPolicyResolver: ApprovalPolicyResolver;
  private abortController: AbortController;
  private running: boolean = false;

  constructor(
    schedulerClient: SchedulerClient,
    taskQueueManager: TaskQueueManager,
    approvalPolicyResolver: ApprovalPolicyResolver,
  ) {
    this.schedulerClient = schedulerClient;
    this.taskQueueManager = taskQueueManager;
    this.approvalPolicyResolver = approvalPolicyResolver;
    this.abortController = new AbortController();
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("  scheduler event listener: started");

    while (this.running) {
      try {
        await this.consumeEventStream();
      } catch (error) {
        if (!this.running) break;

        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`  scheduler event stream disconnected: ${errorMessage}`);
        console.log(`  reconnecting in ${RECONNECTION_DELAY_MILLISECONDS / 1000}s...`);
        await Bun.sleep(RECONNECTION_DELAY_MILLISECONDS);
      }
    }
  }

  stop(): void {
    this.running = false;
    this.abortController.abort();
  }

  private async consumeEventStream(): Promise<void> {
    const eventStream = this.schedulerClient.streamEvents(
      {},
      { signal: this.abortController.signal },
    );

    for await (const response of eventStream) {
      if (!response.event) continue;

      const event = response.event;
      const triggerType = this.mapTriggerType(event.triggerType);
      const parameters = this.extractPayloadParameters(event.payload);

      const taskName = parameters["task_template"] ?? event.source;

      console.log(`  scheduler event: ${triggerType} from ${event.source}`);

      const approvalPolicy = this.approvalPolicyResolver.resolveForTrigger(triggerType);

      this.taskQueueManager.submitTask({
        name: taskName,
        description: `triggered by ${triggerType}: ${event.source}`,
        triggerType,
        approvalPolicy,
        parameters,
      });
    }
  }

  private mapTriggerType(
    protoTriggerType: number,
  ): (typeof TRIGGER_TYPE)[keyof typeof TRIGGER_TYPE] {
    switch (protoTriggerType) {
      case 2:
        return TRIGGER_TYPE.cron;
      case 3:
        return TRIGGER_TYPE.webhook;
      case 4:
        return TRIGGER_TYPE.fileChange;
      default:
        return TRIGGER_TYPE.manual;
    }
  }

  private extractPayloadParameters(
    payload: { fields?: Record<string, { kind?: { value?: unknown } }> } | undefined,
  ): Record<string, string> {
    if (!payload?.fields) return {};

    const parameters: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload.fields)) {
      if (value.kind && "value" in value.kind && value.kind.value !== undefined) {
        parameters[key] = String(value.kind.value);
      }
    }
    return parameters;
  }
}
