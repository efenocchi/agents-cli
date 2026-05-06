import * as fs from 'fs';
import * as path from 'path';
import { CDPClient, discoverBrowserWsUrl } from './cdp.js';
import { getProfile, getProfileRuntimeDir } from './profiles.js';
import {
  launchChrome,
  killChrome,
  getRunningChromeInfo,
  allocatePort,
} from './chrome.js';
import {
  generateTaskId,
  isValidTaskId,
  type Task,
  type TabInfo,
  type ProfileStatus,
  type TaskStatus,
  type BrowserProfile,
} from './types.js';

interface ProfileConnection {
  cdp: CDPClient;
  port: number;
  pid: number;
  tasks: Map<string, Task>;
}

export class BrowserService {
  private connections = new Map<string, ProfileConnection>();

  async start(
    profileName: string,
    taskId?: string
  ): Promise<{ task: string; windowTargetId?: string }> {
    const profile = await getProfile(profileName);
    if (!profile) {
      throw new Error(`Profile "${profileName}" not found`);
    }

    const finalTaskId = taskId || generateTaskId();
    if (!isValidTaskId(finalTaskId)) {
      throw new Error(
        `Invalid task ID "${finalTaskId}". Must be lowercase alphanumeric with hyphens.`
      );
    }

    let conn = this.connections.get(profileName);
    if (!conn) {
      conn = await this.connectProfile(profile);
      this.connections.set(profileName, conn);
    }

    if (conn.tasks.has(finalTaskId)) {
      const task = conn.tasks.get(finalTaskId)!;
      return { task: finalTaskId, windowTargetId: task.windowTargetId };
    }

    const { windowTargetId } = await this.createTaskWindow(conn.cdp, finalTaskId);

    const task: Task = {
      id: finalTaskId,
      profile: profileName,
      windowTargetId,
      tabIds: [],
      createdAt: Date.now(),
      pid: conn.pid,
    };
    conn.tasks.set(finalTaskId, task);

    this.saveTaskState(profileName, conn.tasks);

    return { task: finalTaskId, windowTargetId };
  }

  async stop(taskId: string): Promise<{ ok: boolean; profile?: string }> {
    for (const [profileName, conn] of this.connections) {
      const task = conn.tasks.get(taskId);
      if (task) {
        for (const tabId of task.tabIds) {
          try {
            await conn.cdp.send('Target.closeTarget', { targetId: tabId });
          } catch {
            // Tab already closed
          }
        }

        if (task.windowTargetId) {
          try {
            await conn.cdp.send('Target.closeTarget', { targetId: task.windowTargetId });
          } catch {
            // Window already closed
          }
        }

        conn.tasks.delete(taskId);
        this.saveTaskState(profileName, conn.tasks);

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
  ): Promise<{ tabId: string; url: string }> {
    const { conn, task } = await this.findTask(taskId, profileName);

    const result = (await conn.cdp.send('Target.createTarget', {
      url,
    })) as { targetId: string };

    const tabId = result.targetId;
    task.tabIds.push(tabId);
    this.saveTaskState(task.profile, conn.tasks);

    return { tabId, url };
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

  async close(taskId: string, tabId?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);

    if (tabId !== undefined) {
      await conn.cdp.send('Target.closeTarget', { targetId: tabId });
      task.tabIds = task.tabIds.filter((id) => id !== tabId);
    } else {
      for (const id of task.tabIds) {
        await conn.cdp.send('Target.closeTarget', { targetId: id });
      }
      task.tabIds = [];
    }

    this.saveTaskState(task.profile, conn.tasks);
  }

  async evaluate(
    taskId: string,
    tabId: string,
    expression: string
  ): Promise<unknown> {
    const { conn } = await this.findTask(taskId);

    const targets = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string }>;
    };
    const target = targets.targetInfos.find((t) => t.targetId === tabId);

    if (!target) {
      throw new Error(`Tab ${tabId} not found`);
    }

    const { sessionId } = (await conn.cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };

    const result = (await conn.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      sessionId
    )) as { result: { value: unknown } };

    return result.result.value;
  }

  async screenshot(
    taskId: string,
    tabId?: string,
    outputPath?: string
  ): Promise<string> {
    const { conn, task } = await this.findTask(taskId);

    const targetTabId = tabId ?? task.tabIds[task.tabIds.length - 1];
    if (targetTabId === undefined) {
      throw new Error('No tabs open for this task');
    }

    const targets = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string }>;
    };
    const target = targets.targetInfos.find((t) => t.targetId === targetTabId);

    if (!target) {
      throw new Error(`Tab ${targetTabId} not found`);
    }

    const { sessionId } = (await conn.cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };

    const { data } = (await conn.cdp.send(
      'Page.captureScreenshot',
      { format: 'png' },
      sessionId
    )) as { data: string };

    const finalPath =
      outputPath ||
      path.join(getProfileRuntimeDir(task.profile), `screenshot-${Date.now()}.png`);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, Buffer.from(data, 'base64'));

    return finalPath;
  }

  async status(profileName?: string): Promise<ProfileStatus[]> {
    const statuses: ProfileStatus[] = [];

    if (profileName) {
      const status = await this.getProfileStatus(profileName);
      if (status) statuses.push(status);
    } else {
      for (const name of this.connections.keys()) {
        const status = await this.getProfileStatus(name);
        if (status) statuses.push(status);
      }
    }

    return statuses;
  }

  async shutdown(): Promise<void> {
    for (const [, conn] of this.connections) {
      conn.cdp.close();
    }
    this.connections.clear();
  }

  private async connectProfile(profile: BrowserProfile): Promise<ProfileConnection> {
    const existingInfo = getRunningChromeInfo(profile.name);

    if (existingInfo) {
      const wsUrl = await discoverBrowserWsUrl(existingInfo.port);
      const cdp = new CDPClient();
      await cdp.connect(wsUrl);
      await this.enableDomains(cdp);

      const tasks = this.loadTaskState(profile.name);

      return {
        cdp,
        port: existingInfo.port,
        pid: existingInfo.pid,
        tasks,
      };
    }

    for (const endpoint of profile.endpoints) {
      try {
        const conn = await this.connectEndpoint(profile, endpoint);
        if (conn) return conn;
      } catch {
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
      const port = parseInt(url.port, 10) || 9222;

      try {
        const wsUrl = await discoverBrowserWsUrl(port);
        const cdp = new CDPClient();
        await cdp.connect(wsUrl);
        await this.enableDomains(cdp);

        return {
          cdp,
          port,
          pid: 0,
          tasks: this.loadTaskState(profile.name),
        };
      } catch {
        const newPort = allocatePort();
        const { pid, wsUrl } = await launchChrome(profile.name, newPort, profile.chrome);
        const cdp = new CDPClient();
        await cdp.connect(wsUrl);
        await this.enableDomains(cdp);

        return {
          cdp,
          port: newPort,
          pid,
          tasks: new Map(),
        };
      }
    }

    return null;
  }

  private async enableDomains(cdp: CDPClient): Promise<void> {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
  }

  private async createTaskWindow(
    cdp: CDPClient,
    _taskId: string
  ): Promise<{ windowTargetId: string }> {
    const result = (await cdp.send('Target.createTarget', {
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

    return task.tabIds
      .map((id) => {
        const target = targets.targetInfos.find((t) => t.targetId === id);
        if (!target) return null;
        return {
          id,
          url: target.url,
          title: target.title,
          task: task.id,
        };
      })
      .filter((t): t is TabInfo => t !== null);
  }

  private async getProfileStatus(profileName: string): Promise<ProfileStatus | null> {
    const conn = this.connections.get(profileName);
    if (!conn) return null;

    const tasks: TaskStatus[] = [];
    for (const [, task] of conn.tasks) {
      tasks.push({
        id: task.id,
        tabCount: task.tabIds.length,
        createdAt: task.createdAt,
      });
    }

    return {
      name: profileName,
      running: true,
      port: conn.port,
      pid: conn.pid,
      tasks,
    };
  }

  private saveTaskState(profileName: string, tasks: Map<string, Task>): void {
    const runtimeDir = getProfileRuntimeDir(profileName);
    fs.mkdirSync(runtimeDir, { recursive: true });

    const state = Object.fromEntries(tasks);
    fs.writeFileSync(
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
    return new Map(Object.entries(state));
  }
}
