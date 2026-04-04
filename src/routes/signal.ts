/**
 * signal-cli compatible HTTP JSON-RPC API.
 *
 * Implements the same transport and method names as signal-cli's built-in
 * HTTP daemon mode so that existing signal-cli clients can talk to this server
 * without modification.
 *
 * Endpoints:
 *   POST /api/v1/rpc          – JSON-RPC 2.0 (single request or batch array)
 *   GET  /api/v1/events       – Server-Sent Events stream (JSON-RPC notifications)
 *   GET  /api/v1/check        – Liveness probe (no auth required)
 *
 * Protocol notes:
 *   • The "account" param in every request is accepted but ignored; this server
 *     is single-identity (one Nostr keypair per container).
 *   • Group IDs are base64-encoded on the wire (signal-cli convention) and
 *     converted internally to the hex format used by marmot-ts.
 *   • Direct messages are not supported; marmot is a groups-only protocol.
 *   • SSE notifications follow the JSON-RPC 2.0 notification shape:
 *       { "jsonrpc": "2.0", "method": "receive", "params": { "account": "...", "envelope": {...} } }
 */
import type { FastifyInstance } from "fastify";
import type { MarmotService, ServerEvent } from "../marmot/service.js";
import { config } from "../config.js";
import { timingSafeCompare } from "../middleware/auth.js";
import { createDispatcher, hexToBase64 } from "../signal/dispatcher.js";
import type { JsonRpcRequest, SignalEnvelope } from "../signal/types.js";

/**
 * Format a ServerEvent as the SSE payload hermes-agent (and signal-cli) expect:
 *   data: {"envelope": {...}}
 *
 * sourceNumber and sourceUuid carry the sender's Nostr pubkey so hermes-agent
 * can use either field as a stable identifier.
 */
function formatSseEnvelope(evt: ServerEvent, _accountPubkey: string): object | null {
  if (evt.type === "message") {
    const ts = evt.message.createdAt * 1000;
    const envelope: SignalEnvelope = {
      source: evt.message.sender,
      sourceNumber: evt.message.sender,  // pubkey hex used as identifier
      sourceDevice: 1,
      timestamp: ts,
      dataMessage: {
        timestamp: ts,
        message: evt.message.content,
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: {
          groupId: hexToBase64(evt.groupId),
          type: "DELIVER",
        },
      },
    };
    return { envelope };
  }

  if (evt.type === "group_created" || evt.type === "group_joined") {
    const ts = Date.now();
    const envelope: SignalEnvelope = {
      source: _accountPubkey,
      sourceNumber: _accountPubkey,
      sourceDevice: 1,
      timestamp: ts,
      dataMessage: {
        timestamp: ts,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: { groupId: hexToBase64(evt.groupId), type: "UPDATE" },
      },
    };
    return { envelope };
  }

  if (evt.type === "group_left") {
    const ts = Date.now();
    const envelope: SignalEnvelope = {
      source: _accountPubkey,
      sourceNumber: _accountPubkey,
      sourceDevice: 1,
      timestamp: ts,
      dataMessage: {
        timestamp: ts,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
        groupInfo: { groupId: hexToBase64(evt.groupId), type: "QUIT" },
      },
    };
    return { envelope };
  }

  return null;
}

export async function signalRoutes(
  fastify: FastifyInstance,
  service: MarmotService
): Promise<void> {
  const dispatch = createDispatcher(service);

  /**
   * POST /api/v1/rpc
   * Accepts a single JSON-RPC 2.0 request object or a batch array.
   * Batch responses preserve order per spec.
   */
  fastify.post(
    "/api/v1/rpc",
    { schema: { hide: true } },
    async (req, reply) => {
      const body = req.body;

      if (Array.isArray(body)) {
        // Batch request
        if (body.length === 0) {
          return reply.status(400).send({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid Request: empty batch" },
          });
        }
        const responses = await Promise.all(
          body.map((item) => dispatch(item as JsonRpcRequest))
        );
        // Per JSON-RPC spec, omit responses for notifications (id === undefined/null with no id)
        const filtered = responses.filter((_, i) => {
          const item = body[i] as JsonRpcRequest;
          return item.id !== undefined && item.id !== null;
        });
        return reply.send(filtered.length === 1 ? filtered[0] : filtered);
      }

      // Single request
      const response = await dispatch(body as JsonRpcRequest);
      reply.send(response);
    }
  );

  /**
   * GET /api/v1/events
   * Server-Sent Events stream. Emits JSON-RPC notification objects for each
   * incoming message or group lifecycle event.
   *
   * If API_KEY is set, the client must supply it either as a Bearer token
   * (Authorization header) or as a ?key= query parameter (browser compat).
   */
  fastify.get(
    "/api/v1/events",
    { schema: { hide: true } },
    (req, reply) => {
      // Auth check before hijacking the socket
      if (config.apiKey) {
        const header = req.headers.authorization;
        const queryKey = (req.query as Record<string, string>).key;
        const token = header?.startsWith("Bearer ") ? header.slice(7) : queryKey;
        if (!token || !timingSafeCompare(token, config.apiKey)) {
          reply.status(401).send({ error: "Unauthorized", message: "Unauthorized" });
          return;
        }
      }

      reply.hijack();
      const res = reply.raw;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      // Prevent nginx / other proxies from buffering the stream
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const write = (data: object) => {
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {
          // client already gone
        }
      };

      // Send an initial comment to establish the connection (helps proxies)
      res.write(": signal-cli-compat connected\n\n");

      const onEvent = (evt: ServerEvent) => {
        if (evt.type === "message") {
          // SIGNAL_GROUP_ALLOWED_USERS: null = all groups allowed; Set = allowlist.
          if (config.groupAllowedUsers !== null) {
            const groupIdB64 = hexToBase64(evt.groupId);
            if (!config.groupAllowedUsers.has(groupIdB64)) return;
          }

          // SIGNAL_ALLOW_ALL_USERS=true bypasses sender filtering entirely.
          // Otherwise: if SIGNAL_ALLOWED_USERS is set, enforce it; if unset,
          // unknown senders are dropped (explicit allowlist required).
          if (!config.allowAllUsers) {
            if (!config.allowedUsers.includes(evt.message.sender)) return;
          }
        }
        // Group lifecycle events (join/leave/create/destroy) always pass through.
        const notification = formatSseEnvelope(evt, service.pubkey);
        if (notification) write(notification);
      };

      service.on("event", onEvent);

      // Keep-alive ping every 30 s so proxies don't drop idle SSE connections
      const keepAlive = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(keepAlive);
        }
      }, 30_000);

      req.raw.on("close", () => {
        clearInterval(keepAlive);
        service.off("event", onEvent);
      });

      req.raw.on("error", () => {
        clearInterval(keepAlive);
        service.off("event", onEvent);
      });
    }
  );

  /**
   * GET /api/v1/check
   * Liveness probe (no auth required, mirrors signal-cli behaviour).
   */
  fastify.get(
    "/api/v1/check",
    { schema: { hide: true } },
    async (_req, reply) => {
      reply.send({ ok: true });
    }
  );
}
