import { createHash } from 'crypto';
import * as path from 'path';
import { z } from 'zod';
import type { McpLaunchConfiguration } from './conflictContract';

const filePath = z.string().min(1).max(4096);
export const uploadInputSchemas = {
  upload_files: {
    workspace: z.string().min(1).max(4096).describe('Workspace bucket or absolute project root.'),
    paths: z.array(filePath).min(1).max(100).describe('Saved files, relative to workspace or absolute. No directories.'),
    timeoutSeconds: z.number().int().min(1).max(60).optional().default(30),
  },
  uploads_wait: {
    workspace: z.string().min(1).max(4096),
    operationId: z.string().uuid(),
    timeoutSeconds: z.number().int().min(1).max(60).optional().default(30),
  },
};

export const uploadRequestSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  capability: z.string().min(32).max(256),
  workspace: z.string().min(1).max(4096),
  paths: z.array(filePath).min(1).max(100),
  createdAt: z.string().datetime(),
});
export type UploadRequest = z.infer<typeof uploadRequestSchema>;

export const uploadItemSchema = z.object({
  path: filePath,
  status: z.enum(['pending', 'uploading', 'conflict', 'uploaded', 'skipped', 'failed', 'cancelled']),
  conflictId: z.string().max(180).optional(),
  revision: z.number().int().positive().optional(),
  message: z.string().max(800).optional(),
  warnings: z.array(z.string().max(800)).max(100).optional(),
});
export type UploadItem = z.infer<typeof uploadItemSchema>;
export const uploadJobSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  session: z.string().regex(/^[a-f0-9]{64}$/),
  workspace: z.string(),
  terminal: z.boolean(),
  files: z.array(uploadItemSchema).min(1).max(100),
});
export type UploadJob = z.infer<typeof uploadJobSchema>;

export function uploadSession(config: McpLaunchConfiguration): string {
  return createHash('sha256').update(config.capability).digest('hex');
}

export function uploadBridgeRoot(config: McpLaunchConfiguration): string {
  return path.join(config.stateRoot, 'uploads', uploadSession(config));
}

export function uploadSummary(job: UploadJob): Record<string, unknown> {
  return {
    operationId: job.operationId,
    workspace: job.workspace,
    terminal: job.terminal,
    uploaded: job.files.filter(file => file.status === 'uploaded').length,
    total: job.files.length,
    // Successful paths without warnings are already known to the caller.
    files: job.files.filter(file => file.status !== 'uploaded' || file.warnings?.length),
  };
}
