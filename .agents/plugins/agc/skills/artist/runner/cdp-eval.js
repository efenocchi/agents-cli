const WebSocket = require('ws');
const tabId = process.argv[2];
const expression = process.argv[3];
const ws = new WebSocket(`ws://localhost:9222/devtools/page/${tabId}`);
let id = 0;
const send = (method, params={}) => new Promise((resolve) => {
  const myId = ++id;
  const handler = (data) => {
    const msg = JSON.parse(data);
    if (msg.id === myId) { ws.off('message', handler); resolve(msg); }
  };
  ws.on('message', handler);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
ws.on('open', async () => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(result.result, null, 2));
  ws.close();
  process.exit(0);
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
