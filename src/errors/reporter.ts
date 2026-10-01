import * as path from 'path';
import * as vscode from 'vscode';
import logger from '../logger';
import * as output from '../ui/output';
import { captureActivityError } from '../modules/activity';
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

export async function showErrorDetails(actionable: ActionableError, context: ErrorContext = {}): Promise<void> {
  const actions = actionable.actions.filter(action => action !== 'retry' || (actionable.retrySafety === 'safe' && Boolean(context.retry)));
  const choice = await vscode.window.showQuickPick(actions.map(action => ({ label: ACTION_LABELS[action],
    description: action === 'show-output' ? actionable.summary : undefined, action })),
  { title: context.operation ? `${actionable.title} · ${context.operation}` : actionable.title, placeHolder: actionableMessage(actionable) });
  if (choice) await performAction(choice.action, actionable, context);
}

export async function reportActionableError(
  error: unknown,
  context: ErrorContext = {}
): Promise<ActionableError> {
  const actionable = classifyError(error, context);
  logger.error(actionable.diagnostics, context.operation);
  if (captureActivityError(error, context)) return actionable;

  const primary = actionable.actions.find(action => ['open-config', 'retry', 'review-conflict'].includes(action));
  const labels = [...(primary ? [ACTION_LABELS[primary]] : []), 'Details'];
  const message = `${actionable.title}: ${actionable.summary}`;
  let selected: string | undefined;
  if (actionable.severity === 'information') {
    selected = await vscode.window.showInformationMessage(message, ...labels);
  } else if (actionable.severity === 'warning') {
    selected = await vscode.window.showWarningMessage(message, ...labels);
  } else {
    selected = await vscode.window.showErrorMessage(message, ...labels);
  }

  if (selected === 'Details') {
    await showErrorDetails(actionable, context);
    return actionable;
  }
  const action = primary && ACTION_LABELS[primary] === selected ? primary : undefined;
  if (action) {
    await performAction(action, actionable, context);
  }
  return actionable;
}
