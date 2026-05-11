import { CDPClient, discoverBrowserWsUrl, verifyBrowserIdentity } from '../cdp.js';
import { launchBrowser, allocatePort, getPortOccupant } from '../chrome.js';
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

    // Distinguish "nothing listening on this port" (fine to launch fresh) from
    // "something is listening but it's not a debuggable browser" (bail loudly —
    // silently launching on a different port leads to confusing `pid 0` and
    // `CDP connection not open` errors downstream).
    const occupant = getPortOccupant(port);
    if (occupant) {
      throw new Error(
        `Port ${port} is occupied by ${occupant.command} (pid ${occupant.pid}) but is ` +
          `not serving the Chrome DevTools Protocol. Either stop that process ` +
          `(\`kill ${occupant.pid}\`) or restart it with \`--remote-debugging-port=${port}\` ` +
          `so profile "${profile.name}" can attach.`
      );
    }

    const newPort = allocatePort();
    const chromeOpts = { ...profile.chrome, viewport: profile.viewport };
    const { pid, wsUrl } = await launchBrowser(
      profile.name,
      profile.browser,
      newPort,
      chromeOpts,
      profile.secrets,
      profile.binary
    );
    const cdp = new CDPClient();
    await cdp.connect(wsUrl);

    return { cdp, port: newPort, pid };
  }
}
