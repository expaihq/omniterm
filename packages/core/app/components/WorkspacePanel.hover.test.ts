// Browser check: renders the REAL WorkspacePanel (bundled with its CSS module)
// in headless Chromium and asserts that hovering a row reveals its "×" delete
// button. `.deleteBtn` starts at opacity 0 and each row class must opt in to
// showing it on hover; the OTHERS rows (`.dirItem`) once lacked that rule, so
// their button was clickable but invisible. jsdom can't evaluate :hover, so
// this needs a real browser.
//
// Skips cleanly when playwright-core / esbuild / any Chrome binary is missing.
//
// The `__name` shim in page callbacks: tsx transpiles them with esbuild
// keepNames, which emits calls to a `__name` helper that does not exist in the
// page. See terminalInput.injector.test.ts for the full note.

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Renders the panel with one repo (main + one linked worktree) and one
// OTHERS directory. The linked worktree row is the control: its hover rule
// already existed, so it proves the harness itself can see a hover.
const ENTRY = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import WorkspacePanel from './WorkspacePanel';

const noop = () => {};
const repo = { id: 'r1', name: 'repo', remoteUrl: '', path: '/Users/u/repo' };
const worktrees = {
  r1: [
    { id: 'w0', repoId: 'r1', branch: 'main', path: '/Users/u/repo', name: 'main', sessionCount: 0, isMain: true },
    { id: 'w1', repoId: 'r1', branch: 'feature', path: '/Users/u/wt/feature', name: 'feature', sessionCount: 0 },
  ],
};
const orphanSessions = { '/Users/u/scratch': [{ name: 's1', created: '0' }] };

createRoot(document.getElementById('root')).render(
  createElement(WorkspacePanel, {
    repos: [repo],
    worktreesByRepo: worktrees,
    orphanSessions,
    activeWorktreeId: null,
    activePath: null,
    alertedPaths: new Set(),
    activeOnly: false,
    onSelectWorktree: noop,
    onCreateWorktree: noop,
    onDeleteWorktree: noop,
    onRenameBranch: noop,
    onCloneRepo: async () => new Response(),
    onAddLocalRepo: noop,
    onDeleteRepo: noop,
    onRemoveDir: noop,
    onSelectDirectory: noop,
    onToggleActiveOnly: noop,
    onRefresh: noop,
    onGoHome: noop,
    onCollapse: noop,
  }),
);
`;

/** OMNITERM_CHROME_PATH if set, else Playwright's own Chromium if downloaded,
 *  else a system Chrome from the same list as browserShims.integration.test.ts. */
function resolveChrome(chromium: typeof import('playwright-core').chromium): string | null {
  if (process.env.OMNITERM_CHROME_PATH) return process.env.OMNITERM_CHROME_PATH;
  const candidates: string[] = [];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    /* not configured */
  }
  candidates.push(
    ...(platform() === 'darwin'
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
        ]),
  );
  return candidates.find((p) => existsSync(p)) ?? null;
}

test('hovering a workspace row reveals its delete button', async (t) => {
  let chromium: typeof import('playwright-core').chromium;
  let build: typeof import('esbuild').build;
  try {
    ({ chromium } = await import('playwright-core'));
    ({ build } = await import('esbuild'));
  } catch {
    t.skip('playwright-core / esbuild not installed');
    return;
  }
  const chromiumPath = resolveChrome(chromium);
  if (!chromiumPath) {
    t.skip('no Chrome/Chromium installed');
    return;
  }

  // esbuild compiles *.module.css as local CSS (hashed class names) and emits
  // the stylesheet next to the JS, so the page gets the real rules.
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: __dirname, loader: 'tsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    outdir: path.join(__dirname, '.hover-test-out'),
    write: false,
  });
  const js = result.outputFiles.find((f) => f.path.endsWith('.js'))?.text;
  const css = result.outputFiles.find((f) => f.path.endsWith('.css'))?.text;
  assert.ok(js && css, 'bundle should emit JS and CSS');

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: chromiumPath,
    });
    const page = await browser.newPage();
    // Transitions off: read the settled opacity, not a mid-fade value.
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style>` +
        `<style>*{transition:none!important}</style></head>` +
        `<body><div id="root" style="height:600px;display:flex"></div></body></html>`,
    );
    await page.addScriptTag({ content: js });

    const worktreeRow = page.locator('[title$="double-click to rename"]', {
      hasText: 'feature',
    });
    const dirRow = page.locator('[title="/Users/u/scratch"]');
    await worktreeRow.waitFor();
    await dirRow.waitFor();

    const opacityOf = (row: typeof dirRow, title: string) =>
      row.locator(`button[title="${title}"]`).evaluate((el) => getComputedStyle(el).opacity);

    // Hidden at rest in both lists.
    assert.strictEqual(await opacityOf(worktreeRow, 'Remove worktree'), '0');
    assert.strictEqual(await opacityOf(dirRow, 'Remove directory'), '0');

    await worktreeRow.hover();
    assert.strictEqual(
      await opacityOf(worktreeRow, 'Remove worktree'),
      '1',
      'control: worktree row shows × on hover',
    );

    await dirRow.hover();
    assert.strictEqual(
      await opacityOf(dirRow, 'Remove directory'),
      '1',
      'OTHERS directory row shows × on hover',
    );
  } finally {
    await browser?.close();
  }
});
