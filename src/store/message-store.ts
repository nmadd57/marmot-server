import Database from "better-sqlite3";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { deserializeApplicationData } from "@internet-privacy/marmot-ts";
import type { BaseGroupHistory } from "@internet-privacy/marmot-ts/client";

export interface StoredMessage {
  id: string;
  groupId: string;
  sender: string;
  kind: number;
  content: string;
  tags: string[][];
  createdAt: number;
}

export class MessageStore {
  private readonly insert: (
    id: string,
    groupId: string,
    sender: string,
    kind: number,
    content: string,
    tags: string,
    createdAt: number
  ) => void;
  private readonly listByGroup: (
    groupId: string,
    limit: number,
    since: number
  ) => { id: string; sender: string; kind: number; content: string; tags: string; created_at: number }[];
  private readonly deleteByGroup: (groupId: string) => void;

  constructor(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        kind INTEGER NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_group_id ON messages (group_id, created_at);
    `);

    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO messages (id, group_id, sender, kind, content, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const listStmt = db.prepare<
      [string, number, number],
      { id: string; sender: string; kind: number; content: string; tags: string; created_at: number }
    >(
      `SELECT id, sender, kind, content, tags, created_at
       FROM messages WHERE group_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?`
    );
    const deleteStmt = db.prepare(`DELETE FROM messages WHERE group_id = ?`);

    this.insert = (id, groupId, sender, kind, content, tags, createdAt) => {
      insertStmt.run(id, groupId, sender, kind, content, tags, createdAt);
    };
    this.listByGroup = (groupId, limit, since) =>
      listStmt.all(groupId, since, limit);
    this.deleteByGroup = (groupId) => {
      deleteStmt.run(groupId);
    };
  }

  saveRumor(groupId: string, rumor: Rumor): void {
    this.insert(
      rumor.id,
      groupId,
      rumor.pubkey,
      rumor.kind,
      rumor.content,
      JSON.stringify(rumor.tags),
      rumor.created_at
    );
  }

  list(groupId: string, limit = 50, since = 0): StoredMessage[] {
    return this.listByGroup(groupId, limit, since).map((row) => ({
      id: row.id,
      groupId,
      sender: row.sender,
      kind: row.kind,
      content: row.content,
      tags: JSON.parse(row.tags) as string[][],
      createdAt: row.created_at,
    }));
  }

  purge(groupId: string): void {
    this.deleteByGroup(groupId);
  }

  /** Creates a BaseGroupHistory adapter for a specific group */
  historyFor(groupId: string): BaseGroupHistory {
    const store = this;
    return {
      async saveMessage(message: Uint8Array): Promise<void> {
        try {
          const rumor = deserializeApplicationData(message);
          store.saveRumor(groupId, rumor);
        } catch {
          // ignore undeserializable messages
        }
      },
      async purgeMessages(): Promise<void> {
        store.purge(groupId);
      },
    };
  }
}
