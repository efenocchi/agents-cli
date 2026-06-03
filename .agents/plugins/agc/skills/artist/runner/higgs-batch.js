// Run one generation batch using CDP Input domain (Lexical-compatible).
// Usage: node higgs-batch.js <tabId> <variantSlug> "<prompt>"
const WebSocket = require('ws');

const tabId = process.argv[2];
const slug = process.argv[3];
const prompt = process.argv[4];
if (!tabId || !slug || !prompt) {
  console.error('usage: higgs-batch.js <tabId> <slug> <prompt>');
  process.exit(2);
}

const USER = 'user_32IZxcf50OUWPPQMLGusPynU3CF';
const ws = new WebSocket(`ws://localhost:9222/devtools/page/${tabId}`);
let id = 0;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    const handler = (data) => {
      const msg = JSON.parse(data);
      if (msg.id === myId) {
        ws.off('message', handler);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

const evalJs = (expression) =>
  send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Key dispatch helper. For Cmd+A on mac we need modifier=4 (Meta).
const keyDown = (params) => send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
const keyUp = (params) => send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });

// Extract our user's UUIDs sorted by timestamp.
const extractByTime = (urls, afterTimestamp) => {
  const seen = new Set();
  const out = [];
  const re = new RegExp(USER + '/(hf_(\\d{8})_(\\d{6})_[0-9a-f-]{36})', 'g');
  for (const u of urls) {
    const dec = decodeURIComponent(u || '');
    let m;
    while ((m = re.exec(dec)) !== null) {
      const fullId = m[1];
      if (seen.has(fullId)) continue;
      seen.add(fullId);
      const ts = m[2] + m[3];
      if (ts > afterTimestamp) out.push({ id: fullId, ts });
    }
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
};

(async () => {
  await new Promise((r) => ws.on('open', r));

  // 1. Remove any lingering reference-image attachment.
  await evalJs(`
    (function(){
      const objImg = Array.from(document.querySelectorAll('img')).find(i => (i.alt||'') === 'object image');
      if (!objImg) return false;
      const btn = objImg.parentElement.parentElement.querySelectorAll('button')[0];
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);
  await sleep(400);

  // 2. Focus the prompt textbox.
  const focusRes = await evalJs(`
    (function(){
      const tb = document.querySelector('[contenteditable=true]');
      tb.focus();
      // Place selection at end
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(tb);
      sel.addRange(range);
      const rect = tb.getBoundingClientRect();
      return { focused: document.activeElement === tb, x: rect.x + 20, y: rect.y + 20 };
    })()
  `);
  const { x, y, focused } = focusRes.result.value;
  console.error(JSON.stringify({ phase: 'focus', focused }));

  // 3. Click into the textbox via Input.dispatchMouseEvent to ensure browser focus.
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(120);

  // 4. Cmd+A then Backspace to clear (real keyboard events — Lexical respects these).
  await keyDown({ modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await keyUp({ modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await sleep(80);
  await keyDown({ key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await keyUp({ key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await sleep(200);

  // Verify cleared
  const cleared = await evalJs(`
    (function(){ const tb = document.querySelector('[contenteditable=true]'); return (tb.innerText||'').length; })()
  `);
  console.error(JSON.stringify({ phase: 'cleared', len: cleared.result.value }));
  if (cleared.result.value > 5) {
    // Hammer it once more with multiple backspaces
    for (let i = 0; i < 4; i++) {
      await keyDown({ modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await keyUp({ modifiers: 4, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await sleep(40);
      await keyDown({ key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await keyUp({ key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await sleep(40);
    }
    const c2 = await evalJs(`(function(){ const tb = document.querySelector('[contenteditable=true]'); return (tb.innerText||'').length; })()`);
    console.error(JSON.stringify({ phase: 'cleared2', len: c2.result.value }));
  }

  // 5. Insert prompt via CDP Input.insertText — Lexical handles textInput events.
  await send('Input.insertText', { text: prompt });
  await sleep(400);

  // Verify prompt set
  const verify = await evalJs(`
    (function(){ const tb = document.querySelector('[contenteditable=true]'); return (tb.innerText||'').slice(0,80); })()
  `);
  const got = verify.result.value;
  console.error(JSON.stringify({ phase: 'set', sample: got.slice(0, 60) }));
  if (!got.startsWith(prompt.slice(0, 30))) {
    console.error(JSON.stringify({ phase: 'mismatch', expected: prompt.slice(0,30), got: got.slice(0,30) }));
    process.exit(4);
  }

  // 6. Capture baseline UUIDs BEFORE clicking Generate so we can set-diff.
  const baselineRes = await evalJs(`Array.from(document.querySelectorAll('img')).map(i => i.src || '')`);
  const baseline = new Set();
  {
    const re = new RegExp(USER + '/(hf_\\d{8}_\\d{6}_[0-9a-f-]{36})', 'g');
    for (const u of baselineRes.result.value || []) {
      const dec = decodeURIComponent(u || '');
      let m;
      while ((m = re.exec(dec)) !== null) baseline.add(m[1]);
    }
  }
  console.error(JSON.stringify({ phase: 'baseline', count: baseline.size }));

  // 7. Click Generate.
  const clickRes = await evalJs(`
    (function(){
      const tb = document.querySelector('[contenteditable=true]');
      let c = tb;
      for (let i=0; i<4; i++) c = c.parentElement;
      const btn = Array.from(c.querySelectorAll('button')).find(b => /^Generate\\b/.test((b.textContent||'').trim()));
      if (!btn) return { error: 'no btn' };
      btn.click();
      return { clicked: true, text: btn.textContent.trim() };
    })()
  `);
  console.error(JSON.stringify({ phase: 'click', ...clickRes.result.value }));

  // 8. Poll for 4 NEW UUIDs (not in baseline).
  const start = Date.now();
  const TIMEOUT_MS = 240_000;
  let lastReport = 0;
  const re = new RegExp(USER + '/(hf_(\\d{8})_(\\d{6})_[0-9a-f-]{36})', 'g');
  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(4000);
    const r = await evalJs(`Array.from(document.querySelectorAll('img')).map(i => i.src || '')`);
    const seen = new Set();
    const fresh = [];
    for (const u of r.result.value || []) {
      const dec = decodeURIComponent(u || '');
      let m;
      while ((m = re.exec(dec)) !== null) {
        const fid = m[1];
        if (baseline.has(fid) || seen.has(fid)) continue;
        seen.add(fid);
        fresh.push({ id: fid, ts: m[2] + m[3] });
      }
    }
    fresh.sort((a, b) => b.ts.localeCompare(a.ts));
    if (fresh.length !== lastReport) {
      lastReport = fresh.length;
      console.error(JSON.stringify({ phase: 'poll', new: fresh.length, elapsedSec: Math.round((Date.now()-start)/1000) }));
    }
    if (fresh.length >= 4) {
      const newestTs = fresh[0].ts;
      const cluster = fresh.filter((f) => f.ts === newestTs).slice(0, 4);
      if (cluster.length < 4) cluster.push(...fresh.filter((f) => f.ts !== newestTs).slice(0, 4 - cluster.length));
      console.log(JSON.stringify({ slug, ids: cluster.map((c) => c.id), ts: newestTs }));
      ws.close();
      process.exit(0);
    }
  }
  console.error(JSON.stringify({ phase: 'timeout', got: lastReport }));
  process.exit(1);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(3);
});
