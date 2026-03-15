import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { GatewayService } from "@gen/agent/v1/gateway_pb.ts";

export type LlmProxyClient = Client<typeof GatewayService>;

export function createLlmProxyClient(baseUrl: string): LlmProxyClient {
  const transport = createGrpcTransport({ baseUrl });
  return createClient(GatewayService, transport);
}
