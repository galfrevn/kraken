import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult } from "@kraken/sdk";
import { resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";

const tunnels = new Map<number, { subprocess: ReturnType<typeof Bun.spawn>; host: string }>();

function buildSshArgs(params: { port?: number; identity_file?: string }): string[] {
  const args: string[] = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];
  if (params.port !== undefined) {
    args.push("-p", String(params.port));
  }
  if (params.identity_file) {
    args.push("-i", params.identity_file);
  }
  return args;
}

function buildScpArgs(params: { port?: number; identity_file?: string }): string[] {
  const args: string[] = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];
  if (params.port !== undefined) {
    args.push("-P", String(params.port));
  }
  if (params.identity_file) {
    args.push("-i", params.identity_file);
  }
  return args;
}

function resolvePath(path: string, workingDirectory: string): string {
  if (isAbsolute(path)) return path;
  return resolve(workingDirectory, path);
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const sshExecTool: Tool = {
  definition: {
    name: "ssh_exec",
    description:
      "Execute a command on a remote host over SSH. Requires the system ssh client to be installed and keys configured.",
    parameters: [
      {
        name: "host",
        type: "string",
        description: 'Remote host in the form "user@hostname" or an SSH config alias.',
        required: true,
      },
      {
        name: "command",
        type: "string",
        description: "The command to execute on the remote host.",
        required: true,
      },
      {
        name: "port",
        type: "number",
        description: "SSH port. Default: 22.",
        required: false,
      },
      {
        name: "identity_file",
        type: "string",
        description: "Path to the SSH private key file.",
        required: false,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const host = parameters["host"] as string;
    const command = parameters["command"] as string;
    if (!host) return { success: false, output: "host parameter is required" };
    if (!command) return { success: false, output: "command parameter is required" };

    const port = parameters["port"] as number | undefined;
    const identity_file = parameters["identity_file"] as string | undefined;

    const args = ["ssh", ...buildSshArgs({ port, identity_file }), host, command];

    try {
      const { stdout, stderr, exitCode } = await run(args);
      if (exitCode !== 0) {
        return {
          success: false,
          output: stderr || stdout || `ssh exited with code ${exitCode}`,
          error: stderr,
        };
      }
      return { success: true, output: stdout || "(no output)" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to run ssh: ${message}` };
    }
  },
};

const sshUploadTool: Tool = {
  definition: {
    name: "ssh_upload",
    description:
      "Upload a local file to a remote host via scp. Relative local paths are resolved against the working directory.",
    parameters: [
      {
        name: "host",
        type: "string",
        description: 'Remote host in the form "user@hostname" or an SSH config alias.',
        required: true,
      },
      {
        name: "local_path",
        type: "string",
        description: "Path to the local file to upload.",
        required: true,
      },
      {
        name: "remote_path",
        type: "string",
        description: "Destination path on the remote host.",
        required: true,
      },
      {
        name: "port",
        type: "number",
        description: "SSH port. Default: 22.",
        required: false,
      },
      {
        name: "identity_file",
        type: "string",
        description: "Path to the SSH private key file.",
        required: false,
      },
    ],
  },
  async execute(parameters, context): Promise<ToolResult> {
    const host = parameters["host"] as string;
    const local_path = parameters["local_path"] as string;
    const remote_path = parameters["remote_path"] as string;
    if (!host) return { success: false, output: "host parameter is required" };
    if (!local_path) return { success: false, output: "local_path parameter is required" };
    if (!remote_path) return { success: false, output: "remote_path parameter is required" };

    const port = parameters["port"] as number | undefined;
    const identity_file = parameters["identity_file"] as string | undefined;
    const resolvedLocal = resolvePath(local_path, context.workingDirectory);

    const args = [
      "scp",
      ...buildScpArgs({ port, identity_file }),
      resolvedLocal,
      `${host}:${remote_path}`,
    ];

    try {
      const { stdout, stderr, exitCode } = await run(args);
      if (exitCode !== 0) {
        return {
          success: false,
          output: stderr || stdout || `scp exited with code ${exitCode}`,
          error: stderr,
        };
      }
      return {
        success: true,
        output: `Uploaded ${resolvedLocal} to ${host}:${remote_path}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to run scp: ${message}` };
    }
  },
};

const sshDownloadTool: Tool = {
  definition: {
    name: "ssh_download",
    description:
      "Download a file from a remote host via scp. Relative local paths are resolved against the working directory.",
    parameters: [
      {
        name: "host",
        type: "string",
        description: 'Remote host in the form "user@hostname" or an SSH config alias.',
        required: true,
      },
      {
        name: "remote_path",
        type: "string",
        description: "Path to the file on the remote host.",
        required: true,
      },
      {
        name: "local_path",
        type: "string",
        description: "Local destination path for the downloaded file.",
        required: true,
      },
      {
        name: "port",
        type: "number",
        description: "SSH port. Default: 22.",
        required: false,
      },
      {
        name: "identity_file",
        type: "string",
        description: "Path to the SSH private key file.",
        required: false,
      },
    ],
  },
  async execute(parameters, context): Promise<ToolResult> {
    const host = parameters["host"] as string;
    const remote_path = parameters["remote_path"] as string;
    const local_path = parameters["local_path"] as string;
    if (!host) return { success: false, output: "host parameter is required" };
    if (!remote_path) return { success: false, output: "remote_path parameter is required" };
    if (!local_path) return { success: false, output: "local_path parameter is required" };

    const port = parameters["port"] as number | undefined;
    const identity_file = parameters["identity_file"] as string | undefined;
    const resolvedLocal = resolvePath(local_path, context.workingDirectory);

    const args = [
      "scp",
      ...buildScpArgs({ port, identity_file }),
      `${host}:${remote_path}`,
      resolvedLocal,
    ];

    try {
      const { stdout, stderr, exitCode } = await run(args);
      if (exitCode !== 0) {
        return {
          success: false,
          output: stderr || stdout || `scp exited with code ${exitCode}`,
          error: stderr,
        };
      }
      return {
        success: true,
        output: `Downloaded ${host}:${remote_path} to ${resolvedLocal}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to run scp: ${message}` };
    }
  },
};

const sshTunnelTool: Tool = {
  definition: {
    name: "ssh_tunnel",
    description:
      "Create a local SSH port-forwarding tunnel (-L). The tunnel runs in the background. Returns the PID so it can be closed later with ssh_tunnel_close.",
    parameters: [
      {
        name: "host",
        type: "string",
        description: 'Remote host in the form "user@hostname" or an SSH config alias.',
        required: true,
      },
      {
        name: "local_port",
        type: "number",
        description: "Local port to listen on.",
        required: true,
      },
      {
        name: "remote_port",
        type: "number",
        description: "Remote port to forward to.",
        required: true,
      },
      {
        name: "port",
        type: "number",
        description: "SSH port. Default: 22.",
        required: false,
      },
      {
        name: "identity_file",
        type: "string",
        description: "Path to the SSH private key file.",
        required: false,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const host = parameters["host"] as string;
    const local_port = parameters["local_port"] as number;
    const remote_port = parameters["remote_port"] as number;
    if (!host) return { success: false, output: "host parameter is required" };
    if (local_port === undefined)
      return { success: false, output: "local_port parameter is required" };
    if (remote_port === undefined)
      return { success: false, output: "remote_port parameter is required" };

    if (tunnels.has(local_port)) {
      return {
        success: false,
        output: `A tunnel is already active on local port ${local_port}. Close it first with ssh_tunnel_close.`,
      };
    }

    const port = parameters["port"] as number | undefined;
    const identity_file = parameters["identity_file"] as string | undefined;

    const args = [
      "ssh",
      ...buildSshArgs({ port, identity_file }),
      "-L",
      `${local_port}:localhost:${remote_port}`,
      "-N",
      host,
    ];

    try {
      const subprocess = Bun.spawn(args, {
        stdio: ["ignore", "ignore", "ignore"],
      });

      tunnels.set(local_port, { subprocess, host });

      return {
        success: true,
        output: `SSH tunnel opened: localhost:${local_port} -> ${host}:${remote_port} (PID ${subprocess.pid})`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `Failed to create SSH tunnel: ${message}`,
      };
    }
  },
};

const sshTunnelCloseTool: Tool = {
  definition: {
    name: "ssh_tunnel_close",
    description:
      "Close an active SSH tunnel by its local port number. Kills the background SSH process.",
    parameters: [
      {
        name: "local_port",
        type: "number",
        description: "The local port of the tunnel to close.",
        required: true,
      },
    ],
  },
  async execute(parameters): Promise<ToolResult> {
    const local_port = parameters["local_port"] as number;
    if (local_port === undefined)
      return { success: false, output: "local_port parameter is required" };

    const tunnel = tunnels.get(local_port);
    if (!tunnel) {
      return {
        success: false,
        output: `No active tunnel found on local port ${local_port}.`,
      };
    }

    try {
      tunnel.subprocess.kill();
      tunnels.delete(local_port);
      return {
        success: true,
        output: `Tunnel on local port ${local_port} (to ${tunnel.host}) closed.`,
      };
    } catch (error) {
      tunnels.delete(local_port);
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `Error closing tunnel: ${message}`,
      };
    }
  },
};

const sshConfigListTool: Tool = {
  definition: {
    name: "ssh_config_list",
    description:
      "List SSH config hosts by parsing ~/.ssh/config. Shows Host entries with their HostName, User, Port, and IdentityFile if present.",
    parameters: [],
  },
  async execute(): Promise<ToolResult> {
    const configPath = resolve(homedir(), ".ssh", "config");

    if (!existsSync(configPath)) {
      return {
        success: false,
        output: `SSH config file not found at ${configPath}`,
      };
    }

    try {
      const content = readFileSync(configPath, "utf-8");
      const lines = content.split(/\r?\n/);

      const hosts: {
        host: string;
        hostname?: string;
        user?: string;
        port?: string;
        identityFile?: string;
      }[] = [];

      let current: (typeof hosts)[number] | null = null;

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;

        const match = line.match(/^(\S+)\s+(.+)$/);
        if (!match) continue;

        const key = match[1]!.toLowerCase();
        const value = match[2]!.trim();

        if (key === "host") {
          if (current) hosts.push(current);
          current = { host: value };
        } else if (current) {
          if (key === "hostname") current.hostname = value;
          else if (key === "user") current.user = value;
          else if (key === "port") current.port = value;
          else if (key === "identityfile") current.identityFile = value;
        }
      }
      if (current) hosts.push(current);

      if (hosts.length === 0) {
        return {
          success: true,
          output: "No Host entries found in SSH config.",
        };
      }

      const output = hosts
        .map((h) => {
          const parts = [`Host ${h.host}`];
          if (h.hostname) parts.push(`  HostName ${h.hostname}`);
          if (h.user) parts.push(`  User ${h.user}`);
          if (h.port) parts.push(`  Port ${h.port}`);
          if (h.identityFile) parts.push(`  IdentityFile ${h.identityFile}`);
          return parts.join("\n");
        })
        .join("\n\n");

      return { success: true, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: `Failed to read SSH config: ${message}`,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default definePlugin({
  name: "ssh",
  version: "0.1.0",
  description:
    "SSH tools for executing remote commands, transferring files via scp, managing port-forwarding tunnels, and listing SSH config hosts.",
  author: "kraken",

  toolDisplayNames: {
    ssh_exec: "SSH Execute",
    ssh_upload: "SCP Upload",
    ssh_download: "SCP Download",
    ssh_tunnel: "SSH Tunnel",
    ssh_tunnel_close: "Close SSH Tunnel",
    ssh_config_list: "List SSH Config",
  },

  tools: [
    sshExecTool,
    sshUploadTool,
    sshDownloadTool,
    sshTunnelTool,
    sshTunnelCloseTool,
    sshConfigListTool,
  ],

  promptExtension:
    "You have SSH tools from the 'ssh' plugin for remote server management.\n" +
    "- ssh_exec: Execute a command on a remote host via SSH. Provide host (e.g. 'user@hostname' or an SSH config alias) and the command to run.\n" +
    "- ssh_upload: Upload a local file to a remote host via scp. Relative local paths are resolved against the current working directory.\n" +
    "- ssh_download: Download a file from a remote host via scp. Relative local paths are resolved against the current working directory.\n" +
    "- ssh_tunnel: Create a local SSH port-forwarding tunnel (localhost:local_port -> remote host:remote_port). Runs in the background and returns the PID.\n" +
    "- ssh_tunnel_close: Close an active SSH tunnel by its local port number.\n" +
    "- ssh_config_list: Parse and list Host entries from ~/.ssh/config with their HostName, User, Port, and IdentityFile.\n" +
    "NOTE: These tools require the system SSH client (ssh, scp) to be installed and accessible. " +
    "SSH keys must be configured for passwordless authentication (or an ssh-agent must be running). " +
    "The ssh client is available by default on Windows 10+, macOS, and Linux.",

  activate: async () => {
    try {
      const result = Bun.spawnSync({
        cmd: ["ssh", "-V"],
        stdout: "pipe",
        stderr: "pipe",
      });
      // ssh -V prints to stderr
      const version =
        new TextDecoder().decode(result.stderr).trim() ||
        new TextDecoder().decode(result.stdout).trim();
      if (result.exitCode === 0 && version) {
        console.log(`[ssh] activated (${version})`);
      } else {
        console.log("[ssh] WARNING: SSH client not found on this system.");
      }
    } catch {
      console.log("[ssh] WARNING: Could not detect SSH installation.");
    }
  },

  deactivate: async () => {
    // Close all active tunnels on deactivation
    for (const [port, tunnel] of tunnels) {
      try {
        tunnel.subprocess.kill();
      } catch {
        // ignore errors when killing tunnels during deactivation
      }
      tunnels.delete(port);
    }
    console.log("[ssh] deactivated");
  },
});
