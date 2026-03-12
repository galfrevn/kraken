import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult } from "@kraken/sdk";

const IS_WINDOWS = process.platform === "win32";

async function run(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = IS_WINDOWS ? ["cmd", "/c", ...args] : args;
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function dockerRun(args: string[]): Promise<ToolResult> {
  try {
    const { stdout, stderr, exitCode } = await run(["docker", ...args]);
    if (exitCode !== 0) {
      return {
        success: false,
        output: stderr || stdout || `docker exited with code ${exitCode}`,
        error: stderr,
      };
    }
    return { success: true, output: stdout };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to run docker: ${message}` };
  }
}

async function composeRun(args: string[]): Promise<ToolResult> {
  try {
    const { stdout, stderr, exitCode } = await run([
      "docker",
      "compose",
      ...args,
    ]);
    if (exitCode !== 0) {
      return {
        success: false,
        output: stderr || stdout || `docker compose exited with code ${exitCode}`,
        error: stderr,
      };
    }
    return { success: true, output: stdout || "Done." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      output: `Failed to run docker compose: ${message}`,
    };
  }
}

const dockerPsTool: Tool = {
  definition: {
    name: "docker_ps",
    description:
      "List running Docker containers. Use the 'all' parameter to include stopped containers.",
    parameters: [
      {
        name: "all",
        type: "boolean",
        description:
          "If true, show all containers (including stopped). Default: false.",
        required: false,
      },
    ],
  },
  async execute(parameters) {
    const all = parameters["all"] === true;
    const args = all ? ["ps", "--all"] : ["ps"];
    return dockerRun(args);
  },
};

const dockerLogsTool: Tool = {
  definition: {
    name: "docker_logs",
    description:
      "Get logs from a Docker container. Optionally limit the number of lines returned.",
    parameters: [
      {
        name: "container",
        type: "string",
        description: "Container name or ID.",
        required: true,
      },
      {
        name: "tail",
        type: "number",
        description:
          "Number of lines to show from the end of the logs. Default: all lines.",
        required: false,
      },
    ],
  },
  async execute(parameters) {
    const container = parameters["container"] as string;
    if (!container) return { success: false, output: "container parameter is required" };
    const tail = parameters["tail"] as number | undefined;
    const args = ["logs"];
    if (tail !== undefined) args.push("--tail", String(tail));
    args.push(container);
    return dockerRun(args);
  },
};

const dockerExecTool: Tool = {
  definition: {
    name: "docker_exec",
    description: "Execute a command inside a running Docker container.",
    parameters: [
      {
        name: "container",
        type: "string",
        description: "Container name or ID.",
        required: true,
      },
      {
        name: "command",
        type: "string",
        description:
          "The command to execute inside the container (e.g. 'ls -la /app').",
        required: true,
      },
    ],
  },
  async execute(parameters) {
    const container = parameters["container"] as string;
    const command = parameters["command"] as string;
    if (!container) return { success: false, output: "container parameter is required" };
    if (!command) return { success: false, output: "command parameter is required" };
    return dockerRun(["exec", container, "sh", "-c", command]);
  },
};

const dockerRestartTool: Tool = {
  definition: {
    name: "docker_restart",
    description: "Restart a Docker container.",
    parameters: [
      {
        name: "container",
        type: "string",
        description: "Container name or ID.",
        required: true,
      },
    ],
  },
  async execute(parameters) {
    const container = parameters["container"] as string;
    if (!container) return { success: false, output: "container parameter is required" };
    return dockerRun(["restart", container]);
  },
};

const dockerStopTool: Tool = {
  definition: {
    name: "docker_stop",
    description: "Stop a running Docker container.",
    parameters: [
      {
        name: "container",
        type: "string",
        description: "Container name or ID.",
        required: true,
      },
    ],
  },
  async execute(parameters) {
    const container = parameters["container"] as string;
    if (!container) return { success: false, output: "container parameter is required" };
    return dockerRun(["stop", container]);
  },
};

const dockerImagesTool: Tool = {
  definition: {
    name: "docker_images",
    description: "List locally available Docker images.",
    parameters: [],
  },
  async execute() {
    return dockerRun(["images"]);
  },
};

const dockerComposeUpTool: Tool = {
  definition: {
    name: "docker_compose_up",
    description:
      "Run docker compose up to start services defined in a compose file.",
    parameters: [
      {
        name: "service",
        type: "string",
        description:
          "Specific service name to start. If omitted, all services are started.",
        required: false,
      },
      {
        name: "detach",
        type: "boolean",
        description: "Run containers in the background. Default: true.",
        required: false,
      },
    ],
  },
  async execute(parameters) {
    const service = parameters["service"] as string | undefined;
    const detach = parameters["detach"] !== false;
    const args = ["up"];
    if (detach) args.push("-d");
    if (service) args.push(service);
    return composeRun(args);
  },
};

const dockerComposeDownTool: Tool = {
  definition: {
    name: "docker_compose_down",
    description:
      "Run docker compose down to stop and remove containers, networks, and volumes defined in a compose file.",
    parameters: [],
  },
  async execute() {
    return composeRun(["down"]);
  },
};

export default definePlugin({
  name: "docker",
  version: "0.1.0",
  description:
    "Docker management tools for listing, inspecting, and controlling containers, images, and compose services.",
  author: "kraken",

  toolDisplayNames: {
    docker_ps: "List Containers",
    docker_logs: "Container Logs",
    docker_exec: "Exec in Container",
    docker_restart: "Restart Container",
    docker_stop: "Stop Container",
    docker_images: "List Images",
    docker_compose_up: "Compose Up",
    docker_compose_down: "Compose Down",
  },

  tools: [
    dockerPsTool,
    dockerLogsTool,
    dockerExecTool,
    dockerRestartTool,
    dockerStopTool,
    dockerImagesTool,
    dockerComposeUpTool,
    dockerComposeDownTool,
  ],

  promptExtension:
    "You have Docker management tools from the 'docker' plugin.\n" +
    "- docker_ps: List running containers. Pass all=true to include stopped containers.\n" +
    "- docker_logs: Fetch logs from a container. Use 'tail' to limit output (e.g. tail=100 for last 100 lines).\n" +
    "- docker_exec: Run a shell command inside a running container. The command is executed via 'sh -c'.\n" +
    "- docker_restart: Restart a container by name or ID.\n" +
    "- docker_stop: Stop a running container by name or ID.\n" +
    "- docker_images: List all locally available Docker images.\n" +
    "- docker_compose_up: Start services from a docker-compose file. Runs detached by default. Specify 'service' to start a single service.\n" +
    "- docker_compose_down: Stop and remove all compose services, networks, and volumes.\n" +
    "NOTE: These tools require Docker to be installed and the Docker daemon to be running.",

  activate: async () => {
    try {
      const cmd = IS_WINDOWS
        ? ["cmd", "/c", "docker", "version", "--format", "{{.Client.Version}}"]
        : ["docker", "version", "--format", "{{.Client.Version}}"];
      const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode === 0) {
        const version = new TextDecoder().decode(result.stdout).trim();
        console.log(`[docker] activated (Docker ${version})`);
      } else {
        console.log(
          "[docker] WARNING: Docker CLI not found or daemon not running.",
        );
      }
    } catch {
      console.log(
        "[docker] WARNING: Could not detect Docker installation.",
      );
    }
  },

  deactivate: async () => {
    console.log("[docker] deactivated");
  },
});
