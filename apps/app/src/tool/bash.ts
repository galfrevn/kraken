import { z } from "zod";
import { spawn } from "bun";
import { defineTool } from "@/tool/tool.ts";
import { bashCommandTargetsSecretFile, BLOCKED_FILE_ACCESS_MESSAGE } from "@/tool/security.ts";
import { Bus, Events } from "@/bus/index.ts";

const BASH_TIMEOUT_MILLISECONDS = 120_000;
const MAX_OUTPUT_LENGTH = 50_000;
const PROGRESS_THROTTLE_MS = 100;

export const bashTool = defineTool({
  id: "bash",
  description:
    "Execute a shell command and return its output. Use this for running programs, installing packages, searching files, git operations, and any other system commands.",
  parameters: z.object({
    command: z.string().describe("The shell command to execute"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default: 120000)"),
  }),
  async execute(args, context) {
    if (bashCommandTargetsSecretFile(args.command)) {
      return { title: args.command, content: BLOCKED_FILE_ACCESS_MESSAGE };
    }

    const timeoutMilliseconds = args.timeout ?? BASH_TIMEOUT_MILLISECONDS;
    const shellCommand = ["bash", "-c", args.command];

    const childProcess = spawn({
      cmd: shellCommand,
      cwd: context.workingDirectory,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const abortHandler = () => childProcess.kill();
    context.abortSignal.addEventListener("abort", abortHandler, { once: true });

    const timeoutId = setTimeout(() => childProcess.kill(), timeoutMilliseconds);

    let output = "";
    let lastProgressTimestamp = 0;
    const decoder = new TextDecoder();

    const stdoutReader = childProcess.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        output += chunk;

        const now = Date.now();
        if (now - lastProgressTimestamp >= PROGRESS_THROTTLE_MS) {
          lastProgressTimestamp = now;
          Bus.publish(Events.Tool.Progress, {
            sessionId: context.sessionId,
            messageId: context.messageId,
            toolName: "bash",
            command: args.command,
            output,
          });
        }
      }
    } finally {
      stdoutReader.releaseLock();
    }

    const exitCode = await childProcess.exited;
    clearTimeout(timeoutId);
    context.abortSignal.removeEventListener("abort", abortHandler);

    const standardError = await new Response(childProcess.stderr).text();

    let combinedOutput = output;
    if (standardError) {
      combinedOutput += (combinedOutput ? "\n" : "") + standardError;
    }
    if (combinedOutput.length > MAX_OUTPUT_LENGTH) {
      combinedOutput = combinedOutput.slice(0, MAX_OUTPUT_LENGTH) + "\n... (truncated)";
    }

    const exitLabel = exitCode !== 0 ? `[exit code: ${exitCode}]\n` : "";

    return {
      title: args.command,
      content: `${exitLabel}${combinedOutput || "(no output)"}`,
      metadata: { exitCode },
    };
  },
});
