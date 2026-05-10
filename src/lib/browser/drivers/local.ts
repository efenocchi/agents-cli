import { CDPClient, discoverBrowserWsUrl, verifyBrowserIdentity } from '../cdp.js';
import { launchBrowser, allocatePort } from '../chrome.js';
import type { BrowserProfile } from '../types.js';

export interface LocalConnection {
  cdp: CDPClient;
  port: number;
  pid: number;
}

export async function connectLocal(
  endpoint: string,
  profile: BrowserProfile
): Promise<LocalConnection> {
  const url = new URL(endpoint);

  if (url.protocol !== 'cdp:') {
    throw new Error(`Invalid local endpoint: ${endpoint}`);
  }

  const port = parseInt(url.port, 10) || 9222;

  try {
    const { wsUrl, browser } = await discoverBrowserWsUrl(port);
    verifyBrowserIdentity(browser, profile.browser, port);
    const cdp = new CDPClient();
    await cdp.connect(wsUrl);

    return { cdp, port, pid: 0 };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Browser identity mismatch')) {
      throw err;
    }
    const newPort = allocatePort();
    const { pid, wsUrl } = await launchBrowser(
      profile.name,
      profile.browser,
      newPort,
      profile.chrome,
      profile.secrets,
      profile.binary
    );
    const cdp = new CDPClient();
    await cdp.connect(wsUrl);

    return { cdp, port: newPort, pid };
  }
}
