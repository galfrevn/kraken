import type { GatewayClient } from "@/clients/gateway.ts";
import type { TaskQueueManager } from "@/queue/manager.ts";
import type { ApprovalPolicyResolver } from "@/approval/resolver.ts";
import { TRIGGER_TYPE } from "@/queue/schema.ts";

const RECONNECTION_DELAY_MILLISECONDS = 5_000;

export class WebhookEventListener {
  private gatewayClient: GatewayClient;
  private taskQueueManager: TaskQueueManager;
  private approvalPolicyResolver: ApprovalPolicyResolver;
  private abortController: AbortController;
  private running: boolean = false;

  constructor(
    gatewayClient: GatewayClient,
    taskQueueManager: TaskQueueManager,
    approvalPolicyResolver: ApprovalPolicyResolver,
  ) {
    this.gatewayClient = gatewayClient;
    this.taskQueueManager = taskQueueManager;
    this.approvalPolicyResolver = approvalPolicyResolver;
    this.abortController = new AbortController();
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("  webhook event listener: started");

    while (this.running) {
      try {
        await this.consumeEventStream();
      } catch (error) {
        if (!this.running) break;

        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`  webhook event stream disconnected: ${errorMessage}`);
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
    const eventStream = this.gatewayClient.streamWebhookEvents(
      {},
      { signal: this.abortController.signal },
    );

    for await (const response of eventStream) {
      if (!response.event) continue;

      const event = response.event;

      console.log(`  webhook event: ${event.provider}/${event.eventType} (${event.webhookId})`);

      const approvalPolicy = this.approvalPolicyResolver.resolveForTrigger(TRIGGER_TYPE.webhook);

      this.taskQueueManager.submitTask({
        name: `webhook:${event.provider}:${event.eventType}`,
        description: `webhook received from ${event.provider} (${event.eventType})`,
        triggerType: TRIGGER_TYPE.webhook,
        approvalPolicy,
        parameters: {
          webhook_id: event.webhookId,
          provider: event.provider,
          event_type: event.eventType,
          payload: event.payload,
        },
      });
    }
  }
}
