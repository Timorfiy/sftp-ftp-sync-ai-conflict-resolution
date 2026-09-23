import { z } from 'zod';

export const MCP_PROVIDER_ID = 'sftpSyncAI.conflicts';
export const MCP_SERVER_NAME = 'sftp-sync-ai-conflicts';
export const MCP_CONFIG_ENV = 'SFTP_SYNC_AI_MCP_CONFIG';
export const CONFLICT_PROTOCOL_VERSION = 3;

export const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024;
export const MAX_READ_BYTES = 64 * 1024;
export const MAX_DIFF_BYTES_PER_SIDE = 256 * 1024;
export const MAX_WAIT_SECONDS = 120;

export const conflictStatusSchema = z.enum([
  'capturing',
  'pending',
  'reviewing',
  'resolving',
  'uploading',
  'uploaded',
  'cancelled',
  'failed',
  'orphaned',
]);

export type ConflictStatus = z.infer<typeof conflictStatusSchema>;

export const mutableConflictStatusSchema = z.enum([
  'capturing',
  'pending',
  'reviewing',
]);

export const conflictIdSchema = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Conflict IDs cannot contain path separators.');

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const mcpWorkspaceSchema = z.object({
  bucket: sha256Schema,
  root: z.string().min(1),
  name: z.string().min(1).max(200),
});

export const mcpLaunchConfigurationSchema = z.object({
  version: z.literal(1),
  extensionVersion: z.string().min(1).max(100),
  stateRoot: z.string().min(1),
  capability: z.string().min(32).max(256),
  workspaces: z.array(mcpWorkspaceSchema).min(1).max(64),
});

export type McpLaunchConfiguration = z.infer<typeof mcpLaunchConfigurationSchema>;

const bridgeRequestBase = {
  version: z.literal(CONFLICT_PROTOCOL_VERSION),
  requestId: z.string().uuid(),
  capability: z.string().min(32).max(256),
  expectedRevision: z.number().int().positive(),
  createdAt: z.string().datetime(),
};

export const conflictBridgeRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    ...bridgeRequestBase,
    kind: z.literal('submit_local'),
    expectedLocalSha256: sha256Schema.nullable(),
    content: z.string().max(MAX_CANDIDATE_BYTES),
  }),
  z.object({
    ...bridgeRequestBase,
    kind: z.literal('acknowledge_local'),
    expectedLocalSha256: sha256Schema,
  }),
  z.object({
    ...bridgeRequestBase,
    kind: z.literal('resolve'),
    action: z.enum(['upload', 'cancel']),
  }),
]);

export type ConflictBridgeRequest = z.infer<typeof conflictBridgeRequestSchema>;

export const conflictBridgeResponseSchema = z.object({
  version: z.literal(CONFLICT_PROTOCOL_VERSION),
  requestId: z.string().uuid(),
  conflictId: conflictIdSchema,
  revision: z.number().int().positive(),
  status: conflictStatusSchema,
  respondedAt: z.string().datetime(),
  accepted: z.boolean(),
  stale: z.boolean().optional(),
  error: z.string().max(200).optional(),
  message: z.string().max(1000).optional(),
  candidateSha256: sha256Schema.optional(),
});

export type ConflictBridgeResponse = z.infer<typeof conflictBridgeResponseSchema>;

export const conflictSelectorShape = {
  conflictId: conflictIdSchema.describe('Conflict ID returned by conflicts_list.'),
  workspace: sha256Schema
    .optional()
    .describe('Optional workspace bucket returned by conflicts_list for multi-root disambiguation.'),
};

export const toolInputSchemas = {
  conflicts_list: {
    includeTerminal: z
      .boolean()
      .optional()
      .default(false)
      .describe('Include uploaded, failed, cancelled, and orphaned history.'),
    limit: z.number().int().min(1).max(100).optional().default(25),
  },
  conflicts_get: conflictSelectorShape,
  conflicts_read: {
    ...conflictSelectorShape,
    side: z.enum(['local', 'remote']),
    offset: z.number().int().min(0).max(100 * 1024 * 1024).optional().default(0),
    maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).optional().default(MAX_READ_BYTES),
  },
  conflicts_diff: conflictSelectorShape,
  conflicts_submit_local: {
    ...conflictSelectorShape,
    expectedRevision: z.number().int().positive(),
    expectedLocalSha256: sha256Schema.nullable(),
    content: z
      .string()
      .max(MAX_CANDIDATE_BYTES)
      .describe('Complete UTF-8 text to atomically replace the conflict local file.'),
  },
  conflicts_acknowledge_local: {
    ...conflictSelectorShape,
    expectedRevision: z.number().int().positive(),
    expectedLocalSha256: sha256Schema.describe(
      'SHA-256 of the already-saved local file returned by conflicts_read.'
    ),
  },
  conflicts_resolve: {
    ...conflictSelectorShape,
    expectedRevision: z.number().int().positive(),
    action: z.enum(['upload', 'cancel']),
  },
  conflicts_wait: {
    ...conflictSelectorShape,
    expectedRevision: z.number().int().positive(),
    timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().default(30),
  },
} as const;

export const TOOL_DESCRIPTIONS = {
  conflicts_list:
    'List conflicts scoped to the currently open workspace roots. Active conflicts are returned by default.',
  conflicts_get:
    'Get safe context for one conflict, including revision, status, workspace-relative path, hashes, and candidate state.',
  conflicts_read:
    'Read a bounded UTF-8 chunk from the exact local file or captured remote snapshot for one conflict.',
  conflicts_diff:
    'Return a bounded text diff between the captured remote snapshot and current local file.',
  conflicts_submit_local:
    'Safely submit complete merged UTF-8 local content through the live extension. This does not upload.',
  conflicts_acknowledge_local:
    'Acknowledge an already-saved local edit after verifying its SHA-256 through the live extension. This does not upload.',
  conflicts_resolve:
    'Upload an acknowledged/submitted candidate or cancel the conflict, using the current expected revision.',
  conflicts_wait:
    'Wait boundedly for uploaded, failed, cancelled, or stale status.',
} as const;

export type ConflictToolName = keyof typeof TOOL_DESCRIPTIONS;
