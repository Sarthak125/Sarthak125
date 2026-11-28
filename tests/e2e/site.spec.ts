import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const HAR = 'tests/fixtures/api.har.zip';
const PRACTICE_HAR = 'tests/fixtures/practice.har.zip';
const APIS = /api\.openf1\.org|api\.jolpi\.ca|multiviewer\.app|open-meteo\.com/;
// The recording was made at this moment: after the Las Vegas race, with OpenF1 open again.
const AFTER_RACE = new Date('2026-11-22T08:00:00Z');

async function setUp(page: Page, at = AFTER_RACE, settings?: object) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (settings) await page.addInitScript((s) => localStorage.setItem('pitwall:settings', JSON.stringify(s)), settings);
  await page.clock.install({ time: at });
  await page.routeFromHAR(HAR, { url: APIS, notFound: 'abort' });
  // Practice 3, recorded separately; tried first, anything it lacks falls through to the main recording.
  await page.routeFromHAR(PRACTICE_HAR, { url: /api\.openf1\.org/, notFound: 'fallback' });
  // Standings after round 20, which the provisional Las Vegas results build on (asked for after the recording was made).
  for (const kind of ['driverstandings', 'constructorstandings']) {
    await page.route(`https://api.jolpi.ca/ergast/f1/current/20/${kind}/?limit=100`, (r) => r.fulfill({ path: `tests/fixtures/r20-${kind}.json`, headers: { 'access-control-allow-origin': '*' } }));
  }
  return errors;
}

async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

async function pickSession(page: Page, name: string) {
  const sel = page.locator('.session-bar select[aria-label="Session"]');
  const value = await sel.locator('option').evaluateAll((os, n) => os.find((o) => (o.textContent ?? '').startsWith(n))!.getAttribute('value'), name);
  await sel.selectOption(value!);
}

for (const [route, text] of [
  ['#/', 'Las Vegas'],
  ['#/standings', "Drivers' Championship"],
  ['#/calendar', 'Calendar'],
  ['#/drivers', 'Drivers'],
  ['#/race/21', 'Las Vegas Grand Prix'],
  ['#/driver/VER', 'Verstappen'],
  ['#/team/ferrari', 'Ferrari'],
  ['#/settings', 'Settings'],
  ['#/help', 'How to use Pit Wall'],
  ['#/review', 'season review'],
] as const) {
  test(`page ${route} loads without errors or sideways scrolling`, async ({ page }) => {
    const errors = await setUp(page);
    await page.goto(route);
    await expect(page.locator('main')).toContainText(text, { timeout: 20_000 });
    await noSidewaysScroll(page);
    expect(errors).toEqual([]);
  });
}

test('Live Timing: the finished race has gaps, charts, pit stops and strategy', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/live');
  const rows = page.locator('table.timing tbody tr');
  await expect(rows).toHaveCount(22, { timeout: 30_000 });
  await expect(page.locator('.session-bar')).toContainText('FINISHED');
  await expect(rows.nth(1)).toContainText(/\+\d+\.\d{3}/);
  await expect(page.locator('section[aria-labelledby="positions"] svg.pos-chart path')).toHaveCount(10, { timeout: 20_000 });
  await expect(page.locator('section[aria-labelledby="pitstops"] tbody tr').first()).toBeVisible();
  await expect(page.locator('.strategy-row:not(.axis)')).toHaveCount(22);
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test('Live Timing: qualifying shows the knockout view', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/live');
  await expect(page.locator('table.timing tbody tr')).toHaveCount(22, { timeout: 30_000 });
  await pickSession(page, 'Qualifying');
  await expect(page.locator('table.timing th', { hasText: 'Q3' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.pit-pill.knocked', { hasText: 'OUT Q1' })).toHaveCount(6);
  await expect(page.locator('.pit-pill.knocked', { hasText: 'OUT Q2' })).toHaveCount(6);
  await expect(page.locator('.session-bar')).toContainText('Final classification');
  expect(errors).toEqual([]);
});

test('Live Timing: practice shows long runs', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/live');
  await expect(page.locator('table.timing tbody tr')).toHaveCount(22, { timeout: 30_000 });
  await pickSession(page, 'Practice 3');
  await expect.poll(() => page.locator('.longruns tbody tr').count(), { timeout: 30_000 }).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});

test('spoiler-free mode covers the weekend until revealed', async ({ page }) => {
  const errors = await setUp(page, AFTER_RACE, { spoilerFree: true });
  await page.goto('#/standings');
  await expect(page.locator('.spoiler-cover').first()).toBeVisible({ timeout: 20_000 });
  await page.locator('.spoiler-cover button').first().click();
  await expect(page.locator('.spoiler-cover')).toHaveCount(0);
  await expect(page.locator('main')).toContainText("Drivers' Championship");
  expect(errors).toEqual([]);
});

test('calendar download is a valid .ics file', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/calendar');
  const button = page.locator('.cal-btn').first();
  await expect(button).toBeVisible({ timeout: 20_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const ics = readFileSync(await download.path(), 'utf8');
  expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
  expect(ics.match(/BEGIN:VEVENT/g)?.length).toBeGreaterThan(0);
  expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  expect(errors).toEqual([]);
});

test('during a live race with OpenF1 paused, Live Timing reads F1\'s feed', async ({ page }) => {
  const snapshot = JSON.parse(readFileSync('tests/fixtures/feed-snapshot.json', 'utf8'));
  // Mid-race: OpenF1 refuses free requests then, so nothing it would be asked for is in the recording.
  const errors = await setUp(page, new Date('2026-11-22T04:30:00Z'));
  await page.routeWebSocket(/livetiming\.formula1\.com/, (ws) => {
    ws.onMessage((msg) => {
      for (const part of String(msg).split('\x1e')) {
        if (!part) continue;
        const m = JSON.parse(part);
        if (m.protocol) ws.send('{}\x1e');
        if (m.target === 'Subscribe') ws.send(JSON.stringify({ type: 3, invocationId: '0', result: snapshot }) + '\x1e');
      }
    });
  });
  await page.goto('#/live');
  await expect(page.locator('.feed-note')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.session-bar')).toContainText('LIVE');
  await expect.poll(() => page.locator('table.timing tbody tr').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(20);
  await expect(page.locator('table.timing th', { hasText: 'SPEED' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('when F1\'s feed drops, the last timing stays up and the status pill offers a retry', async ({ page }) => {
  const snapshot = JSON.parse(readFileSync('tests/fixtures/feed-snapshot.json', 'utf8'));
  const errors = await setUp(page, new Date('2026-11-22T04:30:00Z'));
  const sockets: { close: () => Promise<void> }[] = [];
  await page.routeWebSocket(/livetiming\.formula1\.com/, (ws) => {
    sockets.push(ws);
    ws.onMessage((msg) => {
      for (const part of String(msg).split('\x1e')) {
        if (!part) continue;
        const m = JSON.parse(part);
        if (m.protocol) ws.send('{}\x1e');
        if (m.target === 'Subscribe') ws.send(JSON.stringify({ type: 3, invocationId: '0', result: snapshot }) + '\x1e');
      }
    });
  });
  await page.goto('#/live');
  const pill = page.locator('.feed-status');
  await expect(pill).toHaveText('F1 feed live', { timeout: 30_000 });
  await sockets[0].close();
  await expect(pill).toContainText('Reconnecting');
  await expect(page.locator('table.timing tbody tr')).toHaveCount(22);
  await pill.getByRole('button', { name: 'Retry now' }).click();
  await expect(pill).toHaveText('F1 feed live');
  expect(sockets).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('the Android app download serves the APK', async ({ page, request }) => {
  const errors = await setUp(page);
  await page.goto('#/help');
  const link = page.getByRole('link', { name: /Download for Android/ });
  await expect(link).toBeVisible();
  const res = await request.get(new URL((await link.getAttribute('href'))!, page.url()).href);
  expect(res.status()).toBe(200);
  const body = await res.body();
  expect(body.subarray(0, 2).toString()).toBe('PK');
  expect(body.length).toBeGreaterThan(500_000);
  expect(errors).toEqual([]);
});

test('a decided championship shows the champions on the Dashboard and in the standings', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/');
  const banner = page.locator('.champions');
  await expect(banner).toContainText('World Champion', { timeout: 30_000 });
  await expect(banner).toContainText('Antonelli');
  await expect(banner).toContainText('decided at the Mexico City Grand Prix (round 19)');
  await expect(banner).toContainText("Constructors' Champions");
  await page.goto('#/standings');
  await expect(page.locator('.champion-tag')).toHaveCount(2, { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('the season review shows highlights, drivers, team-mate battles and teams', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/review');
  await expect(page.locator('.review-tile').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.review-tiles')).toContainText('Different winners');
  await expect(page.locator('.review-tbl').first().locator('tbody tr')).toHaveCount(25, { timeout: 30_000 });
  await expect(page.locator('.review-battle')).toHaveCount(11);
  // Each pair with qualifying times shows their typical lap-time gap.
  await expect(page.locator('.review-battle-gap').first()).toContainText(/Typical qualifying gap: \w{3} quicker by \d\.\d\d% \(\d\.\d{3} s\), over \d+ rounds?/);
  expect(errors).toEqual([]);
});

test('moving between pages shows only the new page', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/');
  await expect(page.locator('.champions')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => (location.hash = '#/settings'));
  await expect(page.locator('main h1')).toHaveText('Settings');
  await expect(page.locator('.champions')).toHaveCount(0);
  await page.evaluate(() => (location.hash = '#/calendar'));
  await expect(page.locator('main h2', { hasText: 'Appearance' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a race page tells the race story', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/race/21');
  const story = page.locator('.story');
  await expect(story).toContainText('Max Verstappen leads away from pole', { timeout: 60_000 });
  await expect(story).toContainText('Battle for the lead: George Russell and Max Verstappen');
  await expect(story).toContainText('Laps 19 to 25');
  await expect(story).toContainText('+10s for Lewis Hamilton');
  await expect(story).toContainText('Max Verstappen wins');
  const before = await story.locator('li').count();
  await page.getByRole('button', { name: /Show all pit stops/ }).click();
  expect(await story.locator('li').count()).toBeGreaterThan(before);
  expect(errors).toEqual([]);
});

test('lap times of two drivers can be compared in the race', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/race/21');
  const card = page.locator('section:has(#lapcmp)');
  await expect(card.locator('svg[role=img]')).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole('tab', { name: 'Race' })).toHaveAttribute('aria-selected', 'true');
  await expect(card.locator('select').first()).toHaveValue('3');
  await expect(card.locator('select').nth(1)).toHaveValue('1');
  await expect(card).toContainText('a lap quicker on average');
  await card.locator('select').nth(1).selectOption('81');
  await expect(card).toContainText('PIA');
  await card.getByRole('button', { name: 'Show laps as a table' }).click();
  await expect(card.locator('table tbody tr')).toHaveCount(50);
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test('the light theme can be picked in Settings and is kept', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/settings');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await bg()).toBe('rgb(11, 13, 16)');
  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-resolved-theme', 'light');
  expect(await bg()).toBe('rgb(244, 245, 247)');
  await page.reload();
  expect(await page.locator('html').getAttribute('data-resolved-theme')).toBe('light');
  await page.getByRole('radio', { name: 'Auto' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'auto');
  expect(errors).toEqual([]);
});

/** Responses the recording does not have: car data and positions for both fastest laps, and a Wikipedia summary. */
async function extraFixtures(page: Page) {
  await page.route(/api\.openf1\.org\/v1\/(car_data|location)\?/, (r) => {
    const u = new URL(r.request().url());
    const file = `tests/fixtures/extra/${u.pathname.split('/').pop()}-${u.searchParams.get('driver_number')}.json`;
    // Other car data and positions (such as the sector lines' lap) come from the recording.
    return existsSync(file) && u.searchParams.get('session_key') === '11420' ? r.fulfill({ path: file, headers: { 'access-control-allow-origin': '*' } }) : r.fallback();
  });
  await page.route(/en\.wikipedia\.org\/api\/rest_v1\/page\/summary\//, (r) =>
    /Max_Verstappen/.test(r.request().url()) ? r.fulfill({ path: 'tests/fixtures/extra/wiki-Max_Verstappen.json', headers: { 'access-control-allow-origin': '*' } }) : r.fulfill({ status: 404, body: '{}' }),
  );
  // A tall portrait photo, like many of Wikipedia's.
  await page.route(/\.wikimedia\.org/, (r) =>
    r.fulfill({ body: '<svg xmlns="http://www.w3.org/2000/svg" width="330" height="440"><rect width="330" height="440" fill="#456"/></svg>', contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' } }),
  );
}

test('fastest laps of two drivers can be compared point by point', async ({ page }) => {
  const errors = await setUp(page);
  await extraFixtures(page);
  await page.goto('#/race/21');
  const card = page.locator('section:has(#lapcmp)');
  await card.getByRole('tab', { name: /Fastest laps/ }).click({ timeout: 60_000 });
  await expect(card).toContainText('NOR 0.268 s quicker', { timeout: 60_000 });
  await expect(card.locator('.trace-grid svg')).toHaveCount(2);
  await expect(card.locator('.legend')).toContainText('VER quicker');
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test('a race page ranks race pace with each stint and its tyre wear', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/race/21');
  const card = page.locator('section:has(#pace)');
  await expect(card.locator('tbody tr').first()).toContainText('PIA', { timeout: 60_000 });
  await expect(card.locator('tbody tr').first()).toContainText('Best');
  await expect(card.locator('tbody tr')).toHaveCount(10);
  await card.getByRole('button', { name: /Show all/ }).click();
  expect(await card.locator('tbody tr').count()).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});

test('driver pages show a short biography from Wikipedia beside the card, with credit and no second photo', async ({ page }) => {
  const errors = await setUp(page);
  await extraFixtures(page);
  await servePhotos(page);
  await page.goto('#/driver/VER');
  const section = page.locator('section[aria-labelledby="driver-card"]');
  await expect(section).toContainText('Max Emilian Verstappen', { timeout: 60_000 });
  await expect(section.getByRole('link', { name: /Wikipedia/ })).toHaveAttribute('href', /wikipedia\.org\/wiki\/Max_Verstappen/);
  // The card already has the photo, so the text has no photo of its own and there is no separate About section.
  await expect(page.locator('.wiki-photo')).toHaveCount(0);
  await expect(page.locator('section:has(.wiki)')).toHaveCount(1);
  // The text is laid out beside the card (laptop) or below it (phone), never on top of it.
  const box = (sel: string) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
  const [card, text] = [await box('section[aria-labelledby="driver-card"] .dc'), await box('.wiki-text')];
  expect(text.left >= card.right - 1 || text.top >= card.bottom - 1).toBe(true);
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test('when Jolpica is slow, a page shows the saved data within seconds and says so', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/driver/VER');
  await expect(page.locator('.profile-head')).toContainText('Max Verstappen', { timeout: 60_000 });
  // Let the first visit finish saving everything it loaded.
  await page.waitForLoadState('networkidle');
  // 20 minutes later the saved standings are out of date and Jolpica takes 45 seconds to answer.
  await page.clock.fastForward('20:00');
  let slow = true;
  await page.route(/api\.jolpi\.ca/, async (r) => {
    if (!slow) return r.fallback();
    await new Promise((f) => setTimeout(f, 45_000));
    return r.fulfill({ status: 504, body: 'Gateway Timeout' }).catch(() => {});
  });
  const t = Date.now();
  await page.reload();
  await expect(page.locator('.profile-head')).toContainText('Max Verstappen', { timeout: 15_000 });
  expect(Date.now() - t).toBeLessThan(15_000);
  await expect(page.locator('.slow-note')).toContainText('Jolpica');
  // Once Jolpica answers again, the note goes away.
  slow = false;
  await page.getByRole('button', { name: /Refresh/i }).first().click().catch(() => {});
  await expect(page.locator('.slow-note')).toHaveCount(0, { timeout: 30_000 });
  expect(errors).toEqual([]);
});

/** Pit Wall's own copy of the Jolpica data, made by scripts/mirror-jolpica.mjs from the same recording. */
const MIRROR = JSON.parse(gunzipSync(readFileSync('tests/fixtures/mirror.json.gz')).toString()) as { manifest: unknown; files: Record<string, unknown> };
async function serveMirror(page: Page) {
  await page.route(/\/data\/jolpica\//, (r) => {
    const key = decodeURIComponent(new URL(r.request().url()).pathname.split('/data/jolpica/')[1]);
    const body = key === 'manifest.json' ? MIRROR.manifest : MIRROR.files[key];
    return body === undefined ? r.fulfill({ status: 404, body: 'Not found' }) : r.fulfill({ json: body });
  });
}

test('with Jolpica down, pages load from Pit Wall\'s own copy of its data', async ({ page }) => {
  const errors = await setUp(page);
  await serveMirror(page);
  const asked: string[] = [];
  await page.route(/api\.jolpi\.ca/, (r) => {
    asked.push(r.request().url());
    return r.abort();
  });
  await page.goto('#/standings');
  await expect(page.locator('main table').first().locator('tbody tr').first()).toContainText('Antonelli', { timeout: 20_000 });
  await page.goto('#/calendar');
  await expect(page.locator('main')).toContainText('Verstappen', { timeout: 20_000 });
  await page.goto('#/race/21');
  await expect(page.locator('main')).toContainText('Max Verstappen', { timeout: 20_000 });
  await page.goto('#/');
  await expect(page.locator('.champions')).toContainText('Antonelli', { timeout: 20_000 });
  // Only data the copy does not hold (such as circuit history) went to Jolpica.
  expect(asked.filter((u) => /\/(current|2026)\/(races|results|sprint|qualifying|driverstandings|constructorstandings)\//.test(u))).toEqual([]);
  expect(errors).toEqual([]);
});

/** The Settings page says how old Pit Wall's data copy is (the test clock is 2026-11-22 08:00 UTC). */
async function manifestFrom(page: Page, dataFrom: string | null) {
  await page.route(/\/data\/jolpica\//, (r) => {
    const key = new URL(r.request().url()).pathname.split('/data/jolpica/')[1];
    if (key === 'manifest.json' && dataFrom) return r.fulfill({ json: { ...(MIRROR.manifest as object), dataFrom } });
    return r.fulfill({ status: 404, body: 'Not found' });
  });
}

test('Settings shows how fresh the data copy is', async ({ page }) => {
  const errors = await setUp(page);
  await manifestFrom(page, '2026-11-22T05:00:00Z');
  await page.goto('#/settings');
  const card = page.locator('section[aria-labelledby="data-copy"]');
  await expect(card).toContainText('fetched 3 hours ago', { timeout: 20_000 });
  await expect(card).not.toContainText('older than usual');
  expect(errors).toEqual([]);
});

test('Settings warns when the data copy has stopped refreshing', async ({ page }) => {
  const errors = await setUp(page);
  await manifestFrom(page, '2026-11-21T08:00:00Z');
  await page.goto('#/settings');
  const card = page.locator('section[aria-labelledby="data-copy"]');
  await expect(card).toContainText('fetched 24 hours ago', { timeout: 20_000 });
  await expect(card).toContainText('older than usual');
  expect(errors).toEqual([]);
});

test('Settings says so when there is no data copy', async ({ page }) => {
  const errors = await setUp(page);
  await manifestFrom(page, null);
  await page.goto('#/settings');
  await expect(page.locator('section[aria-labelledby="data-copy"]')).toContainText('No copy is available', { timeout: 20_000 });
  expect(errors).toEqual([]);
});

/** Pit Wall's copy of finished-session OpenF1 data, made by scripts/mirror-openf1.mjs (here from the same recording). */
const OF1_MIRROR = JSON.parse(gunzipSync(readFileSync('tests/fixtures/openf1mirror.json.gz')).toString()) as { manifest: unknown; files: Record<string, unknown> };

test('with OpenF1 refusing the race\'s data, the race page loads from Pit Wall\'s own copy', async ({ page }) => {
  const errors = await setUp(page);
  await page.route(/\/data\/openf1\//, (r) => {
    const key = decodeURIComponent(new URL(r.request().url()).pathname.split('/data/openf1/')[1]);
    const body = key === 'manifest.json' ? OF1_MIRROR.manifest : OF1_MIRROR.files[key];
    return body === undefined ? r.fulfill({ status: 404, body: 'Not found' }) : r.fulfill({ json: body });
  });
  const asked: string[] = [];
  await page.route(/api\.openf1\.org\/v1\/(drivers|laps|stints|pit|race_control|session_result)\?session_key=11420$/, (r) => {
    asked.push(r.request().url());
    return r.fulfill({ status: 401, body: 'refused' });
  });
  await page.goto('#/race/21');
  await expect(page.locator('.story')).toContainText('Max Verstappen wins', { timeout: 60_000 });
  await expect(page.locator('section:has(#lapcmp) svg[role=img]')).toBeVisible({ timeout: 60_000 });
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
});

test('a race page ranks pit stops by stationary time, fastest first', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/race/21');
  const card = page.locator('section[aria-labelledby="pits"]');
  await expect(card.locator('tbody tr').first()).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText('Fastest stop:');
  await expect(card.locator('thead')).toContainText('Stationary');
  const times = (await card.locator('tbody tr td:last-child').allTextContents()).map((t) => parseFloat(t));
  expect(times.length).toBe(10);
  expect([...times].sort((a, b) => a - b)).toEqual(times);
  await card.getByRole('button', { name: /Show all \d+ stops/ }).click();
  expect(await card.locator('tbody tr').count()).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});

test('without stationary times, pit stops are ranked by pit lane time and the card says so', async ({ page }) => {
  const errors = await setUp(page);
  const recorded = OF1_MIRROR.files['pit/session_key-11420.json'] as { stop_duration: number | null }[];
  await page.route(/api\.openf1\.org\/v1\/pit\?session_key=11420$/, (r) => r.fulfill({ json: recorded.map((x) => ({ ...x, stop_duration: null })) }));
  await page.goto('#/race/21');
  const card = page.locator('section[aria-labelledby="pits"]');
  await expect(card).toContainText('Fastest pit lane time', { timeout: 60_000 });
  await expect(card.locator('thead')).toContainText('Pit lane');
  await expect(card).toContainText('no stationary times');
  expect(errors).toEqual([]);
});

test('a race page with stationary times ranks the stops and marks long ones', async ({ page }) => {
  const errors = await setUp(page);
  const recorded = OF1_MIRROR.files['pit/session_key-11420.json'] as { stop_duration: number | null; pit_duration: number | null }[];
  // Give every stop a stationary time between 2.0 and 3.0 s, and one a repair of 12.3 s.
  const timed = recorded.map((x, i) => (x.pit_duration ? { ...x, stop_duration: i === 3 ? 12.3 : 2 + (i % 10) / 10 } : x));
  await page.route(/api\.openf1\.org\/v1\/pit\?session_key=11420$/, (r) => r.fulfill({ json: timed }));
  await page.goto('#/race/21');
  const card = page.locator('section[aria-labelledby="pits"]');
  await expect(card).toContainText('Fastest stop', { timeout: 60_000 });
  await expect(card.locator('thead')).toContainText('Stationary');
  await expect(card).toContainText('2.0 s');
  await card.getByRole('button', { name: /Show all \d+ stops/ }).click();
  await expect(card.locator('tbody tr td:last-child').filter({ hasText: '12.3 s long' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Standings can show pit stops by team, loading only when asked', async ({ page }) => {
  const errors = await setUp(page);
  const asked: string[] = [];
  const races = (MIRROR.files['current/races/limit-100.json'] as { MRData: { RaceTable: { Races: { round: string; date: string }[] } } }).MRData.RaceTable.Races;
  await page.route(/api\.openf1\.org\/v1\/sessions\?year=2026&session_name=Race$/, (r) =>
    r.fulfill({ json: races.map((x) => ({ session_key: 9000 + Number(x.round), session_name: 'Race', date_start: `${x.date}T13:00:00+00:00`, year: 2026 })) }));
  await page.route(/api\.openf1\.org\/v1\/pit\?session_key=90\d\d$/, (r) => {
    asked.push(r.request().url());
    const round = Number(new URL(r.request().url()).searchParams.get('session_key')) - 9000;
    const results = (MIRROR.files[`current/${round}/results/limit-100.json`] as { MRData: { RaceTable: { Races: { Results: { number: string }[] }[] } } }).MRData.RaceTable.Races[0]?.Results ?? [];
    // The first three finishers stop twice: 2.0 s, 2.5 s and 3.0 s; the winner's team also had one 9.5 s stop in round 1.
    const rows = results.slice(0, 3).flatMap((x, i) => [0, 1].map((n) => ({ date: `2026-01-01T00:0${n}:00+00:00`, driver_number: Number(x.number), lap_number: 10 + n, stop_duration: 2 + i / 2, lane_duration: 22, pit_duration: 22 })));
    if (round === 1 && results[0]) rows.push({ date: '2026-01-01T00:05:00+00:00', driver_number: Number(results[0].number), lap_number: 30, stop_duration: 9.5, lane_duration: 30, pit_duration: 30 });
    return r.fulfill({ json: rows });
  });
  await page.goto('#/standings');
  const card = page.locator('section[aria-labelledby="season-pits"]');
  await expect(card.getByRole('button', { name: 'Show pit stops by team' })).toBeVisible({ timeout: 30_000 });
  expect(asked).toEqual([]);
  await card.getByRole('button', { name: 'Show pit stops by team' }).click();
  await expect(card.locator('tbody tr').first()).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText(/All \d+ races/, { timeout: 60_000 });
  await expect(card.locator('thead')).toContainText('Typical');
  expect(await card.locator('tbody tr').count()).toBeGreaterThan(1);
  expect(asked.length).toBeGreaterThan(5);
  // Teams are listed with the quickest typical stop first.
  const typical = (await card.locator('tbody tr td:nth-child(3)').allTextContents()).map((t) => parseFloat(t));
  expect([...typical].sort((a, b) => a - b)).toEqual(typical);
  expect(errors).toEqual([]);
});

test('a driver whose title is still open gets a what-if for the rest of the season', async ({ page }) => {
  const errors = await setUp(page);
  // Make the championship close: the leader's points are cut so Verstappen is 26 points behind with two races left.
  const standings = JSON.parse(JSON.stringify(MIRROR.files['current/driverstandings/limit-100.json']));
  const list = standings.MRData.StandingsTable.StandingsLists[0].DriverStandings as { points: string; Driver: { code?: string } }[];
  list[0].points = '330';
  await page.route(/\/data\/jolpica\//, (r) => {
    const key = decodeURIComponent(new URL(r.request().url()).pathname.split('/data/jolpica/')[1]);
    const body = key === 'manifest.json' ? MIRROR.manifest : key === 'current/driverstandings/limit-100.json' ? standings : MIRROR.files[key];
    return body === undefined ? r.fulfill({ status: 404, body: 'Not found' }) : r.fulfill({ json: body });
  });
  await page.goto('#/driver/VER');
  const box = page.locator('section[aria-labelledby="maths"]');
  await expect(box).toContainText('Can still win', { timeout: 30_000 });
  const what = box.getByRole('group', { name: 'Title scenario' });
  await expect(what).toBeVisible();
  // Two Grands Prix left (and any sprint): winning both beats a rival who is second in both.
  await expect(what.getByRole('status')).toContainText('would be champion');
  await what.getByLabel(/Verstappen finishes/).selectOption('0');
  await expect(what.getByRole('status')).toContainText(/\w+ would be champion/);
  await expect(what.getByRole('status')).not.toContainText('Verstappen would be champion');
  expect(errors).toEqual([]);
});

test('a driver whose title is decided has no what-if', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/driver/VER');
  await expect(page.locator('section[aria-labelledby="maths"]')).toContainText('Can no longer win the title', { timeout: 30_000 });
  await expect(page.getByRole('group', { name: 'Title scenario' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

/** The driver card tests give Hamilton a photo, as Pit Wall's own photo copy would (tests/fixtures/extra/photo-hamilton.jpg). */
async function servePhotos(page: Page) {
  await page.route(/\/data\/photos\/manifest\.json/, (r) => r.fulfill({
    json: { photos: { hamilton: { file: 'hamilton.jpg', title: 'Example.jpg', artist: 'An Example Photographer', licence: 'CC BY-SA 4.0', page: 'https://commons.wikimedia.org/wiki/File:Example.jpg' } } },
  }));
  await page.route(/\/data\/photos\/hamilton\.jpg/, (r) => r.fulfill({ path: 'tests/fixtures/extra/photo-hamilton.jpg', contentType: 'image/jpeg' }));
}

test('a driver page shows the driver card: overall rating, six stat ratings and a photo with its credit', async ({ page }) => {
  const errors = await setUp(page);
  await servePhotos(page);
  await page.goto('#/driver/HAM');
  const card = page.locator('section[aria-labelledby="driver-card"]');
  const face = card.getByTestId('driver-card');
  await expect(face).toBeVisible({ timeout: 40_000 });
  await expect(face.locator('.dc-front .dc-ovr b')).toHaveText(/^\d{2}$/);
  const ratings = await face.locator('.dc-front .dc-cell .dc-r').allTextContents();
  expect(ratings).toHaveLength(6);
  for (const r of ratings) expect(Number(r)).toBeGreaterThanOrEqual(1);
  for (const r of ratings) expect(Number(r)).toBeLessThanOrEqual(99);
  await expect(face.locator('.dc-front .dc-cell .dc-l')).toHaveText(['Points / race', 'Qualifying', 'Race finish', 'Points finishes', 'Finish rate', 'Team-mate duel']);
  await expect(face.locator('.dc-photo img')).toBeVisible();
  // The back holds the season trend, results, the team-mate comparison and the photo credit.
  await face.getByRole('button', { name: /card over/ }).first().click();
  await expect(face.locator('.dc-back')).toContainText('Championship position');
  await expect(face.locator('.dc-back')).toContainText(/Against \w+/);
  await expect(face.locator('.dc-back .dc-credit')).toContainText('An Example Photographer');
  await expect(face.locator('.dc-back .dc-credit a')).toHaveAttribute('href', 'https://commons.wikimedia.org/wiki/File:Example.jpg');
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test('a driver without a freely licensed photo gets a silhouette', async ({ page }) => {
  const errors = await setUp(page);
  await servePhotos(page);
  await page.goto('#/driver/VER');
  const face = page.locator('section[aria-labelledby="driver-card"]').getByTestId('driver-card');
  await expect(face).toBeVisible({ timeout: 40_000 });
  await expect(face.locator('.dc-photo img')).toHaveCount(0);
  await expect(face.locator('.dc-photo .dc-silhouette')).toBeVisible();
  await face.getByRole('button', { name: /card over/ }).first().click();
  await expect(face.locator('.dc-back .dc-credit')).toContainText('silhouette');
  expect(errors).toEqual([]);
});

test('the Drivers page is a grid of cards that can be sorted and filtered by team, each with a profile link and a favourite star', async ({ page }) => {
  const errors = await setUp(page);
  await servePhotos(page);
  await page.goto('#/drivers');
  const cards = page.getByTestId('driver-card');
  await expect(cards.first()).toBeVisible({ timeout: 40_000 });
  expect(await cards.count()).toBeGreaterThanOrEqual(20);
  // By standing the leader is first; by team, only that team's two cars remain.
  await expect(cards.first().locator('.dc-front .dc-meta')).toContainText('P1 ·');
  await page.getByLabel('Show team').selectOption('Mercedes');
  await expect(cards).toHaveCount(2);
  await page.getByLabel('Show team').selectOption('all');
  await page.getByLabel('Sort cards by').selectOption({ label: 'Qualifying (highest first)' });
  const first = await cards.first().locator('.dc-front .dc-cell .dc-r').nth(1).textContent();
  expect(Number(first)).toBe(99);
  await page.getByLabel('Sort cards by').selectOption('standing');
  // Under the first card: a link to the driver's page, and the star that makes them the favourite.
  const item = page.locator('.dc-item').first();
  const link = item.getByRole('link', { name: /^Open .+ profile/ });
  await expect(link).toHaveAttribute('href', /#\/driver\/[A-Z]{3}$/);
  const star = item.getByRole('button', { name: /your favourite$/ });
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await star.click();
  await expect(item.getByRole('button', { name: /as favourite$/ })).toHaveAttribute('aria-pressed', 'true');
  const code = (await link.getAttribute('href'))!.split('/').pop();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pitwall:settings') ?? '{}').favoriteDriver)).toBe(code);
  // The link opens that driver's page, which has the same card.
  await link.click();
  await expect(page.locator('section[aria-labelledby="driver-card"]').getByTestId('driver-card')).toBeVisible({ timeout: 40_000 });
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test('the cards can be shown as they were after an earlier round', async ({ page }) => {
  const errors = await setUp(page);
  await servePhotos(page);
  await page.goto('#/drivers');
  const cards = page.getByTestId('driver-card');
  await expect(cards.first()).toBeVisible({ timeout: 40_000 });
  const picker = page.getByLabel('Show cards after round');
  const latest = await picker.inputValue();
  expect(Number(latest)).toBeGreaterThan(1);
  await expect(page.locator('.dc-toolbar')).toContainText(`After round ${latest}.`);
  await picker.selectOption('1');
  await expect(page.locator('.dc-toolbar')).toContainText('After round 1.');
  // After one race nobody has three starts yet, so every card is still being built.
  await expect(cards.first()).toBeVisible();
  await expect(page.locator('.dc-building-note').first()).toContainText('1 / 3');
  await picker.selectOption(latest);
  await expect(page.locator('.dc-front .dc-meta').first()).toContainText('P1 ·');
  await expect(page.locator('.dc-toolbar')).toContainText(`After round ${latest}.`);
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test('the driver page header and card use our licensed photo, never a formula1.com headshot', async ({ page }) => {
  const errors = await setUp(page);
  await servePhotos(page);
  await page.goto('#/driver/HAM');
  await expect(page.locator('.profile-head img')).toHaveAttribute('src', /data\/photos\//, { timeout: 40_000 });
  // Nothing in the header or the card section points at formula1.com. (Team radio cards further down still use OpenF1's headshots.)
  const srcs = await page.locator('.profile-head img, section[aria-labelledby="driver-card"] img').evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src));
  expect(srcs.length).toBeGreaterThan(0);
  expect(srcs.filter((u) => /formula1\.com/.test(u))).toEqual([]);
  expect(errors).toEqual([]);
});

test('the Calendar opens with the race-week board and a season timeline, and keeps the table as a tab', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/calendar');
  const last = page.getByRole('region', { name: 'Last race' });
  const next = page.getByRole('region', { name: 'Next race' });
  await expect(next).toContainText('Qatar Grand Prix', { timeout: 40_000 });
  // The test clock is just after the Las Vegas race: it is the last race, with a podium of three.
  await expect(last).toContainText('Las Vegas');
  await expect(last.locator('.cb-pod li')).toHaveCount(3, { timeout: 40_000 });
  // The next weekend has a countdown, its sessions (the race last) and an add to calendar button.
  await expect(next.getByRole('timer')).toBeVisible();
  await expect(next.locator('.cb-sess li').last()).toContainText('Race');
  await expect(next.getByRole('button', { name: /Add this weekend to calendar/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'The race after' })).toContainText('Abu Dhabi');
  // One strip block and one timeline row per round, with the next race marked and a today line before it.
  const rounds = await page.locator('.cb-strip li').count();
  expect(rounds).toBeGreaterThan(20);
  await expect(page.locator('.tl-item')).toHaveCount(rounds);
  await expect(page.locator('.tl-item.next')).toContainText('Qatar');
  await expect(page.locator('.tl-today')).toHaveCount(1);
  await expect(page.locator('.cb-strip a.now')).toHaveAttribute('title', /Qatar/);
  // The strip block of a finished race names its winner.
  await expect(page.locator('.cb-strip a[title^="Round 21"]')).toHaveAttribute('title', /won by/, { timeout: 40_000 });
  await noSidewaysScroll(page);
  // The table is still there as the second tab.
  await page.getByRole('tab', { name: 'Table' }).click();
  await expect(page.locator('table.cal-tbl tbody tr')).toHaveCount(rounds);
  await expect(page.locator('.tl')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Table' })).toHaveAttribute('aria-selected', 'true');
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test('in spoiler-free mode the Calendar board and timeline do not give away the last race', async ({ page }) => {
  const errors = await setUp(page, AFTER_RACE, { spoilerFree: true });
  await page.goto('#/calendar');
  const last = page.getByRole('region', { name: 'Last race' });
  await expect(last).toContainText('Las Vegas', { timeout: 40_000 });
  await expect(last).toContainText('hidden');
  await expect(last.locator('.cb-pod')).toHaveCount(0);
  // The strip block and the timeline row of the hidden race show no winner.
  await expect(page.locator('.cb-strip a[title^="Round 21"]')).not.toHaveAttribute('title', /won by/);
  await expect(page.locator('.tl-item', { hasText: 'Las Vegas' })).toContainText('Hidden');
  // Earlier races are still shown.
  await expect(page.locator('.cb-strip a[title^="Round 20"]')).toHaveAttribute('title', /won by/);
  expect(errors).toEqual([]);
});

test('spoiler-free mode covers the driver cards and lists only the names, with their links and stars', async ({ page }) => {
  const errors = await setUp(page, AFTER_RACE, { spoilerFree: true });
  await page.goto('#/drivers');
  await expect(page.getByText('The driver cards')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('driver-card')).toHaveCount(0);
  const names = page.getByRole('list', { name: 'Drivers' });
  await expect(names.getByRole('link', { name: /^Open Verstappen profile/ })).toBeVisible();
  // No results leak through the names: no points, positions or ratings.
  await expect(names).not.toContainText(/pts|OVR|P\d/);
  expect(errors).toEqual([]);
});

test('the Drivers page can compare two drivers side by side', async ({ page }) => {
  const errors = await setUp(page);
  await servePhotos(page);
  await page.goto('#/drivers');
  await page.getByRole('tab', { name: 'Compare' }).click();
  const cards = page.getByTestId('driver-card');
  await expect(cards).toHaveCount(2, { timeout: 40_000 });
  const table = page.getByRole('table', { name: /compared with/ });
  await expect(table.locator('tbody tr')).toHaveCount(7);
  await expect(table.locator('tbody th')).toHaveText(['Overall rating', 'Points / race', 'Qualifying', 'Race finish', 'Points finishes', 'Finish rate', 'Team-mate duel']);
  // Every line with two ratings marks exactly one driver as ahead (gold), unless the ratings are level.
  const rows = table.locator('tbody tr');
  for (let i = 0; i < 7; i++) {
    const a = Number(await rows.nth(i).locator('td').first().locator('b').textContent());
    const b = Number(await rows.nth(i).locator('td').last().locator('b').textContent());
    expect(await rows.nth(i).locator('td[data-better="true"]').count()).toBe(a === b ? 0 : 1);
    if (a !== b) expect(await rows.nth(i).locator(a > b ? 'td.l' : 'td.r').getAttribute('data-better')).toBe('true');
  }
  // Choosing another driver swaps the card and the table heading.
  await page.getByLabel('Second driver').selectOption({ label: 'Lewis Hamilton' });
  await expect(cards.last().locator('.dc-front .dc-name b')).toHaveText('Hamilton');
  await expect(table.locator('thead th').last()).toHaveText('Hamilton');
  await expect(cards.last().locator('.dc-photo img')).toBeVisible();
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test('the back of a card draws the position chart with its axis labels clear of the line', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/driver/HAM');
  const face = page.locator('section[aria-labelledby="driver-card"]').getByTestId('driver-card');
  await expect(face).toBeVisible({ timeout: 40_000 });
  await face.getByRole('button', { name: /card over/ }).first().click();
  const chart = face.locator('.dc-back svg.dc-trend');
  await expect(chart).toBeVisible();
  // The lines start to the right of the axis labels, so a label never sits on the data.
  const labelRight = await chart.locator('text').first().evaluate((t) => (t as SVGTextElement).getBBox().x + (t as SVGTextElement).getBBox().width);
  const firstX = await chart.locator('path').nth(0).evaluate((p) => (p as SVGPathElement).getBBox().x);
  expect(labelRight).toBeLessThan(firstX);
  expect(errors).toEqual([]);
});

test.describe('Calendar month view', () => {
  test.use({ timezoneId: 'UTC', locale: 'en-GB' });
  test('the Month tab shows a session grid and the picked day, and the filters narrow it', async ({ page }) => {
    const errors = await setUp(page);
    await page.goto('#/calendar');
    await page.getByRole('tab', { name: 'Month' }).click({ timeout: 40_000 });
    // The test clock is Sunday 22 November, Las Vegas race day: the month opens on today.
    const day = page.getByRole('region', { name: 'Picked day' });
    await expect(day).toContainText('Sunday, 22 November 2026');
    await expect(day).toContainText('Today');
    await expect(day.locator('.cm-ev')).toContainText('Las Vegas Grand Prix');
    await expect(day.locator('.cm-sess li')).toContainText(['Race']);
    await expect(day).toContainText('Won by', { timeout: 40_000 });
    await expect(page.locator('.cm-cell[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('.cm-cell.today')).toHaveCount(1);
    // Practice Friday has practice dots and no race marker.
    const fri = page.locator('.cm-cell').filter({ has: page.locator('b', { hasText: /^20$/ }) });
    await expect(fri.locator('.k-practice')).toHaveCount(1);
    await expect(fri.locator('.k-race')).toHaveCount(0);
    // The Race filter leaves race days only, and a day without one points to the next.
    await page.getByRole('button', { name: /^Race\s*\d+$/ }).click();
    await expect(page.locator('.cm-grid .k-practice')).toHaveCount(0);
    await fri.click();
    await expect(day).toContainText('No sessions');
    await day.getByRole('button', { name: /Next up:.*Las Vegas/ }).click();
    await expect(day).toContainText('Sunday, 22 November 2026');
    // The month arrows turn the grid over, and Go to today comes back.
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(page.locator('.cm-mnav b')).toHaveText(/December 2026/i);
    await page.getByRole('button', { name: 'Go to today' }).click();
    await expect(page.locator('.cm-mnav b')).toHaveText(/November 2026/i);
    await noSidewaysScroll(page);
    expect(errors).toEqual([]);
  });
  test('the Week and Upcoming views list the sessions, and picking one opens its day', async ({ page }) => {
    const errors = await setUp(page);
    await page.goto('#/calendar');
    await page.getByRole('tab', { name: 'Month' }).click({ timeout: 40_000 });
    const day = page.getByRole('region', { name: 'Picked day' });
    await expect(day).toContainText('Sunday, 22 November 2026');
    // Week: Monday to Sunday of the picked day's week, the race day marked.
    await page.getByRole('tab', { name: 'Week' }).click();
    await expect(page.locator('.cm-wday')).toHaveCount(7);
    await expect(page.locator('.cm-wday').first()).toContainText('Mon');
    await expect(page.locator('.cm-wday.race')).toContainText('Race');
    await page.getByRole('button', { name: 'Next week' }).click();
    await expect(page.locator('.cm-wday.race')).toContainText('Race');
    await expect(day).toContainText('Sunday, 29 November 2026');
    // Upcoming: sessions still to come, grouped by weekend, the next race first.
    await page.getByRole('tab', { name: 'Upcoming' }).click();
    await expect(page.locator('.cm-up-g').first()).toContainText('Qatar');
    await expect(page.locator('.cm-up-g')).toHaveCount(2);
    await page.locator('.cm-up-g').last().locator('.cm-up-row', { hasText: 'Race' }).click();
    await expect(day).toContainText('Abu Dhabi Grand Prix');
    await noSidewaysScroll(page);
    expect(errors).toEqual([]);
  });
});

test.describe('Calendar overnight sessions', () => {
  // In Tokyo the Qatar race (16:00 UTC) starts at 1 am.
  test.use({ timezoneId: 'Asia/Tokyo', locale: 'en-GB' });
  test('sessions between midnight and 6 am carry an Overnight tag', async ({ page }) => {
    const errors = await setUp(page);
    await page.goto('#/calendar');
    const next = page.getByRole('region', { name: 'Next race' });
    await expect(next).toContainText('Qatar Grand Prix', { timeout: 40_000 });
    await expect(next.locator('.cb-sess li.race')).toContainText('Overnight');
    await page.getByRole('tab', { name: 'Month' }).click();
    await page.getByRole('tab', { name: 'Upcoming' }).click();
    await expect(page.locator('.cm-up-g').first().locator('.cm-up-row', { hasText: 'Race' })).toContainText('Overnight');
    expect(errors).toEqual([]);
  });
});

test("the Calendar shows your driver's result beside the winner", async ({ page }) => {
  const errors = await setUp(page, AFTER_RACE, { favoriteDriver: 'HAM', favoriteName: 'Lewis Hamilton' });
  await page.goto('#/calendar');
  const last = page.getByRole('region', { name: 'Last race' });
  await expect(last.locator('.cb-pod li')).toHaveCount(3, { timeout: 40_000 });
  // Off the podium in Las Vegas, so a row of its own under the podium.
  await expect(last.locator('.my-fin-row')).toContainText(/Your driver\s*(P\d+|DNF|DNS|DSQ)\s*Lewis Hamilton/);
  // Each finished race in the timeline carries a short tag.
  await expect(page.locator('.tl-item.past .my-fin').first()).toContainText('HAM');
  expect(await page.locator('.tl-item.up .my-fin').count()).toBe(0);
  expect(errors).toEqual([]);
});

test("in spoiler-free mode the Calendar does not show your driver's result for the hidden race", async ({ page }) => {
  const errors = await setUp(page, AFTER_RACE, { favoriteDriver: 'HAM', favoriteName: 'Lewis Hamilton', spoilerFree: true });
  await page.goto('#/calendar');
  const last = page.getByRole('region', { name: 'Last race' });
  await expect(last).toContainText('hidden in spoiler-free mode', { timeout: 40_000 });
  await expect(page.locator('.tl-item').nth(10).locator('.my-fin')).toHaveCount(1, { timeout: 40_000 });
  await expect(last.locator('.my-fin-row')).toHaveCount(0);
  await expect(page.locator('.tl-item').filter({ hasText: 'Las Vegas' }).locator('.my-fin')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('after the final race the Calendar board sums up the season', async ({ page }) => {
  // A week after the Abu Dhabi finale. The recording has no Qatar or Abu Dhabi results, so the summary covers the races it has.
  const errors = await setUp(page, new Date('2026-12-13T08:00:00Z'));
  await page.goto('#/calendar');
  const wrap = page.getByRole('region', { name: 'Season over' });
  await expect(wrap).toContainText('Season complete', { timeout: 40_000 });
  await expect(wrap.locator('.cb-wbars li').first()).toBeVisible({ timeout: 40_000 });
  await expect(wrap).toContainText('different winners');
  await expect(wrap.locator('.cb-wlist li').first()).toContainText(/\d$/);
  // Sprints come with the season's results: the 2026 recording has sprint weekends before Las Vegas.
  await expect(wrap.locator('.cb-wh', { hasText: 'Sprint wins' })).toContainText(/\d+ sprints?/);
  await expect(wrap.getByRole('link', { name: /Season review/ })).toBeVisible();
  await expect(page.locator('.cb-cap')).not.toContainText('next race');
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});

test('in spoiler-free mode the season summary waits until the final race is revealed', async ({ page }) => {
  const errors = await setUp(page, new Date('2026-12-07T08:00:00Z'), { spoilerFree: true });
  await page.goto('#/calendar');
  const wrap = page.getByRole('region', { name: 'Season over' });
  await expect(wrap).toContainText('hidden in spoiler-free mode', { timeout: 40_000 });
  await expect(wrap.locator('.cb-wbars')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a session reminder can be set from the Calendar and goes off 15 minutes before', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/calendar');
  const next = page.getByRole('region', { name: 'Next race' });
  await expect(next).toContainText('Qatar Grand Prix', { timeout: 40_000 });
  const bell = next.getByRole('button', { name: /Remind me 15 minutes before Qualifying, Qatar Grand Prix/ });
  await bell.click();
  await expect(next.getByRole('button', { name: /Reminder on for Qualifying, Qatar Grand Prix/ })).toHaveAttribute('aria-pressed', 'true');
  // Kept on this device.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pitwall:reminders') ?? '[]'));
  expect(saved).toHaveLength(1);
  // The same reminder shows as on in the Month tab's Upcoming list.
  await page.getByRole('tab', { name: 'Month' }).click();
  await page.getByRole('tab', { name: 'Upcoming' }).click();
  await expect(page.locator('.cm-up-li').filter({ hasText: 'Qualifying' }).first().locator('.remind')).toHaveAttribute('aria-pressed', 'true');
  // 15 minutes before qualifying the reminder goes off inside the app, and is then cleared.
  const at = saved[0].at as number;
  await page.clock.setSystemTime(new Date(at - 15 * 60_000 + 1000));
  await page.clock.runFor(25_000);
  await expect(page.locator('.toasts')).toContainText(/Qualifying starts in 1[45] minutes/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pitwall:reminders') ?? '[]'))).toEqual([]);
  expect(errors).toEqual([]);
});

test("when Open-Meteo refuses, the weekend forecast comes from Pit Wall's saved copy", async ({ page }) => {
  const errors = await setUp(page);
  // Open-Meteo's daily cap for the network address, as a shared mobile or office connection can reach.
  const asked: string[] = [];
  await page.route(/api\.open-meteo\.com\/v1\/forecast\?.*daily=/, (r) => {
    asked.push(r.request().url());
    return r.fulfill({ status: 429, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":true,"reason":"Daily API request limit exceeded. Please try again tomorrow."}' });
  });
  await page.route('**/data/weather/2026-22.json', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        url: asked[0],
        fetchedAt: '2026-11-22T06:00:00Z',
        data: { utc_offset_seconds: 10800, daily: { time: ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30'], weather_code: [0, 1, 2, 3, 0], temperature_2m_max: [29, 28, 27, 28, 29], temperature_2m_min: [20, 20, 19, 20, 21], precipitation_sum: [0, 0, 0, 0, 0], wind_speed_10m_max: [12, 14, 16, 12, 10], precipitation_probability_max: [0, 0, 5, 0, 0] } },
      }),
    }),
  );
  await page.goto('#/');
  const card = page.locator('section[aria-labelledby="weather"]');
  await expect(card).toContainText('this is the forecast Pit Wall saved', { timeout: 40_000 });
  await expect(card.locator('.wx-day').first()).toContainText('°');
  expect(asked.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('one button sets reminders for every session of the next weekend, and turns them off again', async ({ page }) => {
  const errors = await setUp(page);
  await page.goto('#/calendar');
  const next = page.getByRole('region', { name: 'Next race' });
  const all = next.getByRole('button', { name: /Remind me for the whole weekend/ });
  await all.click({ timeout: 40_000 });
  const count = await next.locator('.cb-sess .remind').count();
  await expect(next.locator('.cb-sess .remind[aria-pressed="true"]')).toHaveCount(count);
  await expect(next.getByRole('button', { name: `Reminders on for all ${count} sessions` })).toHaveAttribute('aria-pressed', 'true');
  // The Dashboard shows the same reminders.
  await page.goto('#/');
  await expect(page.locator('.sessions .remind[aria-pressed="true"]')).toHaveCount(count, { timeout: 40_000 });
  await page.getByRole('button', { name: `Reminders on for all ${count} sessions` }).click();
  await expect(page.locator('.sessions .remind[aria-pressed="true"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a forecast copy made from MET Norway is credited to it, with rain in mm instead of a chance', async ({ page }) => {
  const errors = await setUp(page);
  const asked: string[] = [];
  await page.route(/api\.open-meteo\.com\/v1\/forecast\?.*daily=/, (r) => {
    asked.push(r.request().url());
    return r.fulfill({ status: 429, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":true}' });
  });
  // The copy the job made from MET Norway on 27 Nov 2026, matched to the request this page makes.
  const copy = JSON.parse(readFileSync('tests/fixtures/weather-copy-metno-2026-22.json', 'utf8'));
  await page.route('**/data/weather/2026-22.json', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...copy, url: asked[0] }) }));
  await page.goto('#/');
  const card = page.locator('section[aria-labelledby="weather"]');
  await expect(card).toContainText('from MET Norway', { timeout: 40_000 });
  await expect(card.getByRole('link', { name: 'MET Norway' })).toHaveAttribute('href', /met\.no/);
  await expect(card.getByRole('link', { name: 'CC BY 4.0' })).toBeVisible();
  await expect(card.locator('.wx-day').filter({ hasText: 'Race' })).toContainText(/Rain \d+\.\d mm/);
  await expect(card).not.toContainText('Rain chance');
  expect(errors).toEqual([]);
});

test('Live Timing: the FIA feed starts with the newest messages, with Show more and Show less', async ({ page }, info) => {
  const errors = await setUp(page);
  await page.goto('#/live');
  await expect(page.locator('table.timing tbody tr')).toHaveCount(22, { timeout: 30_000 });
  const card = page.locator('section[aria-labelledby="fia"]');
  const first = info.project.name === 'phone' ? 5 : 8;
  const msgs = card.locator('[role="log"] .msg');
  await expect(msgs).toHaveCount(first, { timeout: 20_000 });
  const total = Number((await card.locator('.more-row .muted').textContent())!.match(/of (\d+)/)![1]);
  expect(total).toBeGreaterThan(first);
  await card.getByRole('button', { name: /^Show \d+ more$/ }).click();
  await expect(msgs).toHaveCount(Math.min(total, first + 10));
  await expect(card.locator('.more-row .muted')).toHaveText(`Showing ${Math.min(total, first + 10)} of ${total}`);
  await card.getByRole('button', { name: 'Show less' }).click();
  await expect(msgs).toHaveCount(first);
  await expect(card.getByRole('button', { name: 'Show less' })).toHaveCount(0);
  // Another category starts from the newest few again.
  await card.getByRole('button', { name: /^Show \d+ more$/ }).click();
  await card.getByRole('tab', { name: /^Flags/ }).click();
  expect(await msgs.count()).toBeLessThanOrEqual(first);
  expect(errors).toEqual([]);
});

test("F1's feed: pit lane times show live, and a car leaving the garage shows Out lap", async ({ page }) => {
  const snapshot = JSON.parse(readFileSync('tests/fixtures/feed-snapshot.json', 'utf8'));
  // A car that is out on track (no IN PIT or other status pill in its Last lap cell).
  const n = Object.keys(snapshot.TimingData.Lines).find((k) => {
    const l = snapshot.TimingData.Lines[k];
    return !l.InPit && !l.PitOut && !l.Retired && !l.Stopped;
  })!;
  const code = snapshot.DriverList[n].Tla as string;
  const errors = await setUp(page, new Date('2026-11-22T04:30:00Z'));
  let send: (topic: string, data: object) => void = () => {};
  await page.routeWebSocket(/livetiming\.formula1\.com/, (ws) => {
    send = (topic, data) => ws.send(JSON.stringify({ type: 1, target: 'feed', arguments: [topic, data] }) + '\x1e');
    ws.onMessage((msg) => {
      for (const part of String(msg).split('\x1e')) {
        if (!part) continue;
        const m = JSON.parse(part);
        if (m.protocol) ws.send('{}\x1e');
        if (m.target === 'Subscribe') ws.send(JSON.stringify({ type: 3, invocationId: '0', result: snapshot }) + '\x1e');
      }
    });
  });
  await page.goto('#/live');
  await expect.poll(() => page.locator('table.timing tbody tr').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(20);
  const pits = page.locator('section[aria-labelledby="pitstops"]');
  await expect(pits).toContainText('No pit stops yet');
  send('PitLaneTimeCollection', { PitTimes: { [n]: { RacingNumber: n, Duration: '21.9', Lap: '20' } } });
  await expect(pits.locator('tbody tr').first()).toContainText(code);
  await expect(pits.locator('tbody tr').first()).toContainText('21.9 s');
  await expect(pits).toContainText('Quickest pit lane 21.9 s');
  // The feed moves on to the same driver's next stop; both stay in the table.
  send('PitLaneTimeCollection', { PitTimes: { [n]: { RacingNumber: n, Duration: '23.4', Lap: '38' } } });
  await expect(pits.locator('tbody tr')).toHaveCount(2);
  send('TimingData', { Lines: { [n]: { LastLapTime: { Value: '19:56.697', Status: 0, OverallFastest: false, PersonalFastest: false } } } });
  const row = page.locator('table.timing tbody tr', { has: page.locator('a.code', { hasText: code }) });
  await expect(row).toContainText('Out lap');
  await expect(row).not.toContainText('19:56');
  expect(errors).toEqual([]);
});
