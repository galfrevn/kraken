import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { SchedulerService } from "@gen/agent/v1/scheduler_pb.ts";

export type SchedulerClient = Client<typeof SchedulerService>;

export function createSchedulerClient(baseUrl: string): SchedulerClient {
  const transport = createGrpcTransport({ baseUrl });
  return createClient(SchedulerService, transport);
}
