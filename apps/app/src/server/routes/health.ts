import { Hono } from "hono";

export const healthRouter = new Hono();

healthRouter.get("/health", (context) => {
  return context.json({ status: "ok", timestamp: Date.now() });
});
