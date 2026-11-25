import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import http from 'node:http';
import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The end-to-end proof for issue #25, and the ONLY automated test that crosses
// the whole chain the issue is about:
//
//   `open <url>`  →  bin/open  →  bin/omniterm-browser.js  →  Chrome (CDP)
//                 →  POST /browsers on the tab's registry
//
// Everything else stops at a stand-in: browserShims.test.ts proves the shim
// calls omniterm-browser with the right argument, but a fake records it.
// Nothing proved that a real launch ends up REGISTERED, which is the behavior
// the user sees ("No browsers running for this tab"). Spec 001 User Story 2
// (Priority: P2) is exactly this: a child process registers a browser to the
// tab's registry URL and the panel shows it.
//
// Real Chrome, headless, against a DEDICATED temp user-data-dir — never the
// user's profile and never the shared ~/.omniterm/browser-profile, so running
// this suite cannot disturb a browser the developer has open. Self-skips when
// no Chrome/Chromium is installed; a skip is reported as a skip, never a pass.

// Chrome launches get the developer's REAL home directory, not the temp dir.
// On macOS, Chrome keeps its cookie key ("Chrome Safe Storage") in the default
// keychain, which macOS finds under $HOME/Library/Keychains. A temp HOME has no
// keychain, so every launch raised a system-modal "Keychain Not Found" dialog
// that blocked the desktop. Isolation comes from OMNITERM_BROWSER_UDD, which
// every launch below sets to a temp dir; HOME added none.
const REAL_HOME = homedir();

const BIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bin');

/** Mirrors findChromeBinary in bin/omniterm-browser.js. */
function resolveChrome(): string | null {
  if (process.env.OMNITERM_CHROME_PATH) return process.env.OMNITERM_CHROME_PATH;
  const candidates =
    platform() === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/snap/bin/chromium',
        ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const CHROME = resolveChrome();
const skip = CHROME ? false : 'no Chrome/Chromium installed';

interface Registration {
  cdpUrl: string;
  label: string;
  pid: number;
}

/** A stand-in for the tab registry that resolves once a browser registers. */
function startRegistry(): Promise<{
  url: string;
  pageUrl: string;
  received: Promise<Registration>;
  deleted: string[];
  close: () => void;
}> {
  return new Promise((resolveServer) => {
    let resolveHit: (r: Registration) => void;
    const received = new Promise<Registration>((r) => (resolveHit = r));
    const listed: { id: string; browserCdpUrl: string }[] = [];
    const deleted: string[] = [];
    const server = http.createServer((req, res) => {
      // GET /browsers + DELETE /browsers/:id exist so the --close path's
      // deregistration is exercised rather than silently skipped.
      if (req.method === 'GET' && req.url?.endsWith('/browsers')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ browsers: listed }));
        return;
      }
      if (req.method === 'DELETE') {
        deleted.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      // A local page for tests that need the launched browser to load
      // something real without touching the network.
      if (req.method === 'GET' && req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<title>omniterm-test</title>');
        return;
      }
      if (req.method !== 'POST' || !req.url?.endsWith('/browsers')) {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: '1', deduped: false }));
        try {
          const reg = JSON.parse(body) as Registration;
          listed.push({ id: String(listed.length + 1), browserCdpUrl: reg.cdpUrl });
          resolveHit(reg);
        } catch {
          /* assertion below reports the malformed body */
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolveServer({
        url: `http://127.0.0.1:${port}/t/test/registry`,
        pageUrl: `http://127.0.0.1:${port}/page`,
        received,
        deleted,
        close: () => server.close(),
      });
    });
  });
}

const udds: string[] = [];
const spawnedPids: number[] = [];

/**
 * The pid that actually OWNS a user-data-dir, read from Chrome's SingletonLock
 * (a symlink whose target is the marker `<hostname>-<pid>`).
 *
 * Needed because the pid the registry receives is the one we spawned, and on
 * macOS Chrome re-execs itself: that process exits, the real browser is
 * reparented to init, and killing the registered pid leaves a headless Chrome
 * running for the life of the machine. One leaked browser per test run.
 */
function owningPid(udd: string): number | null {
  const lock = path.join(udd, 'SingletonLock');
  try {
    if (!lstatSync(lock).isSymbolicLink()) return null;
    const m = readlinkSync(lock).match(/-(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

after(async () => {
  // Kill only the exact pids tied to THIS suite's dedicated user-data-dirs —
  // never a pattern sweep, which would reach a developer's own Chrome.
  for (const dir of udds) {
    const owner = owningPid(path.join(dir, 'profile'));
    if (owner !== null) spawnedPids.push(owner);
  }
  for (const pid of spawnedPids) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
  // Then WAIT for them: Chrome keeps writing to its user-data-dir while it
  // shuts down, and removing the tree underneath it fails with ENOTEMPTY.
  const deadline = Date.now() + 10_000;
  while (spawnedPids.some(alive) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const dir of udds) {
    // Retries cover the last few files Chrome flushes as it exits.
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test('open <url> in a tab registers a real browser with the tab registry', { skip }, async () => {
  const registry = await startRegistry();
  const udd = mkdtempSync(path.join(tmpdir(), 'omnitest-udd-'));
  udds.push(udd);

  try {
    // Invoke the shim the way a pane would: found on PATH, by name. The node
    // dir is on PATH because omniterm-browser.js runs via `#!/usr/bin/env node`.
    await new Promise<void>((resolve, reject) => {
      execFile(
        path.join(BIN_DIR, 'open'),
        ['https://example.com'],
        {
          timeout: 60_000,
          env: {
            PATH: [BIN_DIR, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
            HOME: REAL_HOME,
            OMNITERM_BROWSER_REGISTRY_URL: registry.url,
            OMNITERM_BROWSER_UDD: path.join(udd, 'profile'),
            OMNITERM_BROWSER_HEADLESS: '1',
            ...(process.env.OMNITERM_CHROME_PATH
              ? { OMNITERM_CHROME_PATH: process.env.OMNITERM_CHROME_PATH }
              : {}),
          },
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });

    const reg = await registry.received;
    spawnedPids.push(reg.pid);

    // The registry must receive a usable CDP endpoint, not just any POST: an
    // empty or malformed cdpUrl is what leaves the panel showing a browser it
    // then cannot connect to.
    assert.match(
      reg.cdpUrl,
      /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+$/,
      `unusable CDP url: ${reg.cdpUrl}`,
    );
    assert.equal(reg.label, 'omniterm-browser');
    assert.ok(Number.isInteger(reg.pid) && reg.pid > 0, `bad pid: ${reg.pid}`);

    // A well-FORMED url proves nothing on its own — the pre-fix symptom class
    // is a panel that lists a browser and then fails to connect (a stale port,
    // a Chrome that never enabled CDP). Ask the endpoint who it is.
    const port = new URL(reg.cdpUrl.replace('ws://', 'http://')).port;
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    assert.equal(res.status, 200, 'the registered CDP port is not serving');
    const version = (await res.json()) as { webSocketDebuggerUrl?: string };
    assert.equal(
      version.webSocketDebuggerUrl,
      reg.cdpUrl,
      'the registered cdpUrl is not the one this browser is actually listening on',
    );

    // And it must be a browser this suite started, not one already running.
    assert.ok(
      existsSync(path.join(udd, 'profile', 'DevToolsActivePort')),
      'no Chrome was launched against the dedicated user-data-dir',
    );
  } finally {
    registry.close();
  }
});

test('a non-URL `open` argument never launches a browser or registers', { skip }, async () => {
  // The other half of the contract: shadowing `open` is only safe if file and
  // flag invocations stay out of the browser path entirely. Proven here against
  // the REAL omniterm-browser + registry rather than a stand-in, so a future
  // widening of the intercept condition cannot slip past unnoticed.
  const registry = await startRegistry();
  const udd = mkdtempSync(path.join(tmpdir(), 'omnitest-udd-'));
  udds.push(udd);

  try {
    await new Promise<void>((resolve) => {
      execFile(
        path.join(BIN_DIR, 'open'),
        ['/nonexistent-omniterm-test-file'],
        {
          timeout: 30_000,
          env: {
            PATH: [BIN_DIR, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
            HOME: REAL_HOME,
            OMNITERM_BROWSER_REGISTRY_URL: registry.url,
            OMNITERM_BROWSER_UDD: path.join(udd, 'profile'),
            OMNITERM_BROWSER_HEADLESS: '1',
          },
        },
        // The real `open` fails on a missing file; its status is not the point.
        () => resolve(),
      );
    });

    // No DevToolsActivePort means no Chrome was ever started for this UDD.
    assert.ok(
      !existsSync(path.join(udd, 'profile', 'DevToolsActivePort')),
      'a non-URL argument launched a browser',
    );
    const registered = await Promise.race([
      registry.received.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 2000)),
    ]);
    assert.equal(registered, false, 'a non-URL argument registered with the registry');
  } finally {
    registry.close();
  }
});

/** Run the browser shim the way a pane does, against a dedicated user-data-dir. */
function runShim(args: string[], udd: string, registryUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      path.join(BIN_DIR, 'omniterm-browser.js'),
      args,
      {
        timeout: 60_000,
        env: {
          PATH: [BIN_DIR, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
          HOME: REAL_HOME,
          OMNITERM_BROWSER_REGISTRY_URL: registryUrl,
          OMNITERM_BROWSER_UDD: path.join(udd, 'profile'),
          OMNITERM_BROWSER_HEADLESS: '1',
          ...(process.env.OMNITERM_CHROME_PATH
            ? { OMNITERM_CHROME_PATH: process.env.OMNITERM_CHROME_PATH }
            : {}),
        },
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/** The page targets the browser owning `udd` currently has open. */
async function pageUrls(udd: string): Promise<string[]> {
  const portFile = path.join(udd, 'profile', 'DevToolsActivePort');
  if (!existsSync(portFile)) return [];
  const port = parseInt(readFileSync(portFile, 'utf-8').split('\n')[0] ?? '', 10);
  if (!Number.isFinite(port)) return [];
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = (await res.json()) as { type: string; url: string }[];
  return targets.filter((t) => t.type === 'page').map((t) => t.url);
}

// Regression: the warm path used to spawn a second Chrome and rely on Chrome's
// SINGLETON IPC to hand the URL to the running instance. Headless Chrome does
// not service that handoff, so on any display-less machine the second and every
// later call opened nothing while still printing `registered` — $BROWSER worked
// exactly once per Chrome. Asserting page COUNT and CONTENT, because the old
// code reported success either way; only the tab list tells the truth.
test('a second call opens another tab in the running browser', { skip }, async () => {
  const registry = await startRegistry();
  const udd = mkdtempSync(path.join(tmpdir(), 'omnitest-udd-'));
  udds.push(udd);

  try {
    await runShim(['https://example.com/first'], udd, registry.url);
    const owner = owningPid(path.join(udd, 'profile'));
    if (owner !== null) spawnedPids.push(owner);
    assert.deepEqual(await pageUrls(udd), ['https://example.com/first']);

    // The warm path: same user-data-dir, browser already running.
    await runShim(['https://example.com/second'], udd, registry.url);
    const after = await pageUrls(udd);
    assert.equal(after.length, 2, `warm call did not open a tab; pages: ${after.join(', ')}`);
    assert.ok(
      after.includes('https://example.com/second'),
      `the requested URL was never opened; pages: ${after.join(', ')}`,
    );
  } finally {
    registry.close();
  }
});

// Regression: there was no supported way to stop the browser, so a stuck
// instance could only be cleared by hand-killing the pid in SingletonLock.
// --close must actually stop it (not just deregister) and leave no singleton
// markers, or the next call takes the warm path against a dead browser.
test('--close stops the browser and clears its singleton markers', { skip }, async () => {
  const registry = await startRegistry();
  const udd = mkdtempSync(path.join(tmpdir(), 'omnitest-udd-'));
  udds.push(udd);

  try {
    await runShim(['https://example.com'], udd, registry.url);
    const owner = owningPid(path.join(udd, 'profile'));
    assert.ok(owner !== null && alive(owner), 'no browser was started to close');
    spawnedPids.push(owner);

    await runShim(['--close'], udd, registry.url);

    const deadline = Date.now() + 20_000;
    while (alive(owner) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(alive(owner), false, `--close left the browser running (pid ${owner})`);

    for (const marker of ['SingletonLock', 'SingletonCookie', 'DevToolsActivePort']) {
      assert.ok(
        !existsSync(path.join(udd, 'profile', marker)),
        `--close left ${marker} behind, so the next call takes the warm path against a dead browser`,
      );
    }

    // And the tab's panel must stop listing a browser whose CDP is gone.
    assert.ok(
      registry.deleted.length > 0,
      'the dead browser was never deregistered from the tab registry',
    );
  } finally {
    registry.close();
  }
});

/** Evaluate `expression` in a page target over a raw CDP socket. Uses only
 *  Runtime.evaluate, which works without Runtime.enable. Rejects if the socket
 *  errors or closes, or no reply arrives within `timeoutMs`, so a crashed
 *  Chrome fails the test instead of hanging it. */
async function evaluateInPage(
  wsUrl: string,
  expression: string,
  timeoutMs = 10_000,
): Promise<unknown> {
  const ws = new WebSocket(wsUrl);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no CDP reply within ${timeoutMs}ms: ${wsUrl}`)),
        timeoutMs,
      );
      ws.onerror = () => reject(new Error(`CDP socket failed: ${wsUrl}`));
      ws.onclose = () => reject(new Error(`CDP socket closed before replying: ${wsUrl}`));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          result?: { result?: { value?: unknown } };
          error?: { message: string };
        };
        if (msg.id !== 1) return;
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result?.result?.value);
      };
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true },
          }),
        );
    });
  } finally {
    clearTimeout(timer);
    ws.onclose = null;
    ws.close();
  }
}

test('the launched browser does not report itself as automated', { skip }, async () => {
  // Remote debugging turns on Chrome's AutomationControlled feature, which
  // sets navigator.webdriver=true on every page even with no CDP client
  // attached. Google sign-in and Cloudflare challenges read that flag and
  // refuse the browser, so the shim launches Chrome with the feature off.
  //
  // This runs headless to keep windows off developers' screens, and
  // `--headless` turns the feature on too. It still guards the headed case:
  // the flag sits in the base argument list every launch shares, so dropping
  // it fails this test in either mode.
  const registry = await startRegistry();
  const udd = mkdtempSync(path.join(tmpdir(), 'omnitest-udd-'));
  udds.push(udd);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        path.join(BIN_DIR, 'open'),
        [registry.pageUrl],
        {
          timeout: 60_000,
          env: {
            PATH: [BIN_DIR, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
            HOME: REAL_HOME,
            OMNITERM_BROWSER_REGISTRY_URL: registry.url,
            OMNITERM_BROWSER_UDD: path.join(udd, 'profile'),
            OMNITERM_BROWSER_HEADLESS: '1',
            ...(process.env.OMNITERM_CHROME_PATH
              ? { OMNITERM_CHROME_PATH: process.env.OMNITERM_CHROME_PATH }
              : {}),
          },
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });

    const reg = await registry.received;
    spawnedPids.push(reg.pid);
    const port = new URL(reg.cdpUrl.replace('ws://', 'http://')).port;

    // Wait for the tab the shim opened to finish loading our page.
    let pageWs: string | undefined;
    const deadline = Date.now() + 15_000;
    while (!pageWs && Date.now() < deadline) {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        url: string;
        title: string;
        webSocketDebuggerUrl: string;
      }[];
      pageWs = targets.find(
        (t) => t.type === 'page' && t.url === registry.pageUrl && t.title === 'omniterm-test',
      )?.webSocketDebuggerUrl;
      if (!pageWs) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(pageWs, `the shim never loaded ${registry.pageUrl}`);

    assert.equal(
      await evaluateInPage(pageWs, 'navigator.webdriver'),
      false,
      'pages see navigator.webdriver=true, so Google and Cloudflare treat the browser as automated',
    );
  } finally {
    registry.close();
  }
});

// --- Occluded windows -----------------------------------------------------
//
// On macOS (and Windows) Chrome marks a page hidden when its window is fully
// covered by other windows, sitting on another Space, or off screen. The user
// watches OmniTerm's browser through the screencast, not through Chrome's own
// window, so that window is usually covered. A hidden page stops producing
// screencast frames, and DevTools greys the browser view out with "The tab is
// inactive". The shim launches Chrome with --disable-backgrounding-occluded-
// windows so covering the window no longer hides the page. It does not change
// minimized windows or background tabs; the browser view already activates
// the tab it shows.

const OCCLUSION_FLAG = '--disable-backgrounding-occluded-windows';

/** Launch Chrome through the real `open` shim and wait for it to register. */
async function launchThroughOpen(headless: boolean) {
  const registry = await startRegistry();
  const udd = mkdtempSync(path.join(tmpdir(), 'omnitest-udd-'));
  udds.push(udd);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        path.join(BIN_DIR, 'open'),
        [registry.pageUrl],
        {
          timeout: 60_000,
          env: {
            PATH: [BIN_DIR, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
            HOME: REAL_HOME,
            OMNITERM_BROWSER_REGISTRY_URL: registry.url,
            OMNITERM_BROWSER_UDD: path.join(udd, 'profile'),
            OMNITERM_BROWSER_HEADLESS: headless ? '1' : '0',
            ...(process.env.OMNITERM_CHROME_PATH
              ? { OMNITERM_CHROME_PATH: process.env.OMNITERM_CHROME_PATH }
              : {}),
            ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
            ...(process.env.WAYLAND_DISPLAY
              ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY }
              : {}),
          },
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    const reg = await registry.received;
    spawnedPids.push(reg.pid);
    return { registry, udd, reg, port: new URL(reg.cdpUrl.replace('ws://', 'http://')).port };
  } catch (err) {
    registry.close();
    throw err;
  }
}

test('the launched browser keeps pages visible when its window is covered', { skip }, async () => {
  // Runs headless, so there is no window to cover; it checks that the flag
  // reaches the real browser process. The flag sits in the base argument list
  // every launch shares, so dropping it fails this test in either mode. The
  // behaviour itself is the headed test below.
  const { registry, udd } = await launchThroughOpen(true);
  try {
    // The browser that owns the profile, not the pid we spawned: on macOS
    // Chrome re-execs and the spawned process exits.
    const owner = owningPid(path.join(udd, 'profile'));
    assert.ok(owner, 'the launched Chrome never took the profile lock');
    const commandLine = await new Promise<string>((resolve, reject) => {
      execFile('ps', ['-ww', '-o', 'command=', '-p', String(owner)], (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    });
    assert.ok(
      commandLine.split(/\s+/).includes(OCCLUSION_FLAG),
      `Chrome was launched without ${OCCLUSION_FLAG}, so covering its window greys out ` +
        `the browser view with "The tab is inactive". Command line: ${commandLine.trim()}`,
    );
  } finally {
    registry.close();
  }
});

/** A browser-level CDP connection that can address page sessions (flatten mode). */
async function connectBrowserCdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`CDP socket failed: ${wsUrl}`));
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners: Array<(msg: { method: string; params: any; sessionId?: string }) => void> = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id !== undefined) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter?.reject(new Error(`${msg.error.message}`));
      else waiter?.resolve(msg.result);
    } else if (msg.method) {
      for (const listener of listeners) listener(msg);
    }
  };
  return {
    send(method: string, params: object = {}, sessionId?: string): Promise<any> {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => reject(new Error(`no CDP reply to ${method}`)), 10_000);
      });
    },
    on(listener: (msg: { method: string; params: any; sessionId?: string }) => void) {
      listeners.push(listener);
    },
    close: () => ws.close(),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  'headed: covering the browser window does not stop the screencast',
  {
    skip:
      skip ||
      (process.env.OMNITERM_TEST_HEADED === '1'
        ? false
        : 'opens Chrome windows on screen; set OMNITERM_TEST_HEADED=1 to run'),
  },
  async () => {
    const { registry, port } = await launchThroughOpen(false);
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const cdp = await connectBrowserCdp(version.webSocketDebuggerUrl);
    try {
      let pageId: string | undefined;
      const deadline = Date.now() + 15_000;
      while (!pageId && Date.now() < deadline) {
        const { targetInfos } = await cdp.send('Target.getTargets');
        pageId = (targetInfos as { targetId: string; type: string; url: string }[]).find(
          (t) => t.type === 'page' && t.url === registry.pageUrl,
        )?.targetId;
        if (!pageId) await sleep(100);
      }
      assert.ok(pageId, `the shim never loaded ${registry.pageUrl}`);

      const { sessionId } = await cdp.send('Target.attachToTarget', {
        targetId: pageId,
        flatten: true,
      });
      // What DevTools' ScreencastView listens to: `visible: false` here is
      // exactly what raises its "The tab is inactive" glass pane.
      const visibilityEvents: boolean[] = [];
      cdp.on((msg) => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === 'Page.screencastVisibilityChanged') {
          visibilityEvents.push(msg.params.visible);
        } else if (msg.method === 'Page.screencastFrame') {
          void cdp
            .send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }, sessionId)
            .catch(() => {});
        }
      });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Page.startScreencast', { format: 'jpeg', maxWidth: 400, maxHeight: 300 }, sessionId);
      const visibility = async () =>
        (
          await cdp.send(
            'Runtime.evaluate',
            { expression: 'document.visibilityState', returnByValue: true },
            sessionId,
          )
        ).result.value as string;

      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: pageId });
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: 120, top: 120, width: 600, height: 400, windowState: 'normal' },
      });
      await sleep(1_500);
      assert.equal(await visibility(), 'visible', 'the page should start out visible');

      // Cover the page's window completely with a second, larger window.
      const { targetId: cover } = await cdp.send('Target.createTarget', {
        url: 'about:blank',
        newWindow: true,
      });
      const { windowId: coverWindow } = await cdp.send('Browser.getWindowForTarget', {
        targetId: cover,
      });
      assert.notEqual(coverWindow, windowId, 'the cover must be its own window');
      await cdp.send('Browser.setWindowBounds', {
        windowId: coverWindow,
        bounds: { left: 60, top: 60, width: 900, height: 650 },
      });
      await cdp.send('Target.activateTarget', { targetId: cover });
      // macOS reports occlusion asynchronously, after the window server
      // settles.
      await sleep(3_500);
      const whileCovered = await visibility();
      const eventsWhileCovered = [...visibilityEvents];
      await cdp.send('Target.closeTarget', { targetId: cover });

      // Control: a minimized window is hidden with or without the flag. If
      // this stays visible, the measurement above proves nothing.
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await sleep(2_500);
      const whileMinimized = await visibility();
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });

      assert.equal(whileMinimized, 'hidden', 'control failed: this harness cannot observe hiding');
      assert.equal(
        whileCovered,
        'visible',
        'covering the window hid the page, which greys the browser view out with "The tab is inactive"',
      );
      assert.ok(
        !eventsWhileCovered.includes(false),
        `the screencast reported the page invisible while covered: ${JSON.stringify(eventsWhileCovered)}`,
      );
    } finally {
      cdp.close();
      registry.close();
    }
  },
);
