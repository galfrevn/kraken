import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { WorkerService } from "@gen/agent/v1/worker_pb.ts";
import type { GetTaskResponse } from "@gen/agent/v1/worker_pb.ts";

export type DaemonWorkerClient = Client<typeof WorkerService>;

export function createDaemonWorkerClient(daemonUrl: string): DaemonWorkerClient {
  const transport = createGrpcTransport({ baseUrl: daemonUrl });
  return createClient(WorkerService, transport);
}

export interface TaskDetails {
  taskId: string;
  name: string;
  description: string;
  workingDirectory: string;
  retryContext: string;
  attempt: number;
  model: string;
  provider: string;
  temperature: number;
  maxTokens: number;
}

export async function fetchTaskDetails(
  daemonWorkerClient: DaemonWorkerClient,
  taskId: string,
): Promise<TaskDetails> {
  const response: GetTaskResponse = await daemonWorkerClient.getTask({ taskId });

  return {
    taskId: response.taskId,
    name: response.name,
    description: response.description,
    workingDirectory: response.workingDir,
    retryContext: response.retryContext,
    attempt: response.attempt,
    model: response.model,
    provider: response.provider,
    temperature: response.temperature,
    maxTokens: response.maxTokens,
  };
}
