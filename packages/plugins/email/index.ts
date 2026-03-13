import { definePlugin } from "@kraken/sdk";
import type { Tool, ToolResult, PluginContext } from "@kraken/sdk";

// ---------------------------------------------------------------------------
// Config state
// ---------------------------------------------------------------------------

const RESEND_API = "https://api.resend.com";

let apiKey: string | undefined;
let defaultFrom: string | undefined;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const emailSendTool: Tool = {
  definition: {
    name: "email_send",
    description:
      "Send an email via Resend. The user will be prompted to confirm before sending.",
    requiresConfirmation: true,
    parameters: [
      {
        name: "to",
        type: "string",
        description: "Recipient(s), comma-separated.",
        required: true,
      },
      {
        name: "subject",
        type: "string",
        description: "Email subject line.",
        required: true,
      },
      {
        name: "body",
        type: "string",
        description: "Email body (HTML supported).",
        required: true,
      },
      {
        name: "from",
        type: "string",
        description: "Sender address. Overrides the default from_address.",
        required: false,
      },
    ],
  },

  async execute(parameters): Promise<ToolResult> {
    const to = parameters["to"] as string;
    const subject = parameters["subject"] as string;
    const body = parameters["body"] as string;
    const from = (parameters["from"] as string) || defaultFrom;

    if (!to) return { success: false, output: "to is required" };
    if (!subject) return { success: false, output: "subject is required" };
    if (!body) return { success: false, output: "body is required" };

    if (!apiKey) {
      return {
        success: false,
        output:
          "Resend API key not configured. Set api_key in plugin config or RESEND_API_KEY env variable.",
      };
    }

    if (!from) {
      return {
        success: false,
        output:
          "No sender address. Set from_address in plugin config or RESEND_FROM_ADDRESS env variable, or pass the from parameter.",
      };
    }

    const recipients = to.split(",").map((r) => r.trim());

    try {
      const response = await fetch(`${RESEND_API}/emails`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from,
          to: recipients,
          subject,
          html: body,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        return {
          success: false,
          output: `Resend API error (${response.status}): ${errorBody}`,
        };
      }

      const data = (await response.json()) as { id?: string };
      return {
        success: true,
        output: `Email sent successfully. ID: ${data.id ?? "unknown"}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to send email: ${message}` };
    }
  },
};

interface ResendEmail {
  id: string;
  to: string[];
  subject: string;
  status?: string;
  created_at: string;
}

const emailListTool: Tool = {
  definition: {
    name: "email_list",
    description: "List recently sent emails from Resend.",
    parameters: [
      {
        name: "limit",
        type: "number",
        description: "Number of emails to return (default 10).",
        required: false,
      },
    ],
  },

  async execute(parameters): Promise<ToolResult> {
    const limit = Math.min(Math.max(1, (parameters["limit"] as number) || 10), 100);

    if (!apiKey) {
      return {
        success: false,
        output:
          "Resend API key not configured. Set api_key in plugin config or RESEND_API_KEY env variable.",
      };
    }

    try {
      const response = await fetch(`${RESEND_API}/emails`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        return {
          success: false,
          output: `Resend API error (${response.status}): ${errorBody}`,
        };
      }

      const data = (await response.json()) as { data?: ResendEmail[] };
      const emails = (data.data ?? []).slice(0, limit);

      if (emails.length === 0) {
        return { success: true, output: "No emails found." };
      }

      const lines = emails.map((e) => {
        const to = Array.isArray(e.to) ? e.to.join(", ") : e.to;
        return `[${e.id}] To: ${to} | Subject: ${e.subject} | Status: ${e.status ?? "unknown"} | ${e.created_at}`;
      });

      return { success: true, output: lines.join("\n") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Failed to list emails: ${message}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default definePlugin({
  name: "email",
  version: "0.1.0",
  description: "Send and list emails via the Resend API.",
  author: "kraken",

  toolDisplayNames: {
    email_send: "Send Email",
    email_list: "List Emails",
  },

  configSchema: {
    api_key: {
      type: "string",
      description: "Resend API key",
      required: true,
      envVar: "RESEND_API_KEY",
    },
    from_address: {
      type: "string",
      description: "Sender email address",
      required: false,
      envVar: "RESEND_FROM_ADDRESS",
    },
  },

  tools: [emailSendTool, emailListTool],

  promptExtension:
    "You have email tools from the 'email' plugin (powered by Resend):\n" +
    "- email_send: Send an email. The user will see a confirmation panel before sending.\n" +
    "- email_list: List recently sent emails.",

  activate: async (context: PluginContext) => {
    apiKey =
      (context.config.api_key as string) || Bun.env.RESEND_API_KEY;
    defaultFrom =
      (context.config.from_address as string) || Bun.env.RESEND_FROM_ADDRESS;
    console.log("[email] activated");
  },

  deactivate: async () => {
    apiKey = undefined;
    defaultFrom = undefined;
    console.log("[email] deactivated");
  },
});
