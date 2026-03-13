export interface ConfirmationDecision {
  approved: boolean;
  reason?: string;
}

export interface PendingConfirmation {
  id: string;
  toolName: string;
  parameters: Record<string, unknown>;
  resolve: (decision: ConfirmationDecision) => void;
}

export type ConfirmationHandler = (pending: PendingConfirmation) => void;
