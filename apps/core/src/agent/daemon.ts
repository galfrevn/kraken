import { AgentExecutionLoop } from "@/agent/loop.ts";
import type { TaskQueueManager } from "@/queue/manager.ts";
import { TASK_EVENT_TYPE } from "@/queue/schema.ts";
import type { AgentLoopResult } from "@/agent/loop.ts";

const POLL_INTERVAL_MILLISECONDS = 2_000;
const DEFAULT_MAX_CONCURRENT_TASKS = 1;

type LogFunction = (...args: unknown[]) => void;

export interface TaskRunnerDaemonConfiguration {
  maxConcurrentTasks?: number;
  silent?: boolean;
}

export class TaskRunnerDaemon {
  private executionLoop: AgentExecutionLoop;
  private taskQueueManager: TaskQueueManager;
  private maxConcurrentTasks: number;
  private running: boolean = false;
  private activeTaskCount: number = 0;
  private log: LogFunction;
  private logError: LogFunction;

  constructor(
    executionLoop: AgentExecutionLoop,
    taskQueueManager: TaskQueueManager,
    configuration?: TaskRunnerDaemonConfiguration,
  ) {
    this.executionLoop = executionLoop;
    this.taskQueueManager = taskQueueManager;
    this.maxConcurrentTasks = configuration?.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;

    const noop = () => {};
    this.log = configuration?.silent ? noop : console.log.bind(console);
    this.logError = configuration?.silent ? noop : console.error.bind(console);
  }

  async start(): Promise<void> {
    this.running = true;
    this.log(`  task runner daemon: started (max concurrent: ${this.maxConcurrentTasks})`);

    this.taskQueueManager.addEventListener((event) => {
      if (event.type === TASK_EVENT_TYPE.submitted || event.type === TASK_EVENT_TYPE.approved) {
        this.tryProcessNextTask();
      }
    });

    this.tryProcessNextTask();

    while (this.running) {
      await Bun.sleep(POLL_INTERVAL_MILLISECONDS);
      this.tryProcessNextTask();
    }
  }

  stop(): void {
    this.running = false;
  }

  private tryProcessNextTask(): void {
    if (!this.running) return;
    if (this.activeTaskCount >= this.maxConcurrentTasks) return;

    const nextTask = this.taskQueueManager.getNextPendingTask();
    if (!nextTask) return;

    if (nextTask.approvalPolicy === "review_required") {
      return;
    }

    this.activeTaskCount += 1;
    this.processTask(nextTask.id);
  }

  private async processTask(taskId: string): Promise<void> {
    try {
      const result = await this.executionLoop.executeTask(taskId);
      this.logTaskResult(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logError(`  task runner error: ${errorMessage}`);
    } finally {
      this.activeTaskCount -= 1;
      this.tryProcessNextTask();
    }
  }

  private logTaskResult(result: AgentLoopResult): void {
    const status = result.success ? "completed" : "failed";
    const summary =
      result.output.length > 120 ? result.output.slice(0, 120) + "..." : result.output;
    this.log(
      `  task [${status}]: ${result.taskId.slice(0, 8)} | ${result.iterations} iterations, ${result.totalToolCalls} tool calls`,
    );
    this.log(`    output: ${summary}`);
  }
}
