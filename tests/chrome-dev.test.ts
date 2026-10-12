import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("dev startup retains only the conversation tab and closes restored test windows", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jamak-dev-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await copyFile(new URL("../scripts/dev-chrome.mjs", import.meta.url), join(root, "scripts/dev-chrome.mjs"));
  for (const name of ["playwright", "vite"]) {
    await mkdir(join(root, "node_modules", name), { recursive: true });
    await writeFile(join(root, "node_modules", name, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  }
  await writeFile(join(root, "node_modules/vite/index.js"), `
    import { appendFileSync } from 'node:fs';
    const closed = name => appendFileSync('closed.log', name + '\\n');
    export async function createServer() { return { async listen() {}, async close() { closed('server'); } }; }
    export async function build() { return { on(_event, callback) { setImmediate(() => callback({ code: 'END' })); },
      async close() { closed('watcher'); } }; }
  `);
  await writeFile(join(root, "node_modules/playwright/index.js"), `
    import { writeFileSync, appendFileSync } from 'node:fs';
    import { EventEmitter } from 'node:events';
    const pages = [];
    function page(url, windowId) {
      const result = { address: url, windowId, closed: false, url() { return this.address; },
        async goto(url) { this.address = url; }, async close() { this.closed = true; }, async waitForLoadState() {},
        async bringToFront() {
          writeFileSync('pages.json', JSON.stringify(pages.map(page => ({ url: page.address, closed: page.closed, windowId: page.windowId }))));
          setImmediate(() => browser.emit('close'));
        } };
      pages.push(result); browser.emit('page', result); return result;
    }
    const browser = Object.assign(new EventEmitter(), {
      serviceWorkers() { return [{ url() { return 'chrome-extension://test/service-worker.js'; } }]; },
      pages() { return pages.filter(page => !page.closed); },
      async newPage() { return page('about:blank', 3); },
      waitForEvent(event, options) { return new Promise(resolve => {
        const listener = page => { if (!options.predicate || options.predicate(page)) { browser.off(event, listener); resolve(page); } };
        browser.on(event, listener);
      }); },
      async close() { appendFileSync('closed.log', 'browser\\n'); },
    });
    export const chromium = { executablePath() { return process.execPath; },
      async launchPersistentContext(profile, options) {
        writeFileSync('launch.json', JSON.stringify({ profile, args: options.args }));
        setImmediate(() => { page('chrome://extensions', 1); page('chrome-extension://test/advanced.html', 2); page('about:blank', 3); });
        return browser;
      } };
  `);
  const child = spawn(process.execPath, [join(root, "scripts/dev-chrome.mjs")], { cwd: root });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, output);
  const pages: { url: string; closed: boolean; windowId: number }[] = JSON.parse(await readFile(join(root, "pages.json"), "utf8"));
  assert.deepEqual(pages.filter(page => !page.closed).map(page => page.url), ["http://127.0.0.1:8790/?language=ja"]);
  assert.equal(new Set(pages.filter(page => !page.closed).map(page => page.windowId)).size, 1);
  assert.equal(pages.filter(page => page.closed).length, 2);
  const launch = JSON.parse(await readFile(join(root, "launch.json"), "utf8"));
  assert.equal(launch.profile, join(root, ".ralph/dev/chrome-profile"));
  assert.ok(launch.args.includes(`--load-extension=${join(root, ".ralph/dev/extension")}`));
  assert.deepEqual((await readFile(join(root, "closed.log"), "utf8")).trim().split("\n").sort(), ["browser", "server", "watcher"]);
});
