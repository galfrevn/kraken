import type { Subprocess } from "bun";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
type NotificationHandler = (params: unknown) => void;
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class JsonRpcTransport {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, NotificationHandler[]>();
  private process: Subprocess;
  private buffer = "";
  private closed = false;

  constructor(process: Subprocess) {
    this.process = process;
    this.startReading();
  }

  private async startReading(): Promise<void> {
    const stdout = this.process.stdout;
    if (!stdout || typeof stdout === "number") return;

    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch {
      // process exited
    }
  }

  private processBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) return;

      const body = this.buffer.slice(bodyStart, bodyEnd);
      this.buffer = this.buffer.slice(bodyEnd);

      try {
        const message = JSON.parse(body) as JsonRpcMessage;
        this.handleMessage(message);
      } catch {
        // malformed JSON, skip
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (
      "id" in message &&
      message.id !== undefined &&
      ("result" in message || "error" in message)
    ) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        const response = message as JsonRpcResponse;
        if (response.error) {
          pending.reject(new Error(`${response.error.message} (${response.error.code})`));
        } else {
          pending.resolve(response.result);
        }
      }
    } else if (
      "method" in message &&
      message.method &&
      !("id" in message && message.id !== undefined)
    ) {
      const handlers = this.notificationHandlers.get(message.method);
      if (handlers) {
        for (const handler of handlers) {
          handler((message as JsonRpcNotification).params);
        }
      }
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  onNotification(method: string, handler: NotificationHandler): void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
  }

  private send(message: JsonRpcMessage): void {
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
    try {
      const stdin = this.process.stdin;
      if (stdin && typeof stdin !== "number") {
        stdin.write(header + json);
      }
    } catch {
      // stdin closed
    }
  }

  close(): void {
    this.closed = true;
    for (const [, pending] of this.pending) {
      pending.reject(new Error("transport closed"));
    }
    this.pending.clear();
  }
}
