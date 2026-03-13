import { $ } from "bun";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";
import {
  evaluateCommandPolicy,
  formatPolicyDenial,
  DEFAULT_COMMAND_POLICY,
  type CommandPolicyConfiguration,
} from "@/tools/policy.ts";

const COMMAND_TIMEOUT_MILLISECONDS = 30_000;
const OUTPUT_MAX_CHARACTERS = 16_000;
const IS_WINDOWS = process.platform === "win32";

export function createRunCommandTool(policyConfiguration?: CommandPolicyConfiguration): Tool {
  const policy = policyConfiguration ?? DEFAULT_COMMAND_POLICY;

  return {
    definition: {
      name: "run_command",
      description:
        "Execute a command in the working directory. " +
        "Uses cmd on Windows and sh on Unix. " +
        "Commands are evaluated against a security policy: destructive operations are blocked. " +
        "Prefer specific tools (read_file, edit_file, git_status) when available. Has a 30 second timeout.",
      requiresConfirmation: true,
      parameters: [
        {
          name: "command",
          type: "string",
          description: "The shell command to execute",
          required: true,
        },
      ],
    },

    async execute(
      parameters: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      const command = parameters["command"] as string;

      if (!command || command.trim().length === 0) {
        return { success: false, output: "", error: "command is required" };
      }

      const policyResult = evaluateCommandPolicy(command, policy);

      if (!policyResult.allowed) {
        return {
          success: false,
          output: "",
          error: formatPolicyDenial(policyResult, command),
        };
      }

      const riskWarning =
        policyResult.riskLevel === "dangerous" ? `⚠ risk: ${policyResult.reason}\n---\n` : "";

      try {
        const commandPromise = IS_WINDOWS
          ? $`cmd /c ${command}`.cwd(context.workingDirectory).quiet().nothrow()
          : $`sh -c ${command}`.cwd(context.workingDirectory).quiet().nothrow();

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("command timed out after 30 seconds")),
            COMMAND_TIMEOUT_MILLISECONDS,
          ),
        );

        const result = await Promise.race([commandPromise, timeoutPromise]);

        const stdout = result.stdout.toString().trim();
        const stderr = result.stderr.toString().trim();
        let combinedOutput = [stdout, stderr].filter(Boolean).join("\n---stderr---\n");

        if (combinedOutput.length > OUTPUT_MAX_CHARACTERS) {
          combinedOutput =
            combinedOutput.slice(0, OUTPUT_MAX_CHARACTERS) + "\n... (output truncated)";
        }

        const output = riskWarning + (combinedOutput || "(no output)");

        if (result.exitCode !== 0) {
          return {
            success: false,
            output,
            error: `command exited with code ${result.exitCode}`,
          };
        }

        return { success: true, output };
      } catch (executionError) {
        const message =
          executionError instanceof Error ? executionError.message : String(executionError);
        return { success: false, output: "", error: `command failed: ${message}` };
      }
    },
  };
}
