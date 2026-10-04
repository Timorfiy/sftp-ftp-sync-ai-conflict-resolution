import * as vscode from 'vscode';
import { handleCtxFromUri } from '../fileHandlers/createFileHandler';
import { uploadFile } from '../fileHandlers/transfer';
import { isConflictPathActive } from '../fileHandlers/transfer/conflictBridge';
import { isConflictStatePath } from '../fileHandlers/transfer/conflictStateIsolation';
import { localPathKey, localPathContains } from '../helper/localPaths';
import { requireSafeLocalPath } from '../helper/safeLocalPath';
import { activityStore, currentActivity, withActivityInvocation } from '../modules/activity';
import { getOpenTextDocuments } from '../host';
import { redactedErrorMessage } from '../security/redaction';
import type { UploadRunner } from './uploadBridge';

export const runMcpUpload: UploadRunner = async (workspace, file, update, signal) => {
  await requireSafeLocalPath(workspace, file, { type: 'file' });
  if (isConflictStatePath(file)) throw new Error('Private conflict state cannot be uploaded.');
  if (getOpenTextDocuments().some(doc => localPathKey(doc.uri.fsPath) === localPathKey(file) && doc.isDirty)) {
    throw new Error('Save or revert the dirty editor buffer before uploading.');
  }
  if (isConflictPathActive(file)) throw new Error('This file already has an active conflict; use conflict tools.');
  const ctx = handleCtxFromUri(vscode.Uri.file(file));
  if (localPathKey(ctx.fileService.workspace) !== localPathKey(workspace) || !localPathContains(ctx.fileService.baseDir, file)) {
    throw new Error('The file does not belong to the selected configured workspace.');
  }
  if (ctx.config.ignore?.(file)) return { status: 'skipped', message: 'Excluded by project configuration.' };
  ctx.onUploadConflict = async (conflictId, revision) => update({ status: 'conflict', conflictId, revision });
  return withActivityInvocation('MCP upload', async () => {
    const scope = currentActivity()!;
    const cancel = () => { if (scope.group) activityStore.cancel(scope.group.id); };
    signal.addEventListener('abort', cancel, { once: true });
    let error: unknown;
    try {
      if (signal.aborted) return { status: 'cancelled' };
      await uploadFile(ctx);
    } catch (failure) { error = failure; }
    finally { signal.removeEventListener('abort', cancel); }
    const item = [...(scope.group?.items.values() || [])].find(candidate =>
      candidate.kind === 'upload' && localPathKey(candidate.localPath) === localPathKey(file));
    if (item?.status === 'completed') {
      const warnings = [...item.warnings];
      if (error) warnings.push(redactedErrorMessage(error));
      return { status: 'uploaded', ...(warnings.length ? { warnings: warnings.map(text => text.slice(0, 800)).slice(0, 100) } : {}) };
    }
    if (item?.status === 'cancelled' || scope.group?.cancelRequested || signal.aborted) return { status: 'cancelled' };
    if (error) throw error;
    return { status: 'failed', message: 'The transfer did not report a completed upload.' };
  });
};
