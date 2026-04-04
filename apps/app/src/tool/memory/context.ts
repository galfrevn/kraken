import { z } from "zod";
import { basename } from "node:path";
import { defineTool } from "@/tool/tool.ts";
import { getDaemon } from "@/daemon/client.ts";
import { DaemonError, DaemonConnectionError } from "@kraken/sdk";

export const memoryContextTool = defineTool({
  id: "memory_context",
  description:
    "Get all recent memories and session summaries for the current project. Takes no required parameters. Use to see what was done in previous sessions.",
  parameters: z.object({
    project: z.string().optional().describe("Project name (auto-detected, rarely needed)"),
  }),
  async execute(args, _context) {
    const project = args.project || basename(process.cwd());

    try {
      const context = await getDaemon().memory.context({ project });

      if (context.sessions.length === 0 && context.observations.length === 0) {
        return {
          title: "No memory context",
          content: `No previous session context found for project "${project}".`,
        };
      }

      const parts: string[] = [];

      if (context.sessions.length > 0) {
        parts.push("## Previous Sessions\n");
        for (const session of context.sessions) {
          const date = session.ended_at || session.started_at;
          parts.push(`### ${date}`);
          if (session.summary) {
            parts.push(session.summary);
          }
          parts.push("");
        }
      }

      if (context.observations.length > 0) {
        parts.push("## Recent Observations\n");
        for (const observation of context.observations) {
          const revisionNote =
            observation.revision_count > 1 ? ` (rev ${observation.revision_count})` : "";
          parts.push(`- [${observation.type}] ${observation.title}${revisionNote}`);
          parts.push(`  ${observation.content}`);
        }
      }

      return {
        title: `Context for ${project}`,
        content: parts.join("\n"),
        metadata: {
          sessionCount: context.sessions.length,
          observationCount: context.observations.length,
        },
      };
    } catch (error) {
      if (error instanceof DaemonError) {
        return {
          title: "Memory context failed",
          content: `Daemon returned ${error.status}: ${error.body}`,
        };
      }
      if (error instanceof DaemonConnectionError) {
        return {
          title: "Memory context failed",
          content: `Could not reach daemon at ${error.url}. Is it running?`,
        };
      }
      return {
        title: "Memory context failed",
        content: `Unexpected error: ${error}`,
      };
    }
  },
});
