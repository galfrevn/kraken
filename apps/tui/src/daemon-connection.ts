import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
  DaemonService,
  AgentChatService,
  type GetStatusResponse,
  type DaemonServiceListTasksResponse,
  type GetTaskDetailResponse,
  type DaemonServiceSubmitTaskResponse,
  type DaemonServiceCancelTaskResponse,
  type ChatOutput,
} from "@gen/agent/v1/daemon_pb.ts";

export type DaemonServiceClient = Client<typeof DaemonService>;
export type AgentChatServiceClient = Client<typeof AgentChatService>;

export class DaemonConnection {
  private daemonServiceClient: DaemonServiceClient;
  private agentChatServiceClient: AgentChatServiceClient;
  private daemonUrl: string;
  private connectionEstablished: boolean = false;

  constructor(daemonUrl: string) {
    this.daemonUrl = daemonUrl;
    const grpcTransport = createGrpcTransport({ baseUrl: daemonUrl });
    this.daemonServiceClient = createClient(DaemonService, grpcTransport);
    this.agentChatServiceClient = createClient(AgentChatService, grpcTransport);
  }

  async connect(): Promise<boolean> {
    try {
      const statusResponse = await this.getStatus();
      this.connectionEstablished = statusResponse.healthy;
      return this.connectionEstablished;
    } catch {
      this.connectionEstablished = false;
      return false;
    }
  }

  async getStatus(): Promise<GetStatusResponse> {
    const response = await this.daemonServiceClient.getStatus({});
    return response;
  }

  async submitTask(
    taskName: string,
    taskDescription: string,
    taskPriority: number,
  ): Promise<DaemonServiceSubmitTaskResponse> {
    return await this.daemonServiceClient.submitTask({
      name: taskName,
      description: taskDescription,
      priority: taskPriority,
    });
  }

  async listTasks(
    statusFilter?: string,
    limit?: number,
  ): Promise<DaemonServiceListTasksResponse> {
    return await this.daemonServiceClient.listTasks({
      statusFilter: statusFilter ?? "",
      limit: limit ?? 0,
    });
  }

  async getTaskDetail(taskId: string): Promise<GetTaskDetailResponse> {
    return await this.daemonServiceClient.getTaskDetail({ taskId });
  }

  async cancelTask(taskId: string): Promise<DaemonServiceCancelTaskResponse> {
    return await this.daemonServiceClient.cancelTask({ taskId });
  }

  async *streamChatMessages(userMessage: string): AsyncGenerator<ChatOutput> {
    async function* createSingleMessageInputStream() {
      yield { input: { case: "userMessage" as const, value: userMessage } };
    }

    const chatResponseStream = this.agentChatServiceClient.chat(
      createSingleMessageInputStream(),
    );

    for await (const chatOutputMessage of chatResponseStream) {
      yield chatOutputMessage;
    }
  }

  isConnected(): boolean {
    return this.connectionEstablished;
  }

  getDaemonUrl(): string {
    return this.daemonUrl;
  }
}
