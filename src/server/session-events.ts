import type { EventHub } from "./event-hub.js";
import type { SessionManager } from "./session-manager.js";

// Republishes session lifecycle on the event hub, so a subscriber learns about creation, title
// changes and exits without polling /v1/sessions.
export function bridgeSessionEvents(sessionManager: SessionManager, eventHub: EventHub): void {
  sessionManager.onCreate((session) => {
    session.onTitleChange((title) => eventHub.publish({
      sessionId: session.id,
      type: "session.title",
      data: { title },
    }));

    session.onExit((exited) => {
      eventHub.publish({
        sessionId: session.id,
        type: "session.exited",
        data: exited,
      });
      // An unanswered request can never be answered once the session is gone.
      eventHub.cancelSession(session.id);
    });

    eventHub.publish({
      sessionId: session.id,
      type: "session.created",
      data: session.toJSON(),
    });
  });
}
