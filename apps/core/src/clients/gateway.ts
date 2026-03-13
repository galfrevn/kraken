import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { GatewayService } from "@gen/agent/v1/gateway_pb.ts";

export type GatewayClient = Client<typeof GatewayService>;

export function createGatewayClient(baseUrl: string): GatewayClient {
  const transport = createConnectTransport({ baseUrl, httpVersion: "2" });
  return createClient(GatewayService, transport);
}
