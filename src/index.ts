// Polyfill globalThis.crypto for Node.js < 19
import { webcrypto } from "crypto";
if (!globalThis.crypto) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).crypto = webcrypto;
}

import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import FastifySwagger from "@fastify/swagger";
import FastifySwaggerUi from "@fastify/swagger-ui";
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "./config.js";
import { authHook } from "./middleware/auth.js";
import { MarmotService } from "./marmot/service.js";
import { identityRoutes } from "./routes/identity.js";
import { keyPackageRoutes } from "./routes/key-packages.js";
import { groupRoutes } from "./routes/groups.js";
import { messageRoutes } from "./routes/messages.js";
import { inviteRoutes } from "./routes/invites.js";
import { eventsRoute } from "./routes/events.js";

async function main(): Promise<void> {
  // Ensure data directory exists
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const db = new Database(config.dbPath);
  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  const fastify = Fastify({
    // Enforce an explicit body limit. Without this, Fastify's implicit default
    // of 1 MiB applies — undocumented behaviour that could be changed by a
    // version bump. 64 KiB is ample for any chat message or API payload.
    bodyLimit: 65536,
    logger: {
      level: config.logLevel,
      serializers: {
        // Redact the ?key= WebSocket authentication token from access logs.
        // The token would otherwise appear in plaintext in every log line for
        // WS upgrade requests, exposing the API key to anyone with log access.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        req(req: any) {
          const rawUrl: string = req.url ?? "";
          return {
            method: req.method,
            url: rawUrl.replace(/([?&]key=)[^&#]*/g, "$1[REDACTED]"),
            remoteAddress: req.remoteAddress ?? req.socket?.remoteAddress,
          };
        },
      },
    },
  });

  // Plugins
  await fastify.register(FastifyWebSocket);
  await fastify.register(FastifySwagger, {
    openapi: {
      info: {
        title: "marmot-server",
        description: "Local server providing a REST API for the Marmot protocol (MLS + Nostr encrypted group messaging)",
        version: "0.1.0",
      },
      tags: [
        { name: "Identity", description: "Identity and key management" },
        { name: "Key Packages", description: "MLS key package lifecycle" },
        { name: "Groups", description: "Group creation and membership" },
        { name: "Messages", description: "Sending and receiving encrypted messages" },
        { name: "Invites", description: "Group invitations (Welcome messages)" },
      ],
    },
  });
  await fastify.register(FastifySwaggerUi, { routePrefix: "/docs" });

  // Global auth hook (no-op when API_KEY is not set)
  fastify.addHook("onRequest", authHook);

  // Sanitise error responses. Fastify's default error serialiser forwards the
  // raw error message for ALL status codes, which leaks internal details such
  // as file paths, module names, SQL fragments, and MLS state info when a
  // route handler throws unexpectedly. For 5xx responses we replace the
  // message with a generic string and log the full error server-side so it
  // can be investigated without exposing internals to the caller.
  fastify.setErrorHandler((error, req, reply) => {
    const err = error as { statusCode?: number; name?: string; message?: string };
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      fastify.log.error({ err: error, reqId: req.id }, "Unhandled server error");
      reply.status(500).send({ error: "Internal Server Error", message: "An unexpected error occurred" });
    } else {
      reply.status(statusCode).send({ error: err.name ?? "Error", message: err.message ?? "Request failed" });
    }
  });

  // Health endpoints (no auth)
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, function (req, body, done) {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  fastify.get("/health", { schema: { hide: true } }, async (_req, reply) => {
    reply.send({ ok: true });
  });

  // Boot the MarmotService (connects to relays, loads groups)
  fastify.log.info("Starting MarmotService...");
  const service = await MarmotService.create(db);
  fastify.log.info({ pubkey: service.pubkey }, "MarmotService ready");

  // Register routes
  await identityRoutes(fastify, service);
  await keyPackageRoutes(fastify, service);
  await groupRoutes(fastify, service);
  await messageRoutes(fastify, service);
  await inviteRoutes(fastify, service);
  await eventsRoute(fastify, service);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    fastify.log.info("Shutting down...");
    service.shutdown();
    await fastify.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await fastify.listen({ host: config.host, port: config.port });
  fastify.log.info(`Swagger UI: http://${config.host}:${config.port}/docs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
