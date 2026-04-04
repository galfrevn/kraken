import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRouter } from "@/server/routes/health.ts";
import { eventRouter } from "@/server/routes/event.ts";
import { sessionRouter } from "@/server/routes/session.ts";
import { modelsRouter } from "@/server/routes/models.ts";
import { filesRouter } from "@/server/routes/files.ts";

const DEFAULT_SERVER_PORT = 7899;
const SERVER_IDLE_TIMEOUT_SECONDS = 255;

export async function startServer(): Promise<{ url: string }> {
  const app = new Hono();

  app.use("*", cors());

  app.route("/", healthRouter);
  app.route("/", eventRouter);
  app.route("/", sessionRouter);
  app.route("/", modelsRouter);
  app.route("/", filesRouter);

  const port = parseInt(process.env.KRAKEN_APP_PORT ?? String(DEFAULT_SERVER_PORT), 10);

  const server = Bun.serve({
    port,
    fetch: app.fetch,
    idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS,
  });

  return { url: `http://localhost:${server.port}` };
}
