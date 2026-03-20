export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: parseInt(process.env.PORT ?? "8080"),
  dbPath: process.env.DB_PATH ?? "/data/marmot.db",
  /** If set, all requests must include `Authorization: Bearer <key>` */
  apiKey: process.env.API_KEY ?? null,
  defaultRelays: (process.env.DEFAULT_RELAYS ?? "wss://relay.damus.io,wss://nos.lol")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL ?? "info",
};
