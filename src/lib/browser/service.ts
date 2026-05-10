import * as fs from 'fs';
import * as path from 'path';
import { CDPClient, discoverBrowserWsUrl, verifyBrowserIdentity } from './cdp.js';
import {
  getProfile,
  getProfileRuntimeDir,
  getBrowserRuntimeDir,
  listProfiles,
  extractConfiguredPort,
} from './profiles.js';
import { killChrome, getRunningChromeInfo, launchBrowser, allocatePort } from './chrome.js';
import { connectLocal } from './drivers/local.js';
import { connectSSH } from './drivers/ssh.js';
import {
  generateTaskId,
  generateShortId,
  generateFunName,
  isValidTaskId,
  type Task,
  type TabInfo,
  type ProfileStatus,
  type TaskStatus,
  type BrowserProfile,
} from './types.js';
import { getRefs, resolveRefToCoords, type RefOpts, type RefNode } from './refs.js';
import { clickAtCoords, hoverAtCoords, typeText, pressKey, focusNode } from './input.js';
import { emit } from '../events.js';

interface ProfileConnection {
  cdp: CDPClient;
  port: number;
  pid: number;
  electron?: boolean;
  forkedFrom?: string;
  tasks: Map<string, Task>;
  targetCache?: { targets: TargetInfo[]; ts: number };
  sessionCache: Map<string, string>;
}

type TargetInfo = {
  targetId: string;
  url?: string;
  title?: string;
};

export class BrowserService {
  private connections = new Map<string, ProfileConnection>();
  private forkingProfiles = new Set<string>();

  async open(
    profileName: string,
    opts: { taskName?: string; url?: string } = {}
  ): Promise<{ task: string; name: string; tabId?: string; windowTargetId?: string }> {
    const profile = await getProfile(profileName);
    if (!profile) {
      throw new Error(`Profile "${profileName}" not found`);
    }

    const taskName = opts.taskName || generateFunName();
    const taskId = generateTaskId();

    let conn = this.connections.get(profileName);
    let effectiveProfileName = profileName;

    if (conn && conn.electron && conn.tasks.size > 0) {
      if (this.forkingProfiles.has(profileName)) {
        while (this.forkingProfiles.has(profileName)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const existingFork = this.findAvailableFork(profileName);
        if (existingFork) {
          conn = existingFork.conn;
          effectiveProfileName = existingFork.name;
        } else {
          throw new Error(`Fork in progress but no available fork found for "${profileName}"`);
        }
      } else {
        this.forkingProfiles.add(profileName);
        try {
          const { forkName, connection } = await this.forkElectronProfile(profile);
          conn = connection;
          effectiveProfileName = forkName;
        } finally {
          this.forkingProfiles.delete(profileName);
        }
      }
    } else if (!conn) {
      conn = await this.connectProfile(profile);
      this.connections.set(profileName, conn);
    }

    const { windowTargetId } = await this.createTaskWindow(conn, taskId);

    const task: Task = {
      id: taskId,
      name: taskName,
      profile: effectiveProfileName,
      windowTargetId,
      tabs: {},
      currentTabId: undefined,
      createdAt: Date.now(),
      pid: conn.pid,
    };

    // For Electron, track the window as a tab
    if (conn.electron && windowTargetId) {
      const shortId = generateShortId();
      task.tabs[shortId] = windowTargetId;
      task.currentTabId = shortId;
    }

    conn.tasks.set(taskName, task);
    await this.saveTaskState(effectiveProfileName, conn.tasks);

    emit('browser.launch', { profile: effectiveProfileName, task: taskName, pid: conn.pid });

    // If URL provided, open first tab
    let tabId: string | undefined;
    if (opts.url) {
      const result = await this.navigate(taskName, opts.url, effectiveProfileName);
      tabId = result.tabId;
    }

    return { task: taskId, name: taskName, tabId, windowTargetId };
  }

  async stop(taskName: string): Promise<{ ok: boolean; profile?: string }> {
    for (const [profileName, conn] of this.connections) {
      const task = conn.tasks.get(taskName);
      if (task) {
        // Close all tabs
        await Promise.all(
          Object.values(task.tabs).map((cdpId) =>
            conn.cdp.send('Target.closeTarget', { targetId: cdpId }).catch(() => {
              // Tab already closed
            })
          )
        );
        for (const cdpId of Object.values(task.tabs)) {
          conn.sessionCache.delete(cdpId);
        }
        this.invalidateTargetCache(conn);

        if (task.windowTargetId) {
          try {
            await conn.cdp.send('Target.closeTarget', { targetId: task.windowTargetId });
          } catch {
            // Window already closed
          }
        }

        conn.tasks.delete(taskName);
        await this.saveTaskState(profileName, conn.tasks);

        emit('browser.close', { profile: profileName, task: taskName });

        if (conn.forkedFrom && conn.tasks.size === 0) {
          conn.cdp.close();
          killChrome(conn.pid);
          this.connections.delete(profileName);
        }

        return { ok: true, profile: profileName };
      }
    }

    return { ok: false };
  }

  async stopProfile(profileName: string): Promise<void> {
    const conn = this.connections.get(profileName);
    if (conn) {
      conn.cdp.close();
      killChrome(conn.pid);
      this.connections.delete(profileName);
    }

    const runtimeDir = getProfileRuntimeDir(profileName);
    const pidFile = path.join(runtimeDir, 'pid');
    const portFile = path.join(runtimeDir, 'port');

    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      killChrome(pid);
      fs.unlinkSync(pidFile);
    }
    if (fs.existsSync(portFile)) {
      fs.unlinkSync(portFile);
    }
  }

  async navigate(
    taskId: string,
    url: string,
    profileName?: string
  ): Promise<{ tabId: string; url: string; created: boolean }> {
    const { conn, task } = await this.findTask(taskId, profileName);

    // If we have a current tab, navigate in it (reuse)
    const currentShortId = task.currentTabId;
    if (currentShortId && task.tabs[currentShortId]) {
      const cdpTargetId = task.tabs[currentShortId];
      const sessionId = await this.getSessionId(conn, cdpTargetId);
      await conn.cdp.send('Page.navigate', { url }, sessionId);
      await this.saveTaskState(task.profile, conn.tasks);
      return { tabId: currentShortId, url, created: false };
    }

    // No current tab - create one
    if (conn.electron) {
      const cdpTargetId = task.windowTargetId;
      if (!cdpTargetId) {
        throw new Error('No existing tab to navigate in Electron app');
      }
      const shortId = generateShortId();
      const sessionId = await this.getSessionId(conn, cdpTargetId);
      await conn.cdp.send('Page.navigate', { url }, sessionId);
      task.tabs[shortId] = cdpTargetId;
      task.currentTabId = shortId;
      await this.saveTaskState(task.profile, conn.tasks);
      return { tabId: shortId, url, created: true };
    }

    // Chrome: create new tab
    const result = (await conn.cdp.send('Target.createTarget', {
      url,
    })) as { targetId: string };

    const shortId = generateShortId();
    task.tabs[shortId] = result.targetId;
    task.currentTabId = shortId;
    this.invalidateTargetCache(conn);
    await this.saveTaskState(task.profile, conn.tasks);

    return { tabId: shortId, url, created: true };
  }

  async tabAdd(
    taskId: string,
    url: string,
    profileName?: string
  ): Promise<{ tabId: string; url: string }> {
    const { conn, task } = await this.findTask(taskId, profileName);

    if (conn.electron) {
      throw new Error('Electron apps do not support opening additional tabs');
    }

    const result = (await conn.cdp.send('Target.createTarget', {
      url,
    })) as { targetId: string };

    const shortId = generateShortId();
    task.tabs[shortId] = result.targetId;
    task.currentTabId = shortId; // new tab becomes current
    this.invalidateTargetCache(conn);
    await this.saveTaskState(task.profile, conn.tasks);

    return { tabId: shortId, url };
  }

  async tabFocus(taskId: string, tabHint: string): Promise<{ tabId: string }> {
    const { conn, task } = await this.findTask(taskId);
    const resolvedTabId = await this.resolveTabHint(conn, task, tabHint);
    task.currentTabId = resolvedTabId;
    await this.saveTaskState(task.profile, conn.tasks);
    return { tabId: resolvedTabId };
  }

  async tabList(taskId: string): Promise<Array<{ id: string; url: string; title: string; current: boolean }>> {
    const { conn, task } = await this.findTask(taskId);
    const targets = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; url: string; title: string }>;
    };

    const tabs: Array<{ id: string; url: string; title: string; current: boolean }> = [];
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      const target = targets.targetInfos.find((t) => t.targetId === cdpId);
      if (target) {
        tabs.push({
          id: shortId,
          url: target.url,
          title: target.title,
          current: shortId === task.currentTabId,
        });
      }
    }
    return tabs;
  }

  private async resolveTabHint(conn: ProfileConnection, task: Task, hint: string): Promise<string> {
    // Exact match
    if (task.tabs[hint]) return hint;

    // Prefix match
    const byPrefix = Object.keys(task.tabs).filter((id) => id.startsWith(hint));
    if (byPrefix.length === 1) return byPrefix[0];
    if (byPrefix.length > 1) {
      throw new Error(`Ambiguous tab hint "${hint}" — matches ${byPrefix.length} tabs`);
    }

    // URL substring match
    const targets = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; url: string }>;
    };
    const matches: string[] = [];
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      const target = targets.targetInfos.find((t) => t.targetId === cdpId);
      if (target && target.url.includes(hint)) {
        matches.push(shortId);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Ambiguous tab hint "${hint}" — matches ${matches.length} tabs by URL`);
    }

    throw new Error(`Tab "${hint}" not found`);
  }

  private resolveCurrentTab(task: Task): string {
    const tabIds = Object.keys(task.tabs);
    const id = task.currentTabId ?? tabIds[tabIds.length - 1];
    if (!id) throw new Error('No tabs open for this task');
    return id;
  }

  private getCdpTargetId(task: Task, shortId: string): string {
    const cdpId = task.tabs[shortId];
    if (!cdpId) throw new Error(`Tab ${shortId} not found`);
    return cdpId;
  }

  async tabs(taskId?: string, profileName?: string): Promise<TabInfo[]> {
    if (taskId) {
      const { conn, task } = await this.findTask(taskId, profileName);
      return this.getTabsForTask(conn.cdp, task);
    }

    const allTabs: TabInfo[] = [];
    for (const [, conn] of this.connections) {
      for (const [, task] of conn.tasks) {
        const tabs = await this.getTabsForTask(conn.cdp, task);
        allTabs.push(...tabs);
      }
    }
    return allTabs;
  }

  async tabClose(taskId: string, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);

    if (tabHint !== undefined) {
      const shortId = await this.resolveTabHint(conn, task, tabHint);
      const cdpId = task.tabs[shortId];
      if (cdpId) {
        await conn.cdp.send('Target.closeTarget', { targetId: cdpId });
        conn.sessionCache.delete(cdpId);
        delete task.tabs[shortId];
        // Update currentTabId if we closed the current tab
        if (task.currentTabId === shortId) {
          const remaining = Object.keys(task.tabs);
          task.currentTabId = remaining.length > 0 ? remaining[remaining.length - 1] : undefined;
        }
      }
    } else {
      // Close all tabs
      await Promise.all(
        Object.values(task.tabs).map((cdpId) =>
          conn.cdp.send('Target.closeTarget', { targetId: cdpId }).catch(() => {})
        )
      );
      for (const cdpId of Object.values(task.tabs)) {
        conn.sessionCache.delete(cdpId);
      }
      task.tabs = {};
      task.currentTabId = undefined;
    }

    this.invalidateTargetCache(conn);
    await this.saveTaskState(task.profile, conn.tasks);
  }

  async evaluate(
    taskId: string,
    tabHint: string | undefined,
    expression: string
  ): Promise<unknown> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);

    if (!target) {
      throw new Error(`Tab ${shortId} not found`);
    }

    const sessionId = await this.getSessionId(conn, target.targetId);

    const result = (await conn.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      sessionId
    )) as { result: { value: unknown } };

    return result.result.value;
  }

  async screenshot(
    taskId: string,
    tabHint?: string,
    outputPath?: string
  ): Promise<string> {
    const { conn, task } = await this.findTask(taskId);

    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);

    const target = await this.getTarget(conn, cdpTargetId);

    if (!target) {
      throw new Error(`Tab ${shortId} not found`);
    }

    const sessionId = await this.getSessionId(conn, target.targetId);

    const { data } = (await conn.cdp.send(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 70 },
      sessionId
    )) as { data: string };

    let buffer = Buffer.from(data, 'base64');

    const MAX_SIZE = 100 * 1024;
    if (buffer.length > MAX_SIZE) {
      let quality = 50;
      while (buffer.length > MAX_SIZE && quality > 10) {
        const { data: resized } = (await conn.cdp.send(
          'Page.captureScreenshot',
          { format: 'jpeg', quality },
          sessionId
        )) as { data: string };
        buffer = Buffer.from(resized, 'base64');
        quality -= 10;
      }
    }

    const sessionsDir = path.join(getBrowserRuntimeDir(), 'sessions', task.name);
    const finalPath = outputPath || path.join(sessionsDir, `${Date.now()}.jpg`);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(finalPath, buffer);

    return finalPath;
  }

  private refsCache = new Map<string, { refs: string; nodeMap: Map<number, RefNode>; ts: number }>();

  async refs(
    taskId: string,
    tabHint?: string,
    opts: RefOpts = {}
  ): Promise<{ refs: string; nodeMap: Map<number, RefNode> }> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);

    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    return getRefs(conn.cdp, sessionId, opts);
  }

  async click(taskId: string, ref: number, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const { nodeMap } = await getRefs(conn.cdp, sessionId, { interactive: false, limit: 1000 });
    const { x, y } = await resolveRefToCoords(conn.cdp, sessionId, nodeMap, ref);
    await clickAtCoords(conn.cdp, sessionId, x, y);
  }

  async type(taskId: string, ref: number, text: string, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const { nodeMap } = await getRefs(conn.cdp, sessionId, { interactive: false, limit: 1000 });
    const node = nodeMap.get(ref);
    if (!node) throw new Error(`Ref ${ref} not found`);
    if (node.backendNodeId) {
      await focusNode(conn.cdp, sessionId, node.backendNodeId);
    }
    await typeText(conn.cdp, sessionId, text);
  }

  async press(taskId: string, key: string, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await pressKey(conn.cdp, sessionId, key);
  }

  async hover(taskId: string, ref: number, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const { nodeMap } = await getRefs(conn.cdp, sessionId, { interactive: false, limit: 1000 });
    const { x, y } = await resolveRefToCoords(conn.cdp, sessionId, nodeMap, ref);
    await hoverAtCoords(conn.cdp, sessionId, x, y);
  }

  async status(profileName?: string): Promise<ProfileStatus[]> {
    const seen = new Set<string>();
    const statuses: ProfileStatus[] = [];

    const candidates = profileName ? [profileName] : Array.from(this.connections.keys());
    for (const name of candidates) {
      const status = await this.getProfileStatus(name);
      if (status) {
        statuses.push(status);
        seen.add(name);
      }
    }

    if (!profileName) {
      const profiles = await listProfiles();
      for (const profile of profiles) {
        if (seen.has(profile.name)) continue;
        const reconciled = await this.reconcileFromDisk(profile.name);
        if (reconciled) statuses.push(reconciled);
      }
    } else if (!seen.has(profileName)) {
      const reconciled = await this.reconcileFromDisk(profileName);
      if (reconciled) statuses.push(reconciled);
    }

    return statuses;
  }

  private async reconcileFromDisk(profileName: string): Promise<ProfileStatus | null> {
    const info = getRunningChromeInfo(profileName);
    if (!info) return null;

    const profile = await getProfile(profileName);
    const tasks = this.loadTaskState(profileName);
    const taskStatuses: TaskStatus[] = [];
    for (const [, task] of tasks) {
      taskStatuses.push({
        id: task.id,
        name: task.name,
        tabCount: Object.keys(task.tabs).length,
        currentTabId: task.currentTabId,
        createdAt: task.createdAt,
      });
    }

    const configuredPort = profile ? extractConfiguredPort(profile) : undefined;

    return {
      name: profileName,
      running: true,
      port: info.port,
      pid: info.pid,
      configuredPort: configuredPort !== info.port ? configuredPort : undefined,
      tasks: taskStatuses,
    };
  }

  async shutdown(): Promise<void> {
    for (const [, conn] of this.connections) {
      conn.cdp.close();
    }
    this.connections.clear();
  }

  private findAvailableFork(
    profileName: string
  ): { name: string; conn: ProfileConnection } | null {
    for (const [name, conn] of this.connections) {
      if (conn.forkedFrom === profileName && conn.tasks.size === 0) {
        return { name, conn };
      }
    }
    return null;
  }

  private async forkElectronProfile(
    profile: BrowserProfile
  ): Promise<{ forkName: string; connection: ProfileConnection }> {
    let forkNum = 2;
    while (this.connections.has(`${profile.name}.${forkNum}`)) {
      forkNum++;
    }
    const forkName = `${profile.name}.${forkNum}`;

    const port = allocatePort();
    const { pid, wsUrl } = await launchBrowser(
      forkName,
      profile.browser,
      port,
      profile.chrome,
      profile.secrets,
      profile.binary
    );

    const cdp = new CDPClient();
    await cdp.connect(wsUrl);
    await this.enableDomains(cdp);

    const connection: ProfileConnection = {
      cdp,
      port,
      pid,
      electron: true,
      forkedFrom: profile.name,
      tasks: new Map(),
      sessionCache: new Map(),
    };
    this.connections.set(forkName, connection);

    return { forkName, connection };
  }

  private async connectProfile(profile: BrowserProfile): Promise<ProfileConnection> {
    const existingInfo = getRunningChromeInfo(profile.name);

    if (existingInfo) {
      const { wsUrl, browser } = await discoverBrowserWsUrl(existingInfo.port);
      verifyBrowserIdentity(browser, profile.browser, existingInfo.port);
      const cdp = new CDPClient();
      await cdp.connect(wsUrl);
      await this.enableDomains(cdp);

      const tasks = this.loadTaskState(profile.name);

      return {
        cdp,
        port: existingInfo.port,
        pid: existingInfo.pid,
        electron: profile.electron,
        tasks,
        sessionCache: new Map(),
      };
    }

    for (const endpoint of profile.endpoints) {
      try {
        const conn = await this.connectEndpoint(profile, endpoint);
        if (conn) return conn;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Browser identity mismatch')) {
          throw err;
        }
        // Try next endpoint
      }
    }

    throw new Error(`Could not connect to any endpoint for profile "${profile.name}"`);
  }

  private async connectEndpoint(
    profile: BrowserProfile,
    endpoint: string
  ): Promise<ProfileConnection | null> {
    const url = new URL(endpoint);

    if (url.protocol === 'cdp:') {
      const conn = await connectLocal(endpoint, profile);
      await this.enableDomains(conn.cdp);
      return {
        cdp: conn.cdp,
        port: conn.port,
        pid: conn.pid,
        electron: profile.electron,
        tasks: conn.pid === 0 ? this.loadTaskState(profile.name) : new Map(),
        sessionCache: new Map(),
      };
    }

    if (url.protocol === 'ssh:') {
      const conn = await connectSSH(endpoint, profile);
      await this.enableDomains(conn.cdp);
      return {
        cdp: conn.cdp,
        port: conn.port,
        pid: conn.pid,
        electron: profile.electron,
        tasks: new Map(),
        sessionCache: new Map(),
      };
    }

    if (url.protocol === 'wss:' || url.protocol === 'ws:') {
      const cdp = new CDPClient();
      await cdp.connect(endpoint);
      await this.enableDomains(cdp);
      return {
        cdp,
        port: 0,
        pid: 0,
        electron: profile.electron,
        tasks: this.loadTaskState(profile.name),
        sessionCache: new Map(),
      };
    }

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const port = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10);
      const { wsUrl, browser } = await discoverBrowserWsUrl(port, url.hostname);
      verifyBrowserIdentity(browser, profile.browser, port, url.hostname);
      const cdp = new CDPClient();
      await cdp.connect(wsUrl);
      await this.enableDomains(cdp);
      return {
        cdp,
        port,
        pid: 0,
        electron: profile.electron,
        tasks: this.loadTaskState(profile.name),
        sessionCache: new Map(),
      };
    }

    return null;
  }

  private async enableDomains(cdp: CDPClient): Promise<void> {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
  }

  private async createTaskWindow(
    conn: ProfileConnection,
    _taskId: string
  ): Promise<{ windowTargetId?: string }> {
    if (conn.electron) {
      const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; type: string; url: string }>;
      };
      const pageTarget = targetInfos.find((t) => t.type === 'page');
      if (pageTarget) {
        return { windowTargetId: pageTarget.targetId };
      }
      // No existing page - try to create one (works on some Electron apps)
      try {
        const result = (await conn.cdp.send('Target.createTarget', {
          url: 'about:blank',
          newWindow: true,
        })) as { targetId: string };
        return { windowTargetId: result.targetId };
      } catch {
        throw new Error('No page targets found and unable to create new window');
      }
    }

    const result = (await conn.cdp.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
    })) as { targetId: string };

    return { windowTargetId: result.targetId };
  }

  private async findTask(
    taskId: string,
    profileName?: string
  ): Promise<{ conn: ProfileConnection; task: Task }> {
    if (profileName) {
      const conn = this.connections.get(profileName);
      if (!conn) {
        throw new Error(`Profile "${profileName}" not connected`);
      }
      const task = conn.tasks.get(taskId);
      if (!task) {
        throw new Error(`Task "${taskId}" not found on profile "${profileName}"`);
      }
      return { conn, task };
    }

    for (const [, conn] of this.connections) {
      const task = conn.tasks.get(taskId);
      if (task) {
        return { conn, task };
      }
    }

    throw new Error(`Task "${taskId}" not found`);
  }

  private async getTabsForTask(cdp: CDPClient, task: Task): Promise<TabInfo[]> {
    const targets = (await cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; url: string; title: string }>;
    };

    const tabs: TabInfo[] = [];
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      const target = targets.targetInfos.find((t) => t.targetId === cdpId);
      if (target) {
        tabs.push({
          id: shortId,
          url: target.url,
          title: target.title,
          task: task.name,
        });
      }
    }
    return tabs;
  }

  private async getProfileStatus(profileName: string): Promise<ProfileStatus | null> {
    const conn = this.connections.get(profileName);
    if (!conn) return null;

    const tasks: TaskStatus[] = [];
    for (const [, task] of conn.tasks) {
      tasks.push({
        id: task.id,
        name: task.name,
        tabCount: Object.keys(task.tabs).length,
        currentTabId: task.currentTabId,
        createdAt: task.createdAt,
      });
    }

    const profile = await getProfile(profileName);
    const configuredPort = profile ? extractConfiguredPort(profile) : undefined;

    return {
      name: profileName,
      running: true,
      port: conn.port,
      pid: conn.pid,
      configuredPort: configuredPort !== conn.port ? configuredPort : undefined,
      tasks,
    };
  }

  private async getTarget(
    conn: ProfileConnection,
    tabId: string
  ): Promise<TargetInfo | undefined> {
    const now = Date.now();
    if (!conn.targetCache || now - conn.targetCache.ts > 1000) {
      const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: TargetInfo[];
      };
      conn.targetCache = { targets: targetInfos, ts: now };
    }

    return conn.targetCache.targets.find((target) => target.targetId === tabId);
  }

  private async getSessionId(conn: ProfileConnection, tabId: string): Promise<string> {
    const cachedSessionId = conn.sessionCache.get(tabId);
    if (cachedSessionId) {
      return cachedSessionId;
    }

    const { sessionId } = (await conn.cdp.send('Target.attachToTarget', {
      targetId: tabId,
      flatten: true,
    })) as { sessionId: string };
    conn.sessionCache.set(tabId, sessionId);
    return sessionId;
  }

  private invalidateTargetCache(conn: ProfileConnection): void {
    conn.targetCache = undefined;
  }

  private async saveTaskState(profileName: string, tasks: Map<string, Task>): Promise<void> {
    const runtimeDir = getProfileRuntimeDir(profileName);
    await fs.promises.mkdir(runtimeDir, { recursive: true });

    const state = Object.fromEntries(tasks);
    await fs.promises.writeFile(
      path.join(runtimeDir, 'tasks.json'),
      JSON.stringify(state, null, 2)
    );
  }

  private loadTaskState(profileName: string): Map<string, Task> {
    const runtimeDir = getProfileRuntimeDir(profileName);
    const tasksFile = path.join(runtimeDir, 'tasks.json');

    if (!fs.existsSync(tasksFile)) {
      return new Map();
    }

    const state = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    const tasks = new Map<string, Task>();
    let needsMigration = false;

    for (const [key, raw] of Object.entries(state)) {
      const task = raw as Record<string, unknown>;
      // Migrate old format (tabIds array) to new format (tabs object)
      if (Array.isArray(task.tabIds) && !task.tabs) {
        needsMigration = true;
        const tabs: Record<string, string> = {};
        for (const cdpId of task.tabIds as string[]) {
          const shortId = generateShortId();
          tabs[shortId] = cdpId;
        }
        const tabIds = Object.keys(tabs);
        tasks.set(key, {
          id: task.id as string,
          name: task.name as string || key,
          profile: task.profile as string,
          windowTargetId: task.windowTargetId as string | undefined,
          tabs,
          currentTabId: tabIds.length > 0 ? tabIds[tabIds.length - 1] : undefined,
          createdAt: task.createdAt as number,
          pid: task.pid as number,
        });
      } else {
        tasks.set(key, task as unknown as Task);
      }
    }

    // Save migrated data back to disk
    if (needsMigration) {
      const migratedState = Object.fromEntries(tasks);
      fs.writeFileSync(tasksFile, JSON.stringify(migratedState, null, 2));
    }

    return tasks;
  }
}
