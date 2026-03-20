import type { FastifyInstance } from "fastify";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebSocket = any;
import type { MarmotService } from "../marmot/service.js";
import { config } from "../config.js";
import { timingSafeCompare } from "../middleware/auth.js";

/**
 * WebSocket endpoint for real-time events.
 *
 * Connect with: ws://localhost:8080/v1/events
 * If API_KEY is set: ws://localhost:8080/v1/events?key=<API_KEY>
 *
 * Note: passing the API key as a query parameter is necessary because the
 * WebSocket API in browsers does not allow setting custom headers. Be aware
 * that query-string tokens appear in server access logs and proxy logs. Use
 * a TLS-terminating reverse proxy in production to limit exposure.
 *
 * Emitted JSON event shapes:
 *   { type: "message",         groupId, message: { id, sender, kind, content, tags, createdAt } }
 *   { type: "invite",          inviteId, groupName, inviterPubkey }
 *   { type: "group_created",   groupId, name }
 *   { type: "group_joined",    groupId, name }
 *   { type: "group_left",      groupId }
 *   { type: "group_destroyed", groupId }
 */
export async function eventsRoute(
  fastify: FastifyInstance,
  service: MarmotService
): Promise<void> {
  const clients = new Set<WebSocket>();

  // Fan out all server events to connected WebSocket clients
  service.on("event", (evt) => {
    const payload = JSON.stringify(evt);
    for (const ws of clients) {
      try {
        ws.send(payload);
      } catch {
        // client already disconnected
      }
    }
  });

  fastify.get(
    "/v1/events",
    { websocket: true },
    (socket, req) => {
      // Auth is checked synchronously before the socket is registered as a
      // client. A previous version used a dynamic import() here, which
      // introduced an async gap: the socket was briefly open before the auth
      // check ran, creating a window where the connection existed without
      // being validated. Using a static import and synchronous check closes
      // that gap entirely.
      if (config.apiKey) {
        const key = (req.query as Record<string, string>).key;
        if (!key || !timingSafeCompare(key, config.apiKey)) {
          socket.send(JSON.stringify({ error: "Unauthorized" }));
          socket.close(1008, "Unauthorized");
          return;
        }
      }

      clients.add(socket);
      socket.send(JSON.stringify({ type: "connected", pubkey: service.pubkey }));

      socket.on("close", () => {
        clients.delete(socket);
      });

      socket.on("error", () => {
        clients.delete(socket);
      });
    }
  );
}
