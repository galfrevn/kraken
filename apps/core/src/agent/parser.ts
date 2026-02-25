export interface ParsedToolCall {
  name: string;
  parameters: Record<string, unknown>;
}

export interface ParsedAgentResponse {
  toolCalls: ParsedToolCall[];
  finalResult: string | undefined;
  rawText: string;
  truncated: boolean;
}

const CLOSED_TOOL_CALL_PATTERN = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const UNCLOSED_TOOL_CALL_PATTERN = /<tool_call>\s*([\s\S]+)$/;
const RESULT_PATTERN = /<result>\s*([\s\S]*?)\s*<\/result>/;

const UNCLOSED_FUNCTION_CALLS_PATTERN = /<function_calls>\s*([\s\S]+)$/;
const INVOKE_PATTERN = /<invoke\s+name="([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/invoke>/g;
const INVOKE_SELF_CLOSING_PATTERN = /<invoke\s+name="([^"]+)"\s*\/>/g;

export function parseAgentResponse(responseText: string): ParsedAgentResponse {
  const { toolCalls, truncated } = extractToolCalls(responseText);
  const finalResult = extractFinalResult(responseText);

  return {
    toolCalls,
    finalResult,
    rawText: responseText,
    truncated,
  };
}

function extractToolCalls(text: string): { toolCalls: ParsedToolCall[]; truncated: boolean } {
  const calls: ParsedToolCall[] = [];
  let match: RegExpExecArray | null;
  let truncated = false;

  const closedPattern = new RegExp(CLOSED_TOOL_CALL_PATTERN.source, "g");
  while ((match = closedPattern.exec(text)) !== null) {
    const innerContent = match[1]?.trim();
    if (!innerContent) continue;

    const parsed = parseToolCallContent(innerContent);
    if (parsed) {
      calls.push(parsed);
    }
  }

  if (calls.length === 0) {
    const invokeCalls = extractInvokeStyleCalls(text);
    if (invokeCalls.length > 0) {
      calls.push(...invokeCalls);
    }
  }

  if (calls.length === 0) {
    const unclosedMatch =
      text.match(UNCLOSED_TOOL_CALL_PATTERN) ?? text.match(UNCLOSED_FUNCTION_CALLS_PATTERN);
    if (unclosedMatch?.[1]) {
      const innerContent = unclosedMatch[1].trim();
      const parsed = parseToolCallContent(innerContent);
      if (parsed) {
        calls.push(parsed);
        truncated = true;
      } else {
        const partialInvokes = extractInvokeStyleCalls(innerContent);
        if (partialInvokes.length > 0) {
          calls.push(...partialInvokes);
          truncated = true;
        }
      }
    }
  }

  return { toolCalls: calls, truncated };
}

function extractInvokeStyleCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  const invokePattern = new RegExp(INVOKE_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = invokePattern.exec(text)) !== null) {
    const toolName = match[1]?.trim();
    if (!toolName) continue;

    const innerContent = match[2]?.trim() ?? "";
    const parameters = parseInvokeParameters(innerContent);
    calls.push({ name: toolName, parameters });
  }

  const selfClosingPattern = new RegExp(INVOKE_SELF_CLOSING_PATTERN.source, "g");
  while ((match = selfClosingPattern.exec(text)) !== null) {
    const toolName = match[1]?.trim();
    if (!toolName) continue;

    const alreadyFound = calls.some((c) => c.name === toolName);
    if (!alreadyFound) {
      calls.push({ name: toolName, parameters: {} });
    }
  }

  return calls;
}

function parseInvokeParameters(content: string): Record<string, unknown> {
  if (!content) return {};

  const parameters: Record<string, unknown> = {};

  const parameterTagPattern =
    /<(?:antml:)?parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:antml:)?parameter>/g;
  let paramMatch: RegExpExecArray | null;

  while ((paramMatch = parameterTagPattern.exec(content)) !== null) {
    const paramName = paramMatch[1]?.trim();
    const paramValue = paramMatch[2]?.trim() ?? "";
    if (paramName) {
      parameters[paramName] = paramValue;
    }
  }

  if (Object.keys(parameters).length > 0) return parameters;

  try {
    const jsonParams = JSON.parse(content);
    if (typeof jsonParams === "object" && jsonParams !== null) {
      return jsonParams as Record<string, unknown>;
    }
  } catch {
    /* not json */
  }

  return parameters;
}

function parseToolCallContent(content: string): ParsedToolCall | undefined {
  const cleaned = content.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();

  const fromJson = parseAsJson(cleaned);
  if (fromJson) return fromJson;

  const fromXml = parseAsXml(cleaned);
  if (fromXml) return fromXml;

  const fromJsonOriginal = parseAsJson(content);
  if (fromJsonOriginal) return fromJsonOriginal;

  const fromXmlOriginal = parseAsXml(content);
  if (fromXmlOriginal) return fromXmlOriginal;

  return undefined;
}

function parseAsJson(content: string): ParsedToolCall | undefined {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed.name === "string") {
      return {
        name: parsed.name,
        parameters: parsed.parameters ?? {},
      };
    }
  } catch {
    // noop
  }

  const repaired = attemptJsonRepair(content);
  if (repaired) {
    try {
      const parsed = JSON.parse(repaired);
      if (typeof parsed.name === "string") {
        return {
          name: parsed.name,
          parameters: parsed.parameters ?? {},
        };
      }
    } catch {
      // noop
    }
  }

  return undefined;
}

function attemptJsonRepair(content: string): string | undefined {
  let trimmed = content.trim();
  if (!trimmed.startsWith("{")) return undefined;

  const nameMatch = trimmed.match(/"name"\s*:\s*"([^"]+)"/);
  if (!nameMatch?.[1]) return undefined;

  const paramMatch = trimmed.match(/"parameters"\s*:\s*(\{[\s\S]*)/);
  if (!paramMatch) {
    return JSON.stringify({ name: nameMatch[1], parameters: {} });
  }

  let paramString = paramMatch[1] ?? "{}";
  let openBraces = 0;
  let closedAt = -1;
  for (let i = 0; i < paramString.length; i++) {
    const character = paramString[i];
    if (character === "{") openBraces++;
    if (character === "}") {
      openBraces--;
      if (openBraces === 0) {
        closedAt = i;
        break;
      }
    }
  }

  if (closedAt >= 0) {
    paramString = paramString.slice(0, closedAt + 1);
  } else {
    const missingBraces = "}".repeat(Math.max(openBraces, 1));
    paramString = paramString + missingBraces;
  }

  try {
    const params = JSON.parse(paramString);
    return JSON.stringify({ name: nameMatch[1], parameters: params });
  } catch {
    return JSON.stringify({ name: nameMatch[1], parameters: {} });
  }
}

function parseAsXml(content: string): ParsedToolCall | undefined {
  const nameMatch = content.match(/<name>\s*([\s\S]*?)\s*<\/name>/);
  if (!nameMatch?.[1]) return undefined;

  const toolName = nameMatch[1].trim();
  if (!toolName) return undefined;

  const parameters: Record<string, unknown> = {};

  const closedParametersMatch = content.match(/<parameters>\s*([\s\S]*?)\s*<\/parameters>/);
  const unclosedParametersMatch = !closedParametersMatch
    ? content.match(/<parameters>\s*([\s\S]+)$/)
    : null;

  const parametersContent = (
    closedParametersMatch?.[1] ??
    unclosedParametersMatch?.[1] ??
    ""
  ).trim();

  if (parametersContent) {
    const paramPattern = /<(\w+)>\s*([\s\S]*?)\s*<\/\1>/g;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramPattern.exec(parametersContent)) !== null) {
      const paramName = paramMatch[1];
      const paramValue = paramMatch[2]?.trim() ?? "";
      if (paramName) {
        parameters[paramName] = paramValue;
      }
    }

    if (Object.keys(parameters).length === 0 && parametersContent.trim()) {
      try {
        const jsonParams = JSON.parse(parametersContent);
        if (typeof jsonParams === "object" && jsonParams !== null) {
          Object.assign(parameters, jsonParams);
        }
      } catch {
        // noop
      }
    }
  }

  return { name: toolName, parameters };
}

function extractFinalResult(text: string): string | undefined {
  const match = text.match(RESULT_PATTERN);
  return match?.[1]?.trim();
}

export function formatToolResultForConversation(
  toolName: string,
  result: { success: boolean; output: string; error?: string },
): string {
  const statusLabel = result.success ? "success" : "error";
  const content = result.success ? result.output : (result.error ?? result.output);
  return `<tool_result name="${toolName}" status="${statusLabel}">\n${content}\n</tool_result>`;
}
