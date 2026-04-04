import { Bus, Events } from "@/bus/index.ts";

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

export interface PermissionRequest {
  id: string;
  toolId: string;
  filepath?: string;
  diff?: string;
  command?: string;
}

interface PendingPermission {
  sessionId: string;
  request: PermissionRequest;
  resolve: (approved: boolean) => void;
}

const pendingPermissions = new Map<string, PendingPermission>();

export function requestPermission(
  sessionId: string,
  messageId: string,
  request: PermissionRequest,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const pending: PendingPermission = { sessionId, request, resolve };
    pendingPermissions.set(sessionId, pending);

    Bus.publish(Events.Permission.Required, { sessionId, messageId, request });

    const timeout = setTimeout(() => {
      if (pendingPermissions.has(sessionId)) {
        pendingPermissions.delete(sessionId);
        resolve(false);
        Bus.publish(Events.Permission.Rejected, { sessionId });
      }
    }, PERMISSION_TIMEOUT_MS);

    const originalResolve = pending.resolve;
    pending.resolve = (approved: boolean) => {
      clearTimeout(timeout);
      originalResolve(approved);
    };
  });
}

export function replyToPermission(sessionId: string, approved: boolean): boolean {
  const pending = pendingPermissions.get(sessionId);
  if (!pending) return false;

  pendingPermissions.delete(sessionId);
  pending.resolve(approved);

  Bus.publish(approved ? Events.Permission.Approved : Events.Permission.Rejected, { sessionId });

  return true;
}

export function hasPendingPermission(sessionId: string): boolean {
  return pendingPermissions.has(sessionId);
}
