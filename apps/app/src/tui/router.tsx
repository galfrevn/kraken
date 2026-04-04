import { useRoute } from "@/tui/_context/route.tsx";
import { Home } from "@/tui/home/index.tsx";
import { Session } from "@/tui/session/index.tsx";
import { TaskDashboard } from "@/tui/tasks/index.tsx";
import { Inbox } from "@/tui/inbox/index.tsx";

export const Router = () => {
  const route = useRoute();

  if (route.route.type === "session") {
    return <Session />;
  }

  if (route.route.type === "tasks") {
    return <TaskDashboard />;
  }

  if (route.route.type === "inbox") {
    return <Inbox />;
  }

  return <Home />;
};
