import * as path from 'path';
import * as vscode from 'vscode';
import logger from '../logger';
import * as output from '../ui/output';
import { COMMAND_CONFIG, COMMAND_OPEN_TROUBLESHOOTING } from '../constants';
import {
  ActionableError,
  actionableMessage,
  classifyError,
  ErrorContext,
  RecoveryActionId,
} from './actionable';

const ACTION_LABELS: Record<RecoveryActionId, string> = {
  'open-config': 'Open Config',
  retry: 'Retry',
  'review-conflict': 'Review Conflict',
  'copy-diagnostics': 'Copy Diagnostics',
  troubleshoot: 'Troubleshoot',
  'show-output': 'Show Output',
};

let extensionPath: string | undefined;

export function initializeErrorReporter(context: vscode.ExtensionContext): void {
  extensionPath = context.extensionPath;
  context.subscriptions.push(
    vscode.commands.registerCommand(
      COMMAND_OPEN_TROUBLESHOOTING,
      (section?: string) => openTroubleshooting(section || 'overview')
    )
  );
}

export async function openTroubleshooting(section: string): Promise<void> {
  if (!extensionPath) {
    output.show();
    return;
  }
  const uri = vscode.Uri.file(path.join(extensionPath, 'docs', 'troubleshooting.md')).with({
    fragment: section,
  });
  await vscode.commands.executeCommand('markdown.showPreview', uri);
}

async function performAction(
  action: RecoveryActionId,
  actionable: ActionableError,
  context: ErrorContext
): Promise<void> {
  switch (action) {
    case 'open-config':
      await vscode.commands.executeCommand(COMMAND_CONFIG);
      return;
    case 'retry':
      await context.retry?.();
      return;
    case 'review-conflict':
      await context.reviewConflict?.();
      return;
    case 'copy-diagnostics':
      await vscode.env.clipboard.writeText(actionable.diagnostics);
      return;
    case 'troubleshoot':
      await openTroubleshooting(actionable.troubleshootingSection);
      return;
    case 'show-output':
      output.show();
      return;
  }
}

export async function reportActionableError(
  error: unknown,
  context: ErrorContext = {}
): Promise<ActionableError> {
  const actionable = classifyError(error, context);
  logger.error(actionable.diagnostics, context.operation);

  const labels = actionable.actions.map(action => ACTION_LABELS[action]);
  const message = actionableMessage(actionable);
  let selected: string | undefined;
  if (actionable.severity === 'information') {
    selected = await vscode.window.showInformationMessage(message, ...labels);
  } else if (actionable.severity === 'warning') {
    selected = await vscode.window.showWarningMessage(message, ...labels);
  } else {
    selected = await vscode.window.showErrorMessage(message, ...labels);
  }

  const action = actionable.actions.find(candidate => ACTION_LABELS[candidate] === selected);
  if (action) {
    await performAction(action, actionable, context);
  }
  return actionable;
}
