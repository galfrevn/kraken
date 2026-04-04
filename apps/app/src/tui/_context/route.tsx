import { useState } from "react";
import { createSimpleContext } from "@/tui/_context/helper.tsx";

type Route =
  | { type: "home" }
  | { type: "session"; sessionId: string; initialPrompt?: string }
  | { type: "tasks" }
  | { type: "inbox" };

function resolveInitialRoute(): Route {
  const sessionId = process.env.KRAKEN_INITIAL_SESSION_ID;
  const prompt = process.env.KRAKEN_INITIAL_PROMPT;
  if (sessionId) {
    return { type: "session", sessionId, initialPrompt: prompt };
  }
  return { type: "home" };
}

export const { Provider: RouteProvider, use: useRoute } = createSimpleContext({
  name: "Route",
  init: () => {
    const [currentRoute, setCurrentRoute] = useState<Route>(resolveInitialRoute);

    return {
      route: currentRoute,
      navigate(route: Route) {
        setCurrentRoute(route);
      },
      goHome() {
        setCurrentRoute({ type: "home" });
      },
      goToSession(sessionId: string, initialPrompt?: string) {
        setCurrentRoute({ type: "session", sessionId, initialPrompt });
      },
      goToTasks() {
        setCurrentRoute({ type: "tasks" });
      },
      goToInbox() {
        setCurrentRoute({ type: "inbox" });
      },
    };
  },
});
