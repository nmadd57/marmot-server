export interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  id?: string | number | null;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** signal-cli group shape (subset of fields clients expect) */
export interface SignalGroup {
  id: string; // base64-encoded group ID
  name: string;
  description: string;
  isMember: boolean;
  isBlocked: boolean;
  members: string[];
  pendingMembers: string[];
  requestingMembers: string[];
  admins: string[];
  messageExpirationTime: number;
  isAnnouncementGroup: boolean;
  groupInviteLink: string | null;
}

/** signal-cli SSE envelope for a group data message */
export interface SignalEnvelope {
  source: string;
  sourceNumber: string | null;
  sourceDevice: number;
  timestamp: number;
  dataMessage: {
    timestamp: number;
    message: string | null;
    expiresInSeconds: number;
    viewOnce: boolean;
    groupInfo: {
      groupId: string; // base64
      type: "DELIVER" | "UPDATE" | "QUIT" | "UNKNOWN";
    };
  };
}
