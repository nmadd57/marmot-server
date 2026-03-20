import type { FastifyInstance, FastifyReply } from "fastify";
import type { MarmotService } from "../marmot/service.js";
import { config } from "../config.js";

/**
 * Resolve a group by ID. Returns the group on success, or sends a 404 and
 * returns null so the caller can return early without re-throwing.
 *
 * getGroup() throws for any lookup failure — there is no separate "not found"
 * error type in marmot-ts, so we catch all errors here and surface them as
 * 404s. A genuinely unexpected error (e.g. database corruption) will also
 * arrive here; the global error handler logs those at ERROR level.
 */
async function resolveGroup(
  service: MarmotService,
  groupId: string,
  reply: FastifyReply
) {
  try {
    return await service.client.getGroup(groupId);
  } catch {
    reply.status(404).send({ error: "Not Found", message: "Group not found" });
    return null;
  }
}

/**
 * Reject any relay URL that is not a plain ws:// or wss:// WebSocket address.
 * Accepting arbitrary URLs is an SSRF risk: a caller could supply internal
 * host addresses (e.g. ws://redis:6379) and cause the server to open
 * connections to services that are only reachable from inside the container
 * network. We do not allow http/https here — only WebSocket schemes.
 */
function isValidRelayUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "wss:" || protocol === "ws:";
  } catch {
    return false;
  }
}

function serializeGroup(group: { idStr: string; groupData: { name: string; description: string; adminPubkeys: string[]; relays: string[] } | null; state: { groupContext: { epoch: bigint } }; relays?: string[] }) {
  const data = group.groupData;
  return {
    id: group.idStr,
    name: data?.name ?? "",
    description: data?.description ?? "",
    adminPubkeys: data?.adminPubkeys ?? [],
    relays: data?.relays ?? group.relays ?? [],
    epoch: Number(group.state.groupContext.epoch),
  };
}

export async function groupRoutes(
  fastify: FastifyInstance,
  service: MarmotService
): Promise<void> {
  /** List all groups */
  fastify.get(
    "/v1/groups",
    {
      schema: {
        tags: ["Groups"],
        summary: "List all groups",
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                adminPubkeys: { type: "array", items: { type: "string" } },
                relays: { type: "array", items: { type: "string" } },
                epoch: { type: "number" },
              },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      const groups = await service.client.loadAllGroups();
      reply.send(groups.map(serializeGroup));
    }
  );

  /** Get a single group */
  fastify.get<{ Params: { groupId: string } }>(
    "/v1/groups/:groupId",
    {
      schema: {
        tags: ["Groups"],
        summary: "Get group details",
        params: {
          type: "object",
          properties: { groupId: { type: "string" } },
          required: ["groupId"],
        },
      },
    },
    async (req, reply) => {
      const group = await resolveGroup(service, req.params.groupId, reply);
      if (!group) return;
      reply.send(serializeGroup(group));
    }
  );

  /** Create a group */
  fastify.post<{
    Body: { name: string; description?: string; relays?: string[]; adminPubkeys?: string[] };
  }>(
    "/v1/groups",
    {
      schema: {
        tags: ["Groups"],
        summary: "Create a new group",
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            relays: { type: "array", items: { type: "string" } },
            adminPubkeys: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (req, reply) => {
      const { name, description, relays, adminPubkeys } = req.body;
      const resolvedRelays = relays ?? config.defaultRelays;
      if (resolvedRelays.some((r) => !isValidRelayUrl(r))) {
        return reply.status(400).send({ error: "Bad Request", message: "relays must be valid wss:// or ws:// URLs" });
      }
      const group = await service.client.createGroup(name, {
        description: description ?? "",
        relays: resolvedRelays,
        adminPubkeys: adminPubkeys ?? [],
      });
      reply.status(201).send(serializeGroup(group));
    }
  );

  /** Destroy a group (local purge only) */
  fastify.delete<{ Params: { groupId: string } }>(
    "/v1/groups/:groupId",
    {
      schema: {
        tags: ["Groups"],
        summary: "Destroy a group (purges local state)",
        params: {
          type: "object",
          properties: { groupId: { type: "string" } },
          required: ["groupId"],
        },
        response: { 204: { type: "null" } },
      },
    },
    async (req, reply) => {
      const group = await resolveGroup(service, req.params.groupId, reply);
      if (!group) return;
      await service.client.destroyGroup(req.params.groupId);
      reply.status(204).send();
    }
  );

  /** Leave a group (publishes self-remove proposal then purges local state) */
  fastify.post<{ Params: { groupId: string } }>(
    "/v1/groups/:groupId/leave",
    {
      schema: {
        tags: ["Groups"],
        summary: "Leave a group",
        params: {
          type: "object",
          properties: { groupId: { type: "string" } },
          required: ["groupId"],
        },
        response: { 204: { type: "null" } },
      },
    },
    async (req, reply) => {
      const group = await resolveGroup(service, req.params.groupId, reply);
      if (!group) return;
      await service.client.leaveGroup(req.params.groupId);
      reply.status(204).send();
    }
  );

  /** Invite a user to a group by fetching their key package from relays */
  fastify.post<{
    Params: { groupId: string };
    Body: { pubkey: string; keyPackageEventId?: string };
  }>(
    "/v1/groups/:groupId/invite",
    {
      schema: {
        tags: ["Groups"],
        summary: "Invite a user by pubkey (fetches their key package from relays)",
        params: {
          type: "object",
          properties: { groupId: { type: "string" } },
          required: ["groupId"],
        },
        body: {
          type: "object",
          required: ["pubkey"],
          properties: {
            pubkey: { type: "string" },
            keyPackageEventId: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      const { pubkey, keyPackageEventId } = req.body;
      const group = await resolveGroup(service, req.params.groupId, reply);
      if (!group) return;
      const relays = group.relays ?? config.defaultRelays;

      // Fetch the invitee's key package event (kind 443)
      const filter: Record<string, unknown> = { kinds: [443], authors: [pubkey], limit: 5 };
      if (keyPackageEventId) filter.ids = [keyPackageEventId];
      const events = await service.pool.request(relays, filter as Parameters<typeof service.pool.request>[1]);
      if (events.length === 0) {
        return reply.status(404).send({ error: "No key package found for this pubkey on the group relays" });
      }

      await group.inviteByKeyPackageEvent(events[0] as unknown as Parameters<typeof group.inviteByKeyPackageEvent>[0]);
      reply.status(204).send();
    }
  );

  /** Remove a member from a group */
  fastify.delete<{
    Params: { groupId: string; pubkey: string };
  }>(
    "/v1/groups/:groupId/members/:pubkey",
    {
      schema: {
        tags: ["Groups"],
        summary: "Remove a member from a group (admin only)",
        params: {
          type: "object",
          properties: {
            groupId: { type: "string" },
            pubkey: { type: "string" },
          },
          required: ["groupId", "pubkey"],
        },
        response: { 204: { type: "null" } },
      },
    },
    async (req, reply) => {
      const group = await resolveGroup(service, req.params.groupId, reply);
      if (!group) return;
      // Import proposal builder inline
      const { Proposals } = await import("@internet-privacy/marmot-ts/client");
      // Propose removal first, then commit all pending proposals
      await group.propose(Proposals.proposeRemoveUser, req.params.pubkey);
      await group.commit();
      reply.status(204).send();
    }
  );
}
