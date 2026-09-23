import * as vscode from 'vscode';
import app from '../app';
import { EXTENSION_NAME } from '../constants';
import { redact, redactText } from '../security/redaction';
import StatusBarItem from './statusBarItem';

let isShow = false;
const outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);

export function show() {
  app.sftpBarItem.updateStatus(StatusBarItem.Status.ok);
  outputChannel.show();
  isShow = true;
}

export function hide() {
  outputChannel.hide();
  isShow = false;
}

export function toggle() {
  if (isShow) {
    hide();
  } else {
    show();
  }
}

export function print(...args) {
  const msg = args
    .map(arg => {
      if (!arg) {
        return arg;
      }

      if (arg instanceof Error) {
        return redactText(arg.stack || arg.message);
      } else if (!arg.toString || arg.toString() === '[object Object]') {
        return JSON.stringify(redact(arg));
      }

      return typeof arg === 'string' ? redactText(arg) : arg;
    })
    .join(' ');

  outputChannel.appendLine(msg);
}
