const fs = require('node:fs/promises');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(150);
  }
  throw new Error(`Timed out: ${description}`);
}

async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(3000),
  })).json();
  const page = targets.find(target => target.type === 'page' && /workbench\.html/.test(target.url));
  if (!page) throw new Error('No editor workbench target');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timeout')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
  });
  let id = 0;
  const pending = new Map();
  function rejectPending() {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('CDP closed')); }
    pending.clear();
  }
  socket.addEventListener('close', rejectPending);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  function send(method, params = {}) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  async function key(key, code, virtualKey, modifiers = 0) {
    const common = { key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }
  return {
    send, evaluate, key,
    text: () => evaluate('document.body.innerText'),
    async command(label) {
      await key('P', 'KeyP', 80, 2 | 8);
      await sleep(300);
      await send('Input.insertText', { text: label });
      await sleep(500);
      await key('Enter', 'Enter', 13);
    },
    async click(text) {
      const point = await evaluate(`(() => {
        const wanted = ${JSON.stringify(text)};
        const node = [...document.querySelectorAll('button,a,[role="button"],.monaco-button,.action-label')]
          .find(node => {
            const rect = node.getBoundingClientRect();
            return rect.width && rect.height &&
              ((node.innerText || node.textContent || '').trim() === wanted || node.getAttribute('aria-label') === wanted);
          });
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        if (!node.contains(document.elementFromPoint(point.x, point.y))) return false;
        return point;
      })()`);
      if (!point) return false;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      return true;
    },
    async row(labelPart, button = 'left') {
      const point = await waitFor(() => evaluate(`(() => {
        const row = [...document.querySelectorAll('.monaco-list-row')]
          .find(node => (node.getAttribute('aria-label') || '').includes(${JSON.stringify(labelPart)}));
        if (!row) return false;
        row.scrollIntoView({block:'nearest'});
        const rect = row.getBoundingClientRect();
        return { x: rect.x + Math.min(90, rect.width / 2), y: rect.y + rect.height / 2 };
      })()`), 'tree row');
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 });
    },
    async pick(text) {
      // A just-reopened picker animates after its text is already observable.
      // Wait for it to settle and hit-test before sending the single decision.
      await sleep(450);
      const point = await waitFor(() => evaluate(`(() => {
        const row = [...document.querySelectorAll('.quick-input-list .monaco-list-row')]
          .find(node => node.textContent.includes(${JSON.stringify(text)}));
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const point = { x: rect.x + Math.min(80, rect.width / 2), y: rect.y + rect.height / 2 };
        if (!row.contains(document.elementFromPoint(point.x, point.y))) return false;
        return point;
      })()`), `quick pick ${text}`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    },
    async screenshot(file) {
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await fs.writeFile(file, Buffer.from(result.data, 'base64'));
    },
    close() { rejectPending(); socket.close(); },
  };
}

module.exports = { connect, waitFor, sleep };
