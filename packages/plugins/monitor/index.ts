import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult } from "@kraken/sdk";

const IS_WINDOWS = process.platform === "win32";

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = IS_WINDOWS ? ["cmd", "/c", ...args] : args;
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

const monitorProcessTool: Tool = {
  definition: {
    name: "monitor_process",
    description:
      "Run a shell command and capture its output. The command is killed after the specified timeout. " +
      "Useful for running dev servers briefly to check startup output or running quick diagnostic commands.",
    parameters: [
      {
        name: "command",
        type: "string",
        description: "The shell command to execute.",
        required: true,
      },
      {
        name: "timeout",
        type: "number",
        description: "Maximum time in seconds to wait before killing the process. Default: 10.",
        required: false,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const command = parameters["command"] as string;
    if (!command) return { success: false, output: "command parameter is required" };

    const timeoutSeconds = (parameters["timeout"] as number) ?? 10;
    const timeoutMs = timeoutSeconds * 1000;

    try {
      const cmd = IS_WINDOWS ? ["cmd", "/c", command] : ["sh", "-c", command];
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });

      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* process may have already exited */
        }
      }, timeoutMs);

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const output = [
        stdout.trim() && `STDOUT:\n${stdout.trim()}`,
        stderr.trim() && `STDERR:\n${stderr.trim()}`,
        `Exit code: ${exitCode}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      return { success: exitCode === 0, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to run command: ${message}` };
    }
  },
};

const monitorPortTool: Tool = {
  definition: {
    name: "monitor_port",
    description:
      "Check if a TCP port is in use and identify which process owns it. " +
      "Works cross-platform (lsof on Unix, netstat on Windows).",
    parameters: [
      {
        name: "port",
        type: "number",
        description: "The port number to check.",
        required: true,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const port = parameters["port"] as number;
    if (!port) return { success: false, output: "port parameter is required" };

    try {
      let result;
      if (IS_WINDOWS) {
        result = await run(["netstat", "-ano", "|", "findstr", `:${port}`]);
      } else {
        result = await run(["lsof", "-i", `:${port}`]);
      }

      if (result.exitCode !== 0 && !result.stdout) {
        return {
          success: true,
          output: `Port ${port} is not in use.`,
        };
      }

      return {
        success: true,
        output: result.stdout
          ? `Port ${port} is in use:\n${result.stdout}`
          : `Port ${port} is not in use.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to check port: ${message}` };
    }
  },
};

const monitorTailTool: Tool = {
  definition: {
    name: "monitor_tail",
    description:
      "Read the last N lines of a log file using Bun.file. " +
      "Useful for checking recent log output without loading the entire file.",
    parameters: [
      {
        name: "path",
        type: "string",
        description: "Absolute or relative path to the log file.",
        required: true,
      },
      {
        name: "lines",
        type: "number",
        description: "Number of lines to read from the end of the file. Default: 50.",
        required: false,
      },
    ],
  },
  async execute(parameters, context): Promise<ToolResult> {
    const filePath = parameters["path"] as string;
    if (!filePath) return { success: false, output: "path parameter is required" };

    const numLines = (parameters["lines"] as number) ?? 50;

    try {
      const { resolve } = await import("node:path");
      const resolvedPath = resolve(context.workingDirectory, filePath);
      const file = Bun.file(resolvedPath);
      const exists = await file.exists();

      if (!exists) {
        return { success: false, output: `File not found: ${resolvedPath}` };
      }

      const content = await file.text();
      const allLines = content.split("\n");
      const tailLines = allLines.slice(-numLines);

      return {
        success: true,
        output:
          `Last ${Math.min(numLines, allLines.length)} lines of ${resolvedPath}:\n\n` +
          tailLines.join("\n"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to read file: ${message}` };
    }
  },
};

const monitorWatchTool: Tool = {
  definition: {
    name: "monitor_watch",
    description:
      "Run a command and capture its output for a specified duration, then kill it. " +
      "Useful for watching build output, server startup logs, or streaming processes.",
    parameters: [
      {
        name: "command",
        type: "string",
        description: "The shell command to execute.",
        required: true,
      },
      {
        name: "duration",
        type: "number",
        description: "How many seconds to let the command run before killing it. Default: 10.",
        required: false,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const command = parameters["command"] as string;
    if (!command) return { success: false, output: "command parameter is required" };

    const duration = (parameters["duration"] as number) ?? 10;
    const durationMs = duration * 1000;

    try {
      const cmd = IS_WINDOWS ? ["cmd", "/c", command] : ["sh", "-c", command];
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });

      await new Promise((resolve) => setTimeout(resolve, durationMs));

      let killed = false;
      try {
        proc.kill();
        killed = true;
      } catch {
        /* process may have already exited */
      }

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      const output = [
        `Watched command for ${duration}s${killed ? " (process killed)" : " (process exited early)"}`,
        stdout.trim() && `STDOUT:\n${stdout.trim()}`,
        stderr.trim() && `STDERR:\n${stderr.trim()}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      return { success: true, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to watch command: ${message}` };
    }
  },
};

const monitorProcessesTool: Tool = {
  definition: {
    name: "monitor_processes",
    description:
      "List running processes on the system. " +
      "Cross-platform: uses 'ps aux' on Unix and 'tasklist' on Windows. " +
      "Optionally filter output by a search term.",
    parameters: [
      {
        name: "filter",
        type: "string",
        description:
          "Optional text to filter process list (case-insensitive grep). Only matching lines are returned.",
        required: false,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    try {
      let result;
      if (IS_WINDOWS) {
        result = await run(["tasklist"]);
      } else {
        result = await run(["ps", "aux"]);
      }

      if (result.exitCode !== 0) {
        return {
          success: false,
          output: result.stderr || "Failed to list processes.",
        };
      }

      let output = result.stdout;
      const filter = parameters["filter"] as string | undefined;

      if (filter) {
        const lines = output.split("\n");
        const header = lines[0] ?? "";
        const filterLower = filter.toLowerCase();
        const matched = lines.slice(1).filter((line) => line.toLowerCase().includes(filterLower));

        output =
          matched.length > 0
            ? `${header}\n${matched.join("\n")}`
            : `No processes matching "${filter}" found.`;
      }

      return { success: true, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `Failed to list processes: ${message}`,
      };
    }
  },
};

export default definePlugin({
  name: "monitor",
  version: "0.1.0",
  description:
    "Terminal monitoring tools for inspecting processes, ports, log files, and command output.",
  author: "kraken",

  toolDisplayNames: {
    monitor_process: "Run Process",
    monitor_port: "Check Port",
    monitor_tail: "Tail Log",
    monitor_watch: "Watch Command",
    monitor_processes: "List Processes",
  },

  tools: [
    monitorProcessTool,
    monitorPortTool,
    monitorTailTool,
    monitorWatchTool,
    monitorProcessesTool,
  ],

  promptExtension:
    "You have terminal monitoring tools from the 'monitor' plugin.\n" +
    "- monitor_process: Run a command and capture output (with timeout). Use for quick diagnostic commands or briefly starting a dev server to check its output.\n" +
    "- monitor_port: Check if a port is in use and which process owns it. Use before starting servers to avoid port conflicts, or to debug connection issues.\n" +
    "- monitor_tail: Read the last N lines of a log file. Use to check recent log output without loading the entire file. Reads via Bun.file, not shell commands.\n" +
    "- monitor_watch: Run a command for a specified duration and capture all output, then kill it. Use for watching build output, server startup, or streaming processes.\n" +
    "- monitor_processes: List running processes with optional text filter. Use to find running servers, check resource usage, or verify a process is alive.",
});
