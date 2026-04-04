import type { FastifyInstance } from "fastify";
import { getMarmotGroupData } from "@internet-privacy/marmot-ts";
import type { MarmotService } from "../marmot/service.js";

export async function inviteRoutes(
  fastify: FastifyInstance,
  service: MarmotService
): Promise<void> {
  /** List pending (unread) invites */
  fastify.get(
    "/v1/invites",
    {
      schema: {
        tags: ["Invites"],
        summary: "List pending group invitations",
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                inviterPubkey: { type: "string" },
                groupName: { type: ["string", "null"] },
                createdAt: { type: "number" },
              },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      const unread = await service.inviteReader.getUnread();
      const result = await Promise.all(
        unread.map(async (rumor) => {
          let groupName: string | null = null;
          try {
            const groupInfo = await service.client.readInviteGroupInfo(rumor);
            if (groupInfo) {
              const data = getMarmotGroupData(groupInfo);
              groupName = data?.name ?? null;
            }
          } catch {
            // ignore
          }
          return {
            id: rumor.id,
            inviterPubkey: rumor.pubkey,
            groupName,
            createdAt: rumor.created_at,
          };
        })
      );
      reply.send(result);
    }
  );

  /** Accept an invite (join the group) */
  fastify.post<{ Params: { inviteId: string } }>(
    "/v1/invites/:inviteId/accept",
    {
      schema: {
        tags: ["Invites"],
        summary: "Accept a group invitation",
        params: {
          type: "object",
          properties: { inviteId: { type: "string" } },
          required: ["inviteId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              groupId: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const unread = await service.inviteReader.getUnread();
      const rumor = unread.find((r) => r.id === req.params.inviteId);
      if (!rumor) {
        return reply.status(404).send({ error: "Invite not found" });
      }

      const { group } = await service.client.joinGroupFromWelcome({ welcomeRumor: rumor });
      await service.inviteReader.markAsRead(req.params.inviteId);

      // Replenish the consumed key package so future invites can still be accepted.
      service.ensureKeyPackage().catch(() => {});

      // Self-update after joining for forward secrecy (MIP-02)
      try {
        await group.selfUpdate();
      } catch {
        // non-fatal
      }

      reply.send({
        groupId: group.idStr,
        name: group.groupData?.name ?? "",
      });
    }
  );

  /** Decline an invite */
  fastify.post<{ Params: { inviteId: string } }>(
    "/v1/invites/:inviteId/decline",
    {
      schema: {
        tags: ["Invites"],
        summary: "Decline a group invitation",
        params: {
          type: "object",
          properties: { inviteId: { type: "string" } },
          required: ["inviteId"],
        },
        response: { 204: { type: "null" } },
      },
    },
    async (req, reply) => {
      await service.inviteReader.markAsRead(req.params.inviteId);
      reply.status(204).send();
    }
  );
}
