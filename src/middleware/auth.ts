import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from "fastify";
import { timingSafeEqual } from "crypto";
import { config } from "../config.js";

const UNPROTECTED = new Set(["/health", "/docs", "/docs/json", "/docs/yaml"]);

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 *
 * A plain `===` or `!==` comparison short-circuits on the first mismatched
 * byte, leaking information about how many leading characters matched.
 * An attacker can exploit this by sending many requests that differ by one
 * character at a time and measuring response latency to enumerate the correct
 * API key byte by byte.
 *
 * `crypto.timingSafeEqual` always compares all bytes regardless of where the
 * first difference occurs, eliminating this side channel.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Run a dummy comparison of equal-length buffers so that short-circuit
    // optimisations cannot distinguish a length mismatch from a value mismatch.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export function authHook(
  req: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  if (!config.apiKey) {
    done();
    return;
  }

  // Allow health/docs without auth
  if (UNPROTECTED.has(req.url) || req.url.startsWith("/docs")) {
    done();
    return;
  }

  // Return the same message for a missing/malformed header and for an invalid
  // token. Different messages for these two cases allow an attacker to
  // distinguish "I have the right header format" from "I have the wrong key",
  // giving them a partial oracle on the authentication state.
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    reply.status(401).send({ error: "Unauthorized", message: "Unauthorized" });
    return;
  }

  const token = header.slice(7);
  if (!timingSafeCompare(token, config.apiKey)) {
    reply.status(401).send({ error: "Unauthorized", message: "Unauthorized" });
    return;
  }

  done();
}
