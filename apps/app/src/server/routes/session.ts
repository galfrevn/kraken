import { Hono } from "hono";
import { Session } from "@/session/index.ts";
import { processUserMessage } from "@/session/processor.ts";
import {
  startMemorySession,
  endMemorySession,
  getActiveMemorySessionId,
} from "@/session/memory.ts";
import { replyToQuestion, rejectQuestion } from "@/tool/question.ts";
import { replyToPermission } from "@/tool/permission.ts";

export const sessionRouter = new Hono();

const activeAbortControllers = new Map<string, AbortController>();

process.on("beforeExit", () => {
  endMemorySession().catch(() => {});
});

process.on("SIGINT", () => {
  endMemorySession()
    .catch(() => {})
    .finally(() => process.exit(0));
});

sessionRouter.get("/session", async (context) => {
  const sessions = await Session.list();
  return context.json({ sessions });
});

sessionRouter.post("/session", async (context) => {
  let body: { agentId?: string; model?: string };
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid JSON body" }, 400);
  }
  const session = await Session.create(body.agentId, body.model);
  startMemorySession(session.id).catch(() => {});
  return context.json(session, 201);
});

sessionRouter.get("/session/:id", async (context) => {
  const session = await Session.get(context.req.param("id"));
  if (!session) return context.json({ error: "not found" }, 404);
  return context.json(session);
});

sessionRouter.patch("/session/:id", async (context) => {
  const sessionId = context.req.param("id");
  let body: { title?: string };
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid JSON body" }, 400);
  }
  if (body.title) {
    Session.updateTitle(sessionId, body.title);
  }
  return context.json({ ok: true });
});

sessionRouter.delete("/session/:id", async (context) => {
  const sessionId = context.req.param("id");
  if (getActiveMemorySessionId() === sessionId) {
    await endMemorySession();
  }
  await Session.delete(sessionId);
  return context.json({ ok: true });
});

sessionRouter.get("/session/:id/message", async (context) => {
  const messages = await Session.getMessages(context.req.param("id"));
  return context.json({ messages });
});

sessionRouter.get("/session/:id/history", async (context) => {
  const messages = await Session.getMessagesWithParts(context.req.param("id"));
  return context.json({ messages });
});

sessionRouter.post("/session/:id/message", async (context) => {
  const sessionId = context.req.param("id");

  let body: { content?: string; agentId?: string; fileParts?: Array<{ path: string }> };
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid JSON body" }, 400);
  }

  if (!body.content || typeof body.content !== "string" || !body.content.trim()) {
    return context.json({ error: "content is required and must be a non-empty string" }, 400);
  }

  const existingController = activeAbortControllers.get(sessionId);
  if (existingController) {
    existingController.abort();
    activeAbortControllers.delete(sessionId);
  }

  const abortController = new AbortController();
  activeAbortControllers.set(sessionId, abortController);

  const session = await Session.get(sessionId);
  const resolvedAgentId = body.agentId ?? session?.agentId ?? "build";

  processUserMessage({
    sessionId,
    agentId: resolvedAgentId,
    userPrompt: body.content,
    fileParts: body.fileParts ?? [],
    abortController,
  })
    .catch((processingError) => {
      console.error(`[session] processing error for ${sessionId}:`, processingError);
    })
    .finally(() => {
      if (activeAbortControllers.get(sessionId) === abortController) {
        activeAbortControllers.delete(sessionId);
      }
    });

  return context.json({ status: "processing", sessionId });
});

sessionRouter.delete("/session/:id/messages", async (context) => {
  const sessionId = context.req.param("id");
  const session = await Session.get(sessionId);
  if (!session) return context.json({ error: "not found" }, 404);
  Session.clearMessages(sessionId);
  return context.json({ ok: true });
});

sessionRouter.post("/session/:id/question/reply", async (context) => {
  const sessionId = context.req.param("id");
  let body: { answers?: Record<string, string[]> };
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid JSON body" }, 400);
  }

  if (body.answers) {
    const replied = replyToQuestion(sessionId, body.answers);
    return context.json({ ok: replied });
  }

  const rejected = rejectQuestion(sessionId);
  return context.json({ ok: rejected });
});

sessionRouter.post("/session/:id/permission/reply", async (context) => {
  const sessionId = context.req.param("id");
  let body: { approved?: boolean };
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "invalid JSON body" }, 400);
  }

  const replied = replyToPermission(sessionId, body.approved ?? false);
  return context.json({ ok: replied });
});

sessionRouter.post("/session/:id/cancel", (context) => {
  const sessionId = context.req.param("id");
  const abortController = activeAbortControllers.get(sessionId);
  if (abortController) {
    abortController.abort();
    activeAbortControllers.delete(sessionId);
  }
  return context.json({ ok: true });
});
