import type { FastifyInstance, FastifyReply } from "fastify";
import type { MarmotService } from "../marmot/service.js";

async function resolveGroup(service: MarmotService, groupId: string, reply: FastifyReply) {
  try {
    return await service.client.getGroup(groupId);
  } catch {
    reply.status(404).send({ error: "Not Found", message: "Group not found" });
    return null;
  }
}

export async function messageRoutes(
  fastify: FastifyInstance,
  service: MarmotService
): Promise<void> {
  /** Send a chat message to a group */
  fastify.post<{
    Params: { groupId: string };
    Body: { content: string; tags?: string[][] };
  }>(
    "/v1/groups/:groupId/messages",
    {
      schema: {
        tags: ["Messages"],
        summary: "Send a chat message to a group",
        params: {
          type: "object",
          properties: { groupId: { type: "string" } },
          required: ["groupId"],
        },
        body: {
          type: "object",
          required: ["content"],
          properties: {
            content: { type: "string" },
            tags: { type: "array", items: { type: "array", items: { type: "string" } } },
          },
        },
        response: {
          201: {
            type: "object",
            properties: { ok: { type: "boolean" } },
          },
        },
      },
    },
    async (req, reply) => {
      const group = await resolveGroup(service, req.params.groupId, reply);
      if (!group) return;
      await group.sendChatMessage(req.body.content, req.body.tags ?? []);
      reply.status(201).send({ ok: true });
    }
  );

  /** Get message history for a group */
  fastify.get<{
    Params: { groupId: string };
    Querystring: { limit?: string; since?: string };
  }>(
    "/v1/groups/:groupId/messages",
    {
      schema: {
        tags: ["Messages"],
        summary: "Get message history for a group",
        params: {
          type: "object",
          properties: { groupId: { type: "string" } },
          required: ["groupId"],
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "string" },
            since: { type: "string" },
          },
        },
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                groupId: { type: "string" },
                sender: { type: "string" },
                kind: { type: "number" },
                content: { type: "string" },
                tags: { type: "array", items: { type: "array", items: { type: "string" } } },
                createdAt: { type: "number" },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      // parseInt without a radix can parse hex (0x…) or legacy octal strings,
      // and returns NaN for non-numeric input. NaN passed to better-sqlite3
      // binds as NULL, turning LIMIT NULL into no-limit and making
      // created_at > NULL always false — both undefined behaviours.
      // Always pass radix 10 and clamp/default on invalid input.
      const rawLimit = parseInt(req.query.limit ?? "50", 10);
      const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);
      const rawSince = parseInt(req.query.since ?? "0", 10);
      const since = Number.isFinite(rawSince) && rawSince >= 0 ? rawSince : 0;
      const messages = service.messages.list(req.params.groupId, limit, since);
      reply.send(messages);
    }
  );
}
