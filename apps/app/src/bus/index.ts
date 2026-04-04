type EventHandler<TPayload = unknown> = (payload: TPayload) => void;

interface Subscription {
  unsubscribe(): void;
}

const subscribersByTopic = new Map<string, Set<EventHandler>>();

export const Bus = {
  publish<TPayload>(topic: string, payload: TPayload): void {
    const topicSubscribers = subscribersByTopic.get(topic);
    if (!topicSubscribers) return;
    for (const handler of topicSubscribers) {
      try {
        handler(payload);
      } catch (handlerError) {
        console.error(`[bus] handler error on "${topic}":`, handlerError);
      }
    }
  },

  subscribe<TPayload>(topic: string, handler: EventHandler<TPayload>): Subscription {
    let topicSubscribers = subscribersByTopic.get(topic);
    if (!topicSubscribers) {
      topicSubscribers = new Set();
      subscribersByTopic.set(topic, topicSubscribers);
    }
    topicSubscribers.add(handler as EventHandler);

    return {
      unsubscribe() {
        topicSubscribers!.delete(handler as EventHandler);
        if (topicSubscribers!.size === 0) {
          subscribersByTopic.delete(topic);
        }
      },
    };
  },
};

export const Events = {
  Session: {
    Created: "session.created",
    Updated: "session.updated",
    Deleted: "session.deleted",
    Compacting: "session.compacting",
    Compacted: "session.compacted",
  },
  Message: {
    Created: "message.created",
    Updated: "message.updated",
  },
  Part: {
    Created: "part.created",
    Updated: "part.updated",
  },
  Model: {
    Changed: "model.changed",
  },
  Usage: {
    Updated: "usage.updated",
  },
  Tool: {
    Progress: "tool.progress",
  },
  Question: {
    Asked: "question.asked",
    Replied: "question.replied",
    Rejected: "question.rejected",
  },
  Todo: {
    Updated: "todo.updated",
  },
  Permission: {
    Required: "permission.required",
    Approved: "permission.approved",
    Rejected: "permission.rejected",
  },
  Lsp: {
    ServerStarted: "lsp.server.started",
    DiagnosticsUpdated: "lsp.diagnostics.updated",
  },
  Daemon: {
    TaskStarted: "daemon.task.started",
    TaskCompleted: "daemon.task.completed",
    TaskFailed: "daemon.task.failed",
    TaskCancelled: "daemon.task.cancelled",
    TriggerFired: "daemon.trigger.fired",
    PullRequestCreated: "daemon.pr.created",
    DailyDigest: "daemon.daily.digest",
    CostWarning: "daemon.cost.warning",
    RateLimitExceeded: "daemon.rate_limit.exceeded",
    Connected: "daemon.connected",
    Disconnected: "daemon.disconnected",
  },
} as const;
