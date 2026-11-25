// End-to-end check of the DevTools screencast shim against a REAL Chrome
// DevTools frontend, the only test that would notice Chrome reshaping the
// private frontend internals the shim drives.
//
// devtoolsScreencastShim.test.ts runs the shim against fakes, so it keeps
// passing however Chrome changes. That is how Chrome 158 broke the browser view
// unnoticed: it rewrote ScreencastApp onto a lit-rendered <devtools-split-view>
// with private fields, dropping the `rootSplitWidget` and `screencastView`
// properties the shim polled for. The shim waited out its timeout, reported
// `unsupported`, and left stock DevTools in place — inspector docked on the
// right, grey frame around a shrunken page.
//
// Mirrors production: a target Chrome serves its own frontend at /devtools/,
// a second (viewer) browser loads inspector.html?ws=... from that origin, and
// the shim is injected on load exactly as installDevToolsScreencastShim in
// TabBrowserView.tsx does. Both browsers are Playwright-owned, each on a fresh
// temporary profile. Self-skips when no Chrome is installed.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const executablePath = process.env.OMNITERM_CHROME_PATH ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);
const skip = executablePath ? false : 'no Chrome/Chromium installed';

const shimSource = readFileSync(
  new URL('../public/devtools-screencast-shim.js', import.meta.url),
  'utf8',
);

const VIEWER = { width: 1200, height: 800 };
const TARGET = { width: 1000, height: 700 };
/** InspectorView's initial sidebar size: `sidebar-initial-size` in ScreencastApp. */
const STOCK_SIDEBAR_SIZE = 300;
/** Target page background, so the screencast canvas can be checked for the page. */
const TARGET_RGB = [34, 170, 102];

let site: http.Server;
let siteUrl = '';
let userDataDir = '';
let target: BrowserContext;
let cdpPort = 0;
let viewer: Browser;

before(async () => {
  if (skip) return;
  site = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<!doctype html><title>shim target</title>' +
        `<body style="margin:0;background:rgb(${TARGET_RGB.join(',')})"><h1>target</h1></body>`,
    );
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;

  // Port 0 lets Chrome pick a free port and record it in DevToolsActivePort,
  // which needs a profile dir this test owns.
  userDataDir = mkdtempSync(path.join(tmpdir(), 'omniterm-shim-target-'));
  target = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    viewport: TARGET,
    args: ['--remote-debugging-port=0'],
  });
  cdpPort = await readDevToolsActivePort(userDataDir);
  viewer = await chromium.launch({ executablePath });
});

after(async () => {
  await viewer?.close();
  await target?.close();
  site?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

/**
 * Playwright drives Chrome over a pipe and does not wait for the HTTP debug
 * server, which is what writes DevToolsActivePort, so the file may lag launch.
 */
async function readDevToolsActivePort(dir: string): Promise<number> {
  const file = path.join(dir, 'DevToolsActivePort');
  const deadline = Date.now() + 10_000;
  for (;;) {
    const port = existsSync(file) ? Number(readFileSync(file, 'utf8').split('\n')[0]) : 0;
    if (port > 0) return port;
    if (Date.now() > deadline) throw new Error(`Chrome never wrote a port to ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface ShimResult {
  state: string | null;
  detail: string | null;
}

/** Open a target page and the viewer's DevTools frontend on it, with the shim injected. */
async function openShimmedFrontend(
  position: string,
): Promise<{ page: Page; targetPage: Page; result: ShimResult }> {
  const targetPage = await target.newPage();
  await targetPage.goto(siteUrl);
  const targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as Array<{
    id: string;
    type: string;
    url: string;
  }>;
  const pageTarget = targets.find((t) => t.type === 'page' && t.url === siteUrl);
  assert.ok(pageTarget, 'target page is listed over CDP');

  const page = await viewer.newPage({ viewport: VIEWER, deviceScaleFactor: 1 });
  // tsx wraps named functions inside serialized callbacks in __name().
  await page.addInitScript('globalThis.__name = (value) => value;');
  const origin = `http://127.0.0.1:${cdpPort}`;
  // Production serves the shim from OmniTerm's origin, which is also the
  // proxied frontend's origin. Here the frontend's origin is Chrome's.
  await page.route(`${origin}/devtools-screencast-shim.js`, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: shimSource }),
  );
  await page.goto(
    `${origin}/devtools/inspector.html?ws=127.0.0.1:${cdpPort}/devtools/page/${pageTarget.id}`,
    { waitUntil: 'load' },
  );
  await page.evaluate((inspectorPosition) => {
    const script = document.createElement('script');
    script.id = 'omniterm-devtools-screencast-shim';
    script.type = 'module';
    script.src = '/devtools-screencast-shim.js';
    script.dataset.inspectorPosition = inspectorPosition;
    document.head.appendChild(script);
  }, position);
  // Longer than the shim's own 10s wait, so a shim that gives up reports
  // `unsupported` here instead of timing the test out.
  await page.waitForFunction(
    () => document.documentElement.hasAttribute('data-omniterm-screencast-shim'),
    null,
    { timeout: 20_000 },
  );
  const result = await page.evaluate(() => ({
    state: document.documentElement.getAttribute('data-omniterm-screencast-shim'),
    detail: document.documentElement.getAttribute('data-omniterm-screencast-shim-detail'),
  }));
  return { page, targetPage, result };
}

interface CanvasProbe {
  width: number;
  height: number;
  center: number[];
}

/**
 * The screencast canvas as the viewer sees it, found by walking shadow roots
 * rather than through the shim — so a shim that reports success while leaving
 * the page unfitted still fails here. Waits for the first refit to settle and
 * for a frame of the target page to be painted.
 */
async function probeScreencastCanvas(page: Page, minWidth: number): Promise<CanvasProbe> {
  let probeError: unknown;
  const handle = await page.waitForFunction(
    ({ minWidth, rgb }) => {
      const find = (root: Document | ShadowRoot): HTMLCanvasElement | null => {
        const hit = root.querySelector<HTMLCanvasElement>('.screencast-canvas-container canvas');
        if (hit) return hit;
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (el.shadowRoot) {
            const nested = find(el.shadowRoot);
            if (nested) return nested;
          }
        }
        return null;
      };
      const canvas = find(document);
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const context = canvas.getContext('2d');
      if (!context || canvas.width === 0 || canvas.height === 0) return null;
      const center = Array.from(
        context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data.slice(0, 3),
      );
      const isPage = center.every((value, i) => Math.abs(value - rgb[i]) <= 8);
      if (rect.width < minWidth || !isPage) return null;
      return { width: rect.width, height: rect.height, center };
    },
    { minWidth, rgb: TARGET_RGB },
    { timeout: 10_000, polling: 100 },
  ).catch((error: unknown) => {
    probeError = error;
    return null;
  });
  assert.ok(
    handle,
    `expected a screencast canvas at least ${minWidth}px wide showing the target page` +
      (probeError ? ` (${String(probeError)})` : ''),
  );
  return (await handle.jsonValue()) as CanvasProbe;
}

test('hidden: the shim takes over the real frontend and fills the pane with the page', { skip }, async () => {
  const { page, targetPage, result } = await openShimmedFrontend('hidden');
  try {
    assert.equal(result.state, 'hidden', `shim detail: ${result.detail}`);
    assert.match(result.detail ?? '', /sidebar=false/);
    assert.match(result.detail ?? '', /frame=compact/);
    assert.match(result.detail ?? '', /clipboard=paste\+copy\+cut/);
    // Stock DevTools keeps InspectorView docked on the right, so the screencast
    // can never be wider than the pane minus that sidebar. Wider proves it is
    // gone and the page was refitted to the space it left.
    await probeScreencastCanvas(page, VIEWER.width - STOCK_SIDEBAR_SIZE + 1);
  } finally {
    await page.close();
    await targetPage.close();
  }
});

test('bottom: the shim docks the inspector under the page', { skip }, async () => {
  const { page, targetPage, result } = await openShimmedFrontend('bottom');
  try {
    assert.equal(result.state, 'bottom', `shim detail: ${result.detail}`);
    assert.match(result.detail ?? '', /sidebar=true; orientation=bottom/);
    assert.match(result.detail ?? '', /frame=compact/);
    const canvas = await probeScreencastCanvas(page, 1);
    assert.ok(
      canvas.height < VIEWER.height - STOCK_SIDEBAR_SIZE + 1,
      `canvas is ${canvas.height}px tall, so the inspector is not below it`,
    );
  } finally {
    await page.close();
    await targetPage.close();
  }
});

test('a live position message moves the inspector without a reload', { skip }, async () => {
  const { page, targetPage, result } = await openShimmedFrontend('hidden');
  try {
    assert.equal(result.state, 'hidden', `shim detail: ${result.detail}`);
    await page.evaluate(() => {
      window.postMessage(
        { type: 'omniterm:devtools-shim', inspectorPosition: 'right' },
        window.location.origin,
      );
    });
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-omniterm-screencast-shim') === 'right',
      null,
      { timeout: 5_000 },
    );
    const detail = await page.evaluate(() =>
      document.documentElement.getAttribute('data-omniterm-screencast-shim-detail'),
    );
    assert.match(detail ?? '', /sidebar=true; orientation=right/);
  } finally {
    await page.close();
    await targetPage.close();
  }
});
