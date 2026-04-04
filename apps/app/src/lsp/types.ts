export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface Diagnostic {
  range: Range;
  severity?: DiagnosticSeverity;
  message: string;
  source?: string;
  code?: string | number;
}

export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Diagnostic[];
}

export interface LanguageServerConfig {
  command: string[];
  extensions: string[];
  languageId: (ext: string) => string;
  enabled?: boolean;
}

export interface LspUserConfig {
  enabled?: boolean;
  command?: string[];
  extensions?: string[];
}
