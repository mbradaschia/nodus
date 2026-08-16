// Opens the real Nodus app (your normal profile) and leaves the window up.
// Also screenshots the Providers panel so the new Claude row can be checked.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const shots = path.join(repoRoot, '.shots');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Isolated profile: the installed /Applications/Nodus.app is running and holds the
// single-instance lock on the shared userData path. This also keeps the real vault
// untouched. The Claude session is read from ~/.claude, so it is unaffected.
env.NODUS_USERDATA = process.env.NODUS_USERDATA
  || path.join(repoRoot, '.shots', 'profile');
env.NODUS_DISABLE_AUTO_UPDATE = '1';

const app = await electron.launch({
  executablePath: require('electron'),
  args: [repoRoot],
  env,
});

const page = await app.firstWindow();
page.setDefaultTimeout(60_000);
page.on('pageerror', (e) => process.stderr.write(`[pageerror] ${e?.stack ?? e}\n`));

await page.waitForLoadState('domcontentloaded');
await page.waitForFunction(() => {
  const root = document.getElementById('root');
  return !!root && root.children.length > 0;
}, { timeout: 60_000 });
console.log('renderer mounted');

await page.screenshot({ path: path.join(shots, '01-launch.png') });

// A fresh isolated profile opens on first-run onboarding. Mark it complete through the
// app's own settings API rather than clicking the whole tutorial, then reload.
await page.evaluate(async (version) => {
  localStorage.setItem('nodus.lastSeenVersion', version);
  await window.nodus.updateSettings({
    onboardingComplete: true,
    basicsTutorialVersion: 1,
    mascotStyle: 'classic',
    mascotStyleChosen: true,
    tourComplete: true,
  });
}, require(path.join(repoRoot, 'package.json')).version);
await page.reload();
await page.waitForFunction(() => {
  const root = document.getElementById('root');
  return !!root && root.children.length > 0;
}, { timeout: 60_000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(shots, '02-app.png') });

await page.locator('[data-tour="nav-settings"]').click();
await page.getByRole('button', { name: 'Proveedores', exact: true }).click();

const row = page.locator('[data-testid="claude-code-subscription-provider"]');
await row.waitFor({ timeout: 30_000 });
await row.scrollIntoViewIfNeeded().catch(() => {});
// Pure disclosure toggle — expanding writes no settings.
await row.locator('button').first().click();
await page.waitForTimeout(3000);
console.log('--- Claude provider row ---');
console.log(await row.innerText());
await row.screenshot({ path: path.join(shots, '03-claude-row.png') }).catch(() => {});
await page.screenshot({ path: path.join(shots, '04-providers.png') });
console.log('screenshots written to .shots/');
console.log('app is open — leaving it running');
