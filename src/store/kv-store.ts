import Database from "better-sqlite3";

/**
 * JSON replacer/reviver that handles Uint8Array and BigInt round-trips.
 * Used so that complex marmot-ts objects (KeyPackage, StoredKeyPackage, etc.)
 * survive serialization to SQLite TEXT.
 */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __t: "u8", d: Array.from(value) };
  }
  if (typeof value === "bigint") {
    return { __t: "bi", d: value.toString() };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v.__t === "u8" && Array.isArray(v.d)) {
      return new Uint8Array(v.d as number[]);
    }
    if (v.__t === "bi" && typeof v.d === "string") {
      return BigInt(v.d);
    }
  }
  return value;
}

export function serialize(value: unknown): string {
  return JSON.stringify(value, replacer);
}

export function deserialize<T>(json: string): T {
  return JSON.parse(json, reviver) as T;
}

/**
 * Generic SQLite-backed key-value store.
 * Values are stored as JSON TEXT (with Uint8Array/BigInt support).
 * Compatible with marmot-ts KeyValueStoreBackend<T>.
 */
export class SqliteKvStore<T> {
  private readonly get: (key: string) => { value: string } | undefined;
  private readonly set: (key: string, value: string) => void;
  private readonly del: (key: string) => void;
  private readonly clearAll: () => void;
  private readonly allKeys: () => { key: string }[];

  constructor(db: Database.Database, tableName: string) {
    // Table names are interpolated into SQL strings because SQLite does not
    // support parameterised identifiers. Validate before use so a future
    // caller cannot accidentally pass user-controlled input and inject SQL.
    if (!/^[a-z_][a-z0-9_]*$/i.test(tableName)) {
      throw new Error(`Invalid table name "${tableName}": only letters, digits, and underscores are allowed`);
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS "${tableName}" (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
    );
    this.get = db.prepare<[string], { value: string }>(
      `SELECT value FROM "${tableName}" WHERE key = ?`
    ).get.bind(
      db.prepare<[string], { value: string }>(
        `SELECT value FROM "${tableName}" WHERE key = ?`
      )
    );
    this.set = db.prepare(
      `INSERT OR REPLACE INTO "${tableName}" (key, value) VALUES (?, ?)`
    ).run.bind(
      db.prepare(
        `INSERT OR REPLACE INTO "${tableName}" (key, value) VALUES (?, ?)`
      )
    );
    this.del = db.prepare(`DELETE FROM "${tableName}" WHERE key = ?`).run.bind(
      db.prepare(`DELETE FROM "${tableName}" WHERE key = ?`)
    );
    this.clearAll = db.prepare(`DELETE FROM "${tableName}"`).run.bind(
      db.prepare(`DELETE FROM "${tableName}"`)
    );
    this.allKeys = db.prepare<[], { key: string }>(
      `SELECT key FROM "${tableName}"`
    ).all.bind(
      db.prepare<[], { key: string }>(`SELECT key FROM "${tableName}"`)
    );

    // Re-bind correctly using the same prepared statements
    const getStmt = db.prepare<[string], { value: string }>(
      `SELECT value FROM "${tableName}" WHERE key = ?`
    );
    const setStmt = db.prepare(
      `INSERT OR REPLACE INTO "${tableName}" (key, value) VALUES (?, ?)`
    );
    const delStmt = db.prepare(`DELETE FROM "${tableName}" WHERE key = ?`);
    const clearStmt = db.prepare(`DELETE FROM "${tableName}"`);
    const keysStmt = db.prepare<[], { key: string }>(
      `SELECT key FROM "${tableName}"`
    );

    this.get = (key) => getStmt.get(key);
    this.set = (key, value) => {
      setStmt.run(key, value);
    };
    this.del = (key) => {
      delStmt.run(key);
    };
    this.clearAll = () => {
      clearStmt.run();
    };
    this.allKeys = () => keysStmt.all();
  }

  async getItem(key: string): Promise<T | null> {
    const row = this.get(key);
    if (!row) return null;
    return deserialize<T>(row.value);
  }

  async setItem(key: string, value: T): Promise<T> {
    this.set(key, serialize(value));
    return value;
  }

  async removeItem(key: string): Promise<void> {
    this.del(key);
  }

  async clear(): Promise<void> {
    this.clearAll();
  }

  async keys(): Promise<string[]> {
    return this.allKeys().map((r) => r.key);
  }
}

/**
 * SQLite-backed KV store for binary blobs (Uint8Array values stored as BLOB).
 * Used for SerializedClientState (group state bytes from ts-mls TLS encoding).
 */
export class SqliteBlobStore {
  private readonly get: (key: string) => { value: Buffer } | undefined;
  private readonly set: (key: string, value: Buffer) => void;
  private readonly del: (key: string) => void;
  private readonly clearAll: () => void;
  private readonly allKeys: () => { key: string }[];

  constructor(db: Database.Database, tableName: string) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(tableName)) {
      throw new Error(`Invalid table name "${tableName}": only letters, digits, and underscores are allowed`);
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS "${tableName}" (key TEXT PRIMARY KEY, value BLOB NOT NULL)`
    );

    const getStmt = db.prepare<[string], { value: Buffer }>(
      `SELECT value FROM "${tableName}" WHERE key = ?`
    );
    const setStmt = db.prepare(
      `INSERT OR REPLACE INTO "${tableName}" (key, value) VALUES (?, ?)`
    );
    const delStmt = db.prepare(`DELETE FROM "${tableName}" WHERE key = ?`);
    const clearStmt = db.prepare(`DELETE FROM "${tableName}"`);
    const keysStmt = db.prepare<[], { key: string }>(
      `SELECT key FROM "${tableName}"`
    );

    this.get = (key) => getStmt.get(key);
    this.set = (key, value) => {
      setStmt.run(key, value);
    };
    this.del = (key) => {
      delStmt.run(key);
    };
    this.clearAll = () => {
      clearStmt.run();
    };
    this.allKeys = () => keysStmt.all();
  }

  async getItem(key: string): Promise<Uint8Array | null> {
    const row = this.get(key);
    if (!row) return null;
    return new Uint8Array(row.value);
  }

  async setItem(key: string, value: Uint8Array): Promise<Uint8Array> {
    this.set(key, Buffer.from(value));
    return value;
  }

  async removeItem(key: string): Promise<void> {
    this.del(key);
  }

  async clear(): Promise<void> {
    this.clearAll();
  }

  async keys(): Promise<string[]> {
    return this.allKeys().map((r) => r.key);
  }
}
