import { spawnCommand } from "@/tools/spawn.ts";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/schema.ts";

const GIT_TIMEOUT_MILLISECONDS = 15_000;

const SHELL_METACHARACTERS = /[;&|`$(){}><!\n\r]/;

function sanitizeGitPath(value: string): string {
  if (SHELL_METACHARACTERS.test(value)) {
    throw new Error(`invalid characters in path: ${value}`);
  }
  if (
    value !== "." &&
    (value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:/.test(value))
  ) {
    throw new Error(`absolute paths are not allowed: ${value}`);
  }
  return value;
}

async function runGitCommand(
  args: string[],
  workingDirectory: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const commandPromise = spawnCommand("git", args, workingDirectory);

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("git command timed out")), GIT_TIMEOUT_MILLISECONDS),
  );

  return await Promise.race([commandPromise, timeoutPromise]);
}

export const gitStatusTool: Tool = {
  definition: {
    name: "git_status",
    description: "Show branch, staged/unstaged changes, and untracked files.",
    parameters: [],
  },

  async execute(
    _parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    try {
      const branchResult = await runGitCommand(
        ["branch", "--show-current"],
        context.workingDirectory,
      );
      const statusResult = await runGitCommand(["status", "--short"], context.workingDirectory);

      if (statusResult.exitCode !== 0) {
        return { success: false, output: "", error: statusResult.stderr || "not a git repository" };
      }

      const branch = branchResult.stdout || "(detached HEAD)";
      const changes = statusResult.stdout || "(no changes)";

      return { success: true, output: `branch: ${branch}\n\n${changes}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: message };
    }
  },
};

export const gitDiffTool: Tool = {
  definition: {
    name: "git_diff",
    description: "Show git diff. Defaults to unstaged changes.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Specific file or directory to diff (default: all files)",
        required: false,
      },
      {
        name: "staged",
        type: "boolean",
        description: "Show staged changes instead of unstaged (default: false)",
        required: false,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const filePath = parameters["path"] as string | undefined;
    const staged = parameters["staged"] === true || parameters["staged"] === "true";

    const args = ["diff", "--stat", "--patch"];
    if (staged) args.push("--cached");
    if (filePath) args.push("--", sanitizeGitPath(filePath));

    try {
      const result = await runGitCommand(args, context.workingDirectory);

      if (result.exitCode !== 0) {
        return { success: false, output: "", error: result.stderr || "git diff failed" };
      }

      const output = result.stdout || "(no changes)";
      const lines = output.split(/\r?\n/);

      if (lines.length > 300) {
        return {
          success: true,
          output:
            lines.slice(0, 300).join("\n") + `\n\n... truncated (${lines.length - 300} more lines)`,
        };
      }

      return { success: true, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: message };
    }
  },
};

export const gitCommitTool: Tool = {
  definition: {
    name: "git_commit",
    description: "Stage files and create a git commit.",
    parameters: [
      { name: "message", type: "string", description: "Commit message", required: true },
      {
        name: "files",
        type: "string",
        description: "Space-separated list of files to stage (default: all changes with '.')",
        required: false,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const message = parameters["message"] as string;
    const files = (parameters["files"] as string) || ".";

    if (!message) {
      return { success: false, output: "", error: "commit message is required" };
    }

    try {
      const sanitizedFiles = files.split(/\s+/).map(sanitizeGitPath);
      const addResult = await runGitCommand(["add", ...sanitizedFiles], context.workingDirectory);
      if (addResult.exitCode !== 0) {
        return { success: false, output: "", error: `git add failed: ${addResult.stderr}` };
      }

      const commitResult = await runGitCommand(["commit", "-m", message], context.workingDirectory);

      if (commitResult.exitCode !== 0) {
        return { success: false, output: "", error: commitResult.stderr || "git commit failed" };
      }

      return { success: true, output: commitResult.stdout };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: errorMessage };
    }
  },
};

export const gitLogTool: Tool = {
  definition: {
    name: "git_log",
    description: "Show recent git commit history.",
    parameters: [
      {
        name: "count",
        type: "number",
        description: "Number of commits to show (default: 10, max: 50)",
        required: false,
      },
      {
        name: "path",
        type: "string",
        description: "Show commits affecting a specific file or directory",
        required: false,
      },
    ],
  },

  async execute(
    parameters: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const count = Math.min(Math.max(Number(parameters["count"]) || 10, 1), 50);
    const filePath = parameters["path"] as string | undefined;

    const args = ["log", "--oneline", "--decorate", "-n", String(count)];
    if (filePath) args.push("--", sanitizeGitPath(filePath));

    try {
      const result = await runGitCommand(args, context.workingDirectory);

      if (result.exitCode !== 0) {
        return { success: false, output: "", error: result.stderr || "git log failed" };
      }

      return { success: true, output: result.stdout || "(no commits)" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: message };
    }
  },
};
