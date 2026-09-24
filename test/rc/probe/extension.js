// A separately installed QA extension. No product/SecretStorage/UI/MCP mocks,
// registration interception, or imports from the product bundle.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
let server;

async function activate(context) {
  const root = process.env.SFTP_RC_ROOT;
  if (!root) throw new Error('The QA probe requires an isolated RC runner');
  const workspace = path.join(root, 'workspace');
  if (vscode.workspace.workspaceFolders?.length !== 1 ||
      path.resolve(vscode.workspace.workspaceFolders[0].uri.fsPath).toLowerCase() !== workspace.toLowerCase()) {
    throw new Error('Wrong QA workspace');
  }
  const product = vscode.extensions.getExtension('Timorfiy.sftp-sync-ai');
  if (!product) throw new Error('Candidate not installed');
  await product.activate();
  const token = crypto.randomBytes(32).toString('hex');
  const jobs = new Map();
  let clipboardBefore;
  let sequence = 0;
  const info = async () => ({
    editor: vscode.env.appName, version: vscode.version, language: vscode.env.language,
    productVersion: product.packageJSON.version, productActive: product.isActive,
    extensionPath: product.extensionPath, workspace,
    commands: (await vscode.commands.getCommands(true)).filter(command =>
      /^(sftpSyncAI\.|workbench\.mcp\.)/.test(command)),
  });
  const deserialize = value => {
    if (Array.isArray(value)) return value.map(deserialize);
    if (value && typeof value === 'object' && typeof value.file === 'string') {
      const file = path.resolve(workspace, value.file);
      if (!file.startsWith(workspace + path.sep)) throw new Error('QA file outside workspace');
      return vscode.Uri.file(file);
    }
    return value;
  };
  async function operation(request) {
    if (request.op === 'info') return info();
    if (request.op === 'captureClipboard') {
      if (clipboardBefore !== undefined) throw new Error('Clipboard is already captured');
      clipboardBefore = await vscode.env.clipboard.readText();
      await vscode.env.clipboard.writeText('');
      return true;
    }
    if (request.op === 'restoreClipboard') {
      if (clipboardBefore !== undefined) await vscode.env.clipboard.writeText(clipboardBefore);
      clipboardBefore = undefined;
      return true;
    }
    if (request.op === 'diagnostics') {
      const text = await vscode.env.clipboard.readText();
      // Do not expose arbitrary clipboard content. The driver must first choose
      // this product's Copy Diagnostics action in the isolated window.
      const parsed = JSON.parse(text);
      if (parsed.operation !== 'read Remote Explorer folder' || !parsed.failureId) {
        throw new Error('Clipboard does not contain the requested Remote Explorer diagnostics');
      }
      return parsed;
    }
    if (request.op === 'save') {
      const uri = deserialize({ file: request.file });
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), request.content);
      if (!(await vscode.workspace.applyEdit(edit)) || !(await doc.save())) throw new Error('QA editor save failed');
      return { saved: true, dirty: doc.isDirty };
    }
    if (request.op === 'job') {
      if (!jobs.has(request.id)) throw new Error('Unknown QA job');
      const result = jobs.get(request.id);
      if (result.status !== 'pending') jobs.delete(request.id);
      return result;
    }
    if (request.op === 'start') {
      if (jobs.size >= 20) throw new Error('QA job limit reached');
      if (!/^(sftpSyncAI\.|workbench\.|vscode\.|notifications\.|notification\.|setContext$)/.test(request.command)) {
        throw new Error('Command not permitted by QA probe');
      }
      const id = ++sequence;
      jobs.set(id, { status: 'pending' });
      Promise.resolve(vscode.commands.executeCommand(
        request.command, ...(request.args || []).map(deserialize)
      )).then(
        () => jobs.set(id, { status: 'done' }),
        error => jobs.set(id, { status: 'error', error: error.message })
      );
      return { id };
    }
    if (request.op === 'tools') {
      return Array.from(vscode.lm.tools || []).map(({ name, description, inputSchema }) =>
        ({ name, description, inputSchema }));
    }
    if (request.op === 'tabs') {
      return vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({
        label: tab.label, type: tab.input instanceof vscode.TabInputTextDiff ? 'textDiff' : 'other',
        dirty: tab.isDirty, uri: tab.input?.uri?.toString(),
      })));
    }
    throw new Error('Unknown QA operation');
  }
  server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.method !== 'POST') {
      res.writeHead(403).end(); return;
    }
    try {
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 256 * 1024) throw new Error('QA request too large');
        chunks.push(chunk);
      }
      const result = await operation(JSON.parse(Buffer.concat(chunks)));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
  server.requestTimeout = 65000;
  server.headersTimeout = 10000;
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(path.join(root, 'probe.json'), JSON.stringify({ port: server.address().port, token }));
  });
  context.subscriptions.push({ dispose() { server.closeAllConnections(); server.close(); } });
}

module.exports = { activate };
