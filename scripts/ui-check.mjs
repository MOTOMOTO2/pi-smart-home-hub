#!/usr/bin/env node
/**
 * Browser check for the dashboard.
 *
 * Builds nothing and mocks nothing: it boots the real server with the demo
 * profile, drives the actual UI in headless Chromium, and fails on any
 * console error or unhandled exception. This catches the class of problem a
 * type-check cannot -- a hook used wrongly, a crash while rendering a device
 * panel, a control wired to the wrong command.
 *
 *   node scripts/ui-check.mjs            # headless
 *   node scripts/ui-check.mjs --headed   # watch it happen
 *
 * Requires playwright, which is intentionally not a project dependency:
 *   npm install --no-save playwright && npx playwright install chromium
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.UI_PORT ?? 8478);
const BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.argv.includes('--headed');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  process.stdout.write(
    'skipped: playwright is not installed.\n  npm install --no-save playwright && npx playwright install chromium\n',
  );
  process.exit(0);
}

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failures.push(name);
    process.stdout.write(`  FAIL ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}\n`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(child, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('server never became healthy');
}

async function deviceState(id) {
  const res = await fetch(`${BASE}/api/devices/${id}`);
  return (await res.json()).state;
}

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'dist', 'index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    HUB_PORT: String(PORT),
    HUB_HOST: '127.0.0.1',
    HUB_DEMO: '1',
    HUB_LOG_LEVEL: 'warn',
    HUB_DATA_DIR: path.join('data', 'ui-check'),
    HUB_CONFIG: path.join('config', 'demo.yaml'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(d.toString()));
server.stderr.on('data', (d) => serverLog.push(d.toString()));

let browser;
try {
  await waitForServer(server);
  await fetch(`${BASE}/api/refresh`, { method: 'POST' });

  browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({ viewport: { width: 420, height: 880 }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  process.stdout.write('\ndashboard loads\n');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tile', { timeout: 10_000 });

  check('brand header renders', (await page.locator('.brand').innerText()).includes('Home Hub'));
  check('demo badge is shown', await page.locator('.badge[data-kind="demo"]').isVisible());
  check('websocket reaches the live state', (await page.locator('.conn').innerText()).trim() === 'live');
  check('a tile is rendered for all six devices', (await page.locator('.tile').count()) === 6);
  check('rooms are grouped', (await page.locator('.room').count()) >= 4);
  check('favourite scenes appear in the quick bar', (await page.locator('.scene-btn').count()) === 4);
  check('no device shows a setup badge in the demo profile', (await page.locator('.tile-badge').count()) === 0);
  check('tile status summarises device state', /%|HDMI|Off|On/.test(await page.locator('.tile').first().innerText()));

  process.stdout.write('\nlight controls\n');
  const lightsTile = page.locator('.tile', { hasText: 'Hexagons' });
  await lightsTile.locator('.tile-main').click();
  await page.waitForSelector('.modal');
  check('device panel opens with the device name', (await page.locator('.modal-head h2').innerText()) === 'Hexagons');
  check('brightness slider is present', await page.locator('.slider input[type="range"]').first().isVisible());
  check('colour swatches are present', (await page.locator('.swatch').count()) === 10);
  check('effect chips are listed', (await page.locator('.panel-section .chip').count()) >= 8);

  // Pick the green swatch and confirm the hub applied it. The adapter reports
  // chroma (hue/sat at full value), so #22c55e comes back as #2bff79.
  await page.locator('.swatch').nth(9).click();
  await page.waitForTimeout(1200);
  const afterColor = await deviceState('lights');
  check('clicking a swatch sets the colour on the device', afterColor.hex === '#2bff79', afterColor.hex);
  check(
    'the chosen swatch is highlighted as active',
    (await page.locator('.swatch[data-active="true"]').count()) === 1,
  );

  await page.locator('.panel-section .chip', { hasText: 'Nemo' }).click();
  await page.waitForTimeout(900);
  check('clicking an effect chip selects it', (await deviceState('lights')).effect === 'Nemo');

  const powerToggle = page.locator('.modal .power-main .toggle');
  await powerToggle.click();
  await page.waitForTimeout(900);
  check('power toggle turns the light off', (await deviceState('lights')).on === false);
  check('toast confirms an action', (await page.locator('.toast').count()) >= 0);

  await page.locator('.modal-head .icon-btn').click();
  await page.waitForTimeout(250);
  check('panel closes', (await page.locator('.modal').count()) === 0);

  process.stdout.write('\ntv remote\n');
  await page.locator('.tile', { hasText: 'Living Room TV' }).locator('.tile-main').click();
  await page.waitForSelector('.modal');
  check('d-pad renders', (await page.locator('.dpad-btn').count()) === 5);
  check('volume row renders', await page.locator('.volume-row').isVisible());
  check('input chips render', (await page.locator('.chips .chip', { hasText: 'HDMI1' }).count()) === 1);
  await page.locator('.chip', { hasText: 'HDMI3' }).first().click();
  await page.waitForTimeout(900);
  check('choosing an input switches the TV', (await deviceState('tv')).activeApp === 'HDMI3');
  await page.locator('.volume-row .icon-btn').nth(1).click();
  await page.waitForTimeout(900);
  check('volume up reaches the TV', (await deviceState('tv')).volume > 14);
  await page.locator('.modal-head .icon-btn').click();

  process.stdout.write('\nthermostat\n');
  await page.locator('.tile', { hasText: 'Thermostat' }).locator('.tile-main').click();
  await page.waitForSelector('.thermo');
  check('current temperature is displayed', (await page.locator('.thermo-temp').innerText()).includes('69.4'));
  check('both setpoints are shown', (await page.locator('.setpoint').count()) === 2);
  check('remote sensors are listed', (await page.locator('.sensor').count()) === 2);
  const heatBefore = (await deviceState('thermostat')).heatSetpoint;
  await page.locator('.setpoint[data-side="heat"] .icon-btn').nth(1).click();
  await page.waitForTimeout(1200);
  check('raising the heat setpoint reaches the thermostat', (await deviceState('thermostat')).heatSetpoint === heatBefore + 1);
  await page.locator('.modal-head .icon-btn').click();

  process.stdout.write('\ndoorbell\n');
  await page.locator('.tile', { hasText: 'Front Door' }).locator('.tile-main').click();
  await page.waitForSelector('.camera img');
  // Give the browser a chance to actually decode the image before asserting.
  const snapshot = await page
    .waitForFunction(
      () => {
        const img = document.querySelector('.camera img');
        return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0
          ? { width: img.naturalWidth, height: img.naturalHeight }
          : null;
      },
      undefined,
      { timeout: 8000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  check('camera snapshot renders', snapshot?.width === 640, snapshot);
  check('event history is listed', (await page.locator('.event-list li').count()) >= 4);
  check('battery appears in the details grid', (await page.locator('.detail-grid').innerText()).includes('78%'));
  await page.locator('.modal-head .icon-btn').click();

  process.stdout.write('\nxbox and pc\n');
  await page.locator('.tile', { hasText: 'Xbox One S' }).locator('.tile-main').click();
  await page.waitForSelector('.modal');
  await page.locator('.btn', { hasText: 'Wake' }).click();
  await page.waitForTimeout(3000);
  await fetch(`${BASE}/api/devices/xbox/refresh`, { method: 'POST' });
  check('wake button brings the console up', (await deviceState('xbox')).on === true);
  await page.locator('.modal-head .icon-btn').click();

  process.stdout.write('\nscenes\n');
  await page.locator('.scene-btn', { hasText: 'Movie Night' }).click();
  await page.waitForTimeout(1800);
  const tvAfterScene = await deviceState('tv');
  check('running a scene from the quick bar switches the TV to HDMI2', tvAfterScene.activeApp === 'HDMI2', tvAfterScene.activeApp);
  check('scene run raises a toast', (await page.locator('.toast').count()) >= 1);

  await page.locator('.tab', { hasText: 'Scenes' }).click();
  await page.waitForSelector('.scene-card');
  check('scenes tab lists every scene', (await page.locator('.scene-card').count()) === 5);
  check('scene steps are described', (await page.locator('.scene-steps li').count()) > 5);
  check('config scenes have no delete button', (await page.locator('.scene-card .icon-btn').count()) === 0);

  await page.locator('.btn', { hasText: 'New scene' }).click();
  await page.waitForSelector('.modal');
  await page.locator('.field input').first().fill('UI Check Scene');
  await page.locator('.builder-row select').first().selectOption('lights');
  await page.locator('.builder-row select').nth(1).selectOption('identify');
  await page.locator('.btn', { hasText: 'Save scene' }).click();
  await page.waitForTimeout(1200);
  check('a scene created in the UI appears in the list', (await page.locator('.scene-card').count()) === 6);
  const created = page.locator('.scene-card', { hasText: 'UI Check Scene' });
  check('the created scene is marked as locally created', (await created.innerText()).includes('created here'));
  await created.locator('.icon-btn').click();
  await page.waitForTimeout(900);
  check('the created scene can be deleted again', (await page.locator('.scene-card').count()) === 5);

  process.stdout.write('\nactivity\n');
  await page.locator('.tab', { hasText: 'Activity' }).click();
  await page.waitForSelector('.feed');
  check('event feed has entries', (await page.locator('.feed li').count()) > 0);
  await page.locator('.btn', { hasText: 'Ring the demo doorbell' }).click();
  await page.waitForTimeout(2500);
  check('the demo doorbell shows up in the feed', (await page.locator('.feed li', { hasText: 'ring.ding' }).count()) >= 1);
  await page.locator('.chip', { hasText: 'Logs' }).click();
  await page.waitForTimeout(400);
  check('log view renders lines', (await page.locator('.feed.logs li').count()) > 0);

  process.stdout.write('\nsettings\n');
  await page.locator('.tab', { hasText: 'Settings' }).click();
  await page.waitForSelector('.card');
  check('hub facts are shown', (await page.locator('.card').first().innerText()).includes('demo'));
  check('automations are listed with toggles', (await page.locator('.automation-list li').count()) === 4);
  await page.locator('.automation-list .toggle').first().click();
  await page.waitForTimeout(700);
  const automations = await (await fetch(`${BASE}/api/automations`)).json();
  check('toggling an automation persists', automations.some((a) => a.enabled === false), automations);
  await page.locator('.btn', { hasText: 'Scan the LAN' }).click();
  await page.waitForTimeout(3500);
  check('discovery results render pasteable config', (await page.locator('.discovered-item').count()) >= 2);

  process.stdout.write('\nresponsive layout\n');
  await page.locator('.tab', { hasText: 'Home' }).click();
  await page.waitForSelector('.tile');
  await fs.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, 'dashboard-phone.png'), fullPage: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(400);
  const columns = await page.locator('.tile-grid').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  check('tile grid widens into columns on a tablet', columns >= 3, columns);
  await page.screenshot({ path: path.join(SHOTS, 'dashboard-tablet.png'), fullPage: true });

  await page.locator('.tile', { hasText: 'Hexagons' }).locator('.tile-main').click();
  await page.waitForSelector('.modal');
  await page.screenshot({ path: path.join(SHOTS, 'device-panel.png') });
  await page.locator('.modal-head .icon-btn').click();
  await page.locator('.tab', { hasText: 'Settings' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, 'settings.png'), fullPage: true });

  process.stdout.write('\njavascript health\n');
  check('no uncaught exceptions', pageErrors.length === 0, pageErrors);
  const unexpected = consoleErrors.filter((text) => !/favicon/i.test(text));
  check('no console errors', unexpected.length === 0, unexpected);
} catch (err) {
  failures.push(`crashed: ${err.message}`);
  process.stdout.write(`\n  FAIL ${err.stack ?? err.message}\n`);
} finally {
  await browser?.close();
  server.kill();
  await sleep(300);
  if (server.exitCode === null) server.kill('SIGKILL');
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  process.stdout.write(`\nfailed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
  process.stdout.write(`\nserver output:\n${serverLog.join('')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`screenshots written to docs/screenshots\n`);
}
