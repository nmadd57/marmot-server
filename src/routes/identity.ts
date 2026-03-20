import type { FastifyInstance } from "fastify";
import type { MarmotService } from "../marmot/service.js";
import { config } from "../config.js";

export async function identityRoutes(
  fastify: FastifyInstance,
  service: MarmotService
): Promise<void> {
  fastify.get(
    "/v1/identity",
    {
      schema: {
        tags: ["Identity"],
        summary: "Get current identity",
        response: {
          200: {
            type: "object",
            properties: {
              pubkey: { type: "string" },
              defaultRelays: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      reply.send({
        pubkey: service.pubkey,
        defaultRelays: config.defaultRelays,
      });
    }
  );
}
