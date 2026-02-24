import {
  startCommand,
  statusCommand,
  tasksCommand,
  reviewsCommand,
  approveCommand,
  rejectCommand,
  initCommand,
  runCommand,
} from "@/cli/commands.ts";

const HELP_TEXT = `
kraken - autonomous developer agent

usage:
  kraken <command>

commands:
  init      create a kraken.yml configuration file in the current directory
  start     start the agent core (connects to scheduler & gateway)
  run       run a one-off prompt (kraken run "your prompt")
  status    show agent and service status
  tasks     list recent tasks
  reviews   list tasks awaiting approval
  approve   approve a task for execution (kraken approve <task-id>)
  reject    reject a task (kraken reject <task-id> [reason])
  help      show this help message

tui:
  interactive terminal interface: bun run apps/tui/src/index.tsx

environment variables:
  KRAKEN_CONFIGURATION_FILE    path to configuration file (default: kraken.yml)
  KRAKEN_SCHEDULER_URL         scheduler gRPC address (default: http://localhost:50051)
  KRAKEN_GATEWAY_URL           gateway gRPC address (default: http://localhost:50052)
  KRAKEN_DATABASE_PATH         SQLite database path (default: .kraken/agent.db)
  KRAKEN_OPENROUTER_API_KEY    OpenRouter API key
  KRAKEN_LLM_MODEL             LLM model identifier
`;

async function main(): Promise<void> {
  const command = Bun.argv[2];

  switch (command) {
    case "init":
      await initCommand();
      break;
    case "start":
      await startCommand();
      break;
    case "run":
      await runCommand(Bun.argv.slice(3).join(" "));
      break;
    case "status":
      await statusCommand();
      break;
    case "tasks":
      await tasksCommand();
      break;
    case "reviews":
      await reviewsCommand();
      break;
    case "approve":
      await approveCommand(Bun.argv[3] ?? "");
      break;
    case "reject":
      await rejectCommand(Bun.argv[3] ?? "", Bun.argv.slice(4).join(" "));
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP_TEXT.trim());
      break;
    default:
      console.error(`unknown command: ${command}`);
      console.log(HELP_TEXT.trim());
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
