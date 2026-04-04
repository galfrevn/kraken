import { useState, useEffect, useCallback } from "react";
import { createSimpleContext } from "@/tui/_context/helper.tsx";
import { useSdk } from "@/tui/_context/sdk.tsx";
import { getDaemon } from "@/daemon/client.ts";

const STATUS_POLL_INTERVAL_MILLISECONDS = 10_000;

interface DaemonStatusData {
  connected: boolean;
  activeWorkers: number;
  maxWorkers: number;
  pendingTasks: number;
  runningTasks: number;
}

export const { Provider: DaemonStatusProvider, use: useDaemonStatus } = createSimpleContext({
  name: "DaemonStatus",
  init: () => {
    const sdk = useSdk();
    const [statusData, setStatusData] = useState<DaemonStatusData>({
      connected: false,
      activeWorkers: 0,
      maxWorkers: 0,
      pendingTasks: 0,
      runningTasks: 0,
    });

    const pollDaemonStatus = useCallback(async () => {
      try {
        const daemonStatus = await getDaemon().status();
        setStatusData({
          connected: true,
          activeWorkers: daemonStatus.workers?.active ?? 0,
          maxWorkers: daemonStatus.workers?.max ?? 0,
          pendingTasks: daemonStatus.tasks?.pending ?? 0,
          runningTasks: daemonStatus.tasks?.running ?? 0,
        });
      } catch {
        setStatusData((previous) => ({ ...previous, connected: false }));
      }
    }, []);

    useEffect(() => {
      pollDaemonStatus();
      const pollInterval = setInterval(pollDaemonStatus, STATUS_POLL_INTERVAL_MILLISECONDS);
      return () => clearInterval(pollInterval);
    }, [pollDaemonStatus]);

    useEffect(() => {
      const unsubscribe = sdk.onEvent((eventType) => {
        if (eventType === "daemon.connected") {
          setStatusData((previous) => ({ ...previous, connected: true }));
          pollDaemonStatus();
        }
        if (eventType === "daemon.disconnected") {
          setStatusData((previous) => ({ ...previous, connected: false }));
        }
        if (eventType.startsWith("daemon.task.")) {
          pollDaemonStatus();
        }
      });
      return unsubscribe;
    }, [pollDaemonStatus]);

    return statusData;
  },
});
