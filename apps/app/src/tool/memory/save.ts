import { z } from "zod";
import { basename } from "node:path";
import { defineTool } from "@/tool/tool.ts";
import { getDaemon } from "@/daemon/client.ts";
import { generateEmbedding } from "@/provider/embedding.ts";
import { scheduleEmbeddingRetry } from "@/tool/memory/embedding-queue.ts";
import { DaemonError, DaemonConnectionError } from "@kraken/sdk";

export const memorySaveTool = defineTool({
  id: "memory_save",
  description:
    "Save information to persistent memory. Persists across sessions. Example: memory_save({ title: 'User name is Alice', content: 'The user told me their name is Alice', type: 'preference' }). Use for user preferences, decisions, discoveries, or anything worth remembering.",
  parameters: z.object({
    title: z.string().describe("Short searchable title (required)"),
    content: z.string().describe("Full details to remember (required)"),
    type: z
      .string()
      .optional()
      .describe("Category: preference, decision, bugfix, discovery, etc. (default: learning)"),
    scope: z
      .enum(["project", "personal"])
      .optional()
      .describe("'project' (default) or 'personal' for cross-project info like user name"),
    topic_key: z
      .string()
      .optional()
      .describe("Stable key for updating same topic (e.g. 'user/name')"),
  }),
  async execute(args, context) {
    try {
      let embedding: number[] | null = null;
      try {
        embedding = await generateEmbedding(`${args.title} ${args.content}`);
      } catch {
        // embedding is optional, continue without it
      }

      const observation = await getDaemon().memory.observations.create({
        session_id: context.sessionId,
        type: args.type ?? "learning",
        title: args.title,
        content: args.content,
        project: basename(process.cwd()),
        scope: args.scope,
        topic_key: args.topic_key,
        embedding: embedding ?? undefined,
      });

      if (!embedding) {
        scheduleEmbeddingRetry({
          title: args.title,
          content: args.content,
          type: args.type ?? "learning",
          scope: args.scope,
          topicKey: args.topic_key ?? `auto/${observation.id}`,
          sessionId: context.sessionId,
        });
      }

      const action = observation.revision_count > 1 ? "updated" : "saved";

      return {
        title: `Memory ${action}`,
        content: `Observation #${observation.id} ${action}: ${args.title}`,
        metadata: { observationId: observation.id },
      };
    } catch (error) {
      if (error instanceof DaemonError) {
        return {
          title: "Memory save failed",
          content: `Daemon returned ${error.status}: ${error.body}`,
        };
      }
      if (error instanceof DaemonConnectionError) {
        return {
          title: "Memory save failed",
          content: `Could not reach daemon at ${error.url}. Is it running?`,
        };
      }
      return {
        title: "Memory save failed",
        content: `Unexpected error: ${error}`,
      };
    }
  },
});
