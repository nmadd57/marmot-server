import type { FastifyInstance } from "fastify";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { MarmotService } from "../marmot/service.js";
import { config } from "../config.js";

/**
 * Reject any relay URL that is not a plain ws:// or wss:// address.
 * Accepting arbitrary URLs is an SSRF risk — a caller could supply internal
 * host addresses (e.g. ws://redis:6379) and trigger outbound connections to
 * services reachable only from inside the container network.
 */
function isValidRelayUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "wss:" || protocol === "ws:";
  } catch {
    return false;
  }
}

export async function keyPackageRoutes(
  fastify: FastifyInstance,
  service: MarmotService
): Promise<void> {
  /** List local key packages */
  fastify.get(
    "/v1/key-packages",
    {
      schema: {
        tags: ["Key Packages"],
        summary: "List local key packages",
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ref: { type: "string" },
                publishedEventIds: { type: "array", items: { type: "string" } },
                used: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      const packages = await service.client.keyPackages.list();
      reply.send(
        packages.map((pkg) => ({
          ref: bytesToHex(pkg.keyPackageRef),
          publishedEventIds: (pkg.published ?? []).map((e: { id: string }) => e.id),
          used: pkg.used ?? false,
        }))
      );
    }
  );

  /** Create and publish a new key package */
  fastify.post<{
    Body: { relays?: string[]; isLastResort?: boolean };
  }>(
    "/v1/key-packages",
    {
      schema: {
        tags: ["Key Packages"],
        summary: "Create and publish a key package",
        body: {
          type: "object",
          properties: {
            relays: { type: "array", items: { type: "string" } },
            isLastResort: { type: "boolean" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              ref: { type: "string" },
              publishedEventIds: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const relays = req.body?.relays ?? config.defaultRelays;
      if (relays.some((r) => !isValidRelayUrl(r))) {
        return reply.status(400).send({ error: "Bad Request", message: "relays must be valid wss:// or ws:// URLs" });
      }
      const pkg = await service.client.keyPackages.create({
        relays,
        isLastResort: req.body?.isLastResort ?? true,
        client: "marmot-server",
      });
      reply.status(201).send({
        ref: bytesToHex(pkg.keyPackageRef),
        publishedEventIds: (pkg.published ?? []).map((e: { id: string }) => e.id),
      });
    }
  );

  /** Rotate a key package */
  fastify.post<{ Params: { ref: string } }>(
    "/v1/key-packages/:ref/rotate",
    {
      schema: {
        tags: ["Key Packages"],
        summary: "Rotate a key package (delete old, publish new)",
        params: {
          type: "object",
          properties: { ref: { type: "string" } },
          required: ["ref"],
        },
        response: {
          200: {
            type: "object",
            properties: { ref: { type: "string" } },
          },
        },
      },
    },
    async (req, reply) => {
      const newPkg = await service.client.keyPackages.rotate(req.params.ref);
      reply.send({ ref: bytesToHex(newPkg.keyPackageRef) });
    }
  );

  /** Delete / purge a key package */
  fastify.delete<{ Params: { ref: string } }>(
    "/v1/key-packages/:ref",
    {
      schema: {
        tags: ["Key Packages"],
        summary: "Purge a key package from local store and relays",
        params: {
          type: "object",
          properties: { ref: { type: "string" } },
          required: ["ref"],
        },
        response: { 204: { type: "null" } },
      },
    },
    async (req, reply) => {
      await service.client.keyPackages.purge(req.params.ref);
      reply.status(204).send();
    }
  );
}
