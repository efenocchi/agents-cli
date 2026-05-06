import type { CDPClient } from './cdp.js';
import type { RefNode, resolveRefToCoords } from './refs.js';

export async function clickAtCoords(
  cdp: CDPClient,
  sessionId: string,
  x: number,
  y: number
): Promise<void> {
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
    sessionId
  );
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
    sessionId
  );
}

export async function hoverAtCoords(
  cdp: CDPClient,
  sessionId: string,
  x: number,
  y: number
): Promise<void> {
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x, y },
    sessionId
  );
}

export async function typeText(
  cdp: CDPClient,
  sessionId: string,
  text: string
): Promise<void> {
  for (const char of text) {
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', text: char },
      sessionId
    );
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', text: char },
      sessionId
    );
  }
}

const KEY_CODES: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
};

export async function pressKey(
  cdp: CDPClient,
  sessionId: string,
  keyName: string
): Promise<void> {
  const keyInfo = KEY_CODES[keyName];
  if (!keyInfo) {
    throw new Error(`Unknown key: ${keyName}. Valid: ${Object.keys(KEY_CODES).join(', ')}`);
  }

  await cdp.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyDown',
      key: keyInfo.key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
      nativeVirtualKeyCode: keyInfo.keyCode,
    },
    sessionId
  );
  await cdp.send(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: keyInfo.key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
      nativeVirtualKeyCode: keyInfo.keyCode,
    },
    sessionId
  );
}

export async function focusNode(
  cdp: CDPClient,
  sessionId: string,
  backendNodeId: number
): Promise<void> {
  await cdp.send('DOM.focus', { backendNodeId }, sessionId);
}
