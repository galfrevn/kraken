import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Bus } from "@/bus/index.ts";

const SSE_HEARTBEAT_INTERVAL_MILLISECONDS = 15_000;

export const eventRouter = new Hono();

eventRouter.get("/event", (context) => {
  return streamSSE(context, async (stream) => {
    const subscriptions: Array<{ unsubscribe(): void }> = [];

    const forwardEvent = (topic: string) => {
      const subscription = Bus.subscribe(topic, (payload) => {
        stream
          .writeSSE({
            event: topic,
            data: JSON.stringify(payload),
          })
          .catch(() => {});
      });
      subscriptions.push(subscription);
    };

    forwardEvent("session.created");
    forwardEvent("session.updated");
    forwardEvent("session.deleted");
    forwardEvent("message.created");
    forwardEvent("message.updated");
    forwardEvent("part.created");
    forwardEvent("part.updated");
    forwardEvent("model.changed");
    forwardEvent("usage.updated");

    forwardEvent("tool.progress");

    forwardEvent("question.asked");
    forwardEvent("question.replied");
    forwardEvent("question.rejected");
    forwardEvent("todo.updated");

    forwardEvent("daemon.task.started");
    forwardEvent("daemon.task.completed");
    forwardEvent("daemon.task.failed");
    forwardEvent("daemon.task.cancelled");
    forwardEvent("daemon.trigger.fired");
    forwardEvent("daemon.pr.created");
    forwardEvent("daemon.daily.digest");
    forwardEvent("daemon.cost.warning");
    forwardEvent("daemon.connected");
    forwardEvent("daemon.disconnected");

    const heartbeatInterval = setInterval(() => {
      stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => {});
    }, SSE_HEARTBEAT_INTERVAL_MILLISECONDS);

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeatInterval);
        for (const subscription of subscriptions) {
          subscription.unsubscribe();
        }
        resolve();
      });
    });
  });
});
