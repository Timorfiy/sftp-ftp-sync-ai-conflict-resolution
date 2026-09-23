jest.mock('../../src/logger', () => ({
  __esModule: true,
  default: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../src/app', () => ({
  __esModule: true,
  default: {
    fsCache: new Map(),
    state: {},
    sftpBarItem: { showMsg: jest.fn(), reset: jest.fn(), startSpinner: jest.fn(), stopSpinner: jest.fn() },
  },
}));
jest.mock('../../src/host', () => ({
  promptForPassword: jest.fn(),
  showConfirmMessage: jest.fn(async () => false),
  showWarningMessage: jest.fn(),
  getOpenTextDocuments: jest.fn(() => []),
  getUserSetting: jest.fn(() => ({ get: jest.fn(() => false), update: jest.fn() })),
}));
jest.mock('../../src/modules/secrets', () => ({
  storeCredential: jest.fn(),
  getCredential: jest.fn(async () => undefined),
}));
jest.mock('../../src/core/remote-client/hostKeyStore', () => ({
  checkHostKey: jest.fn(async () => true),
}));
jest.mock('../../src/modules/connectionHealth', () => ({
  setConnectionState: jest.fn(),
  removeConnection: jest.fn(),
}));
jest.mock('../../src/fileHandlers/transfer/conflictBridge', () => ({
  acceptBatchOverwrite: jest.fn(async () => true),
  captureConflict: jest.fn(async () => ({ root: 'fixture', record: { id: 'conflict' } })),
  markConflictFailed: jest.fn(),
  markConflictUploaded: jest.fn(),
  markConflictUploading: jest.fn(async () => ({ root: 'fixture', id: 'conflict' })),
  waitForConflictDecision: jest.fn(async () => 'cancel'),
}));

const startFTPServer = require('../fixtures/ftpServer');
const protocolContract = require('./protocolContract');

protocolContract({
  protocol: 'ftp',
  startServer: () => startFTPServer(),
  startUnknownTimestampServer: () => startFTPServer({ mdtm: false }),
});
