import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hexToRgb, hsvToRgb, kelvinToRgb, rgbToHex, rgbToHsv } from '../src/util/color.js';
import { cronMatches, parseCron } from '../src/util/cron.js';
import { xmlElements, xmlText } from '../src/util/xml.js';
import { clamp, single, withTimeout } from '../src/util/async.js';

describe('colour conversion', () => {
  it('round-trips the primaries through HSV', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000', '#ff8c1a']) {
      const rgb = hexToRgb(hex);
      assert.ok(rgb, hex);
      const back = rgbToHex(hsvToRgb(rgbToHsv(rgb)));
      // Integer hue/sat means a tiny amount of drift is expected.
      const channels = (value: string) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
      const [r1, g1, b1] = channels(hex);
      const [r2, g2, b2] = channels(back);
      assert.ok(Math.abs(r1! - r2!) <= 3 && Math.abs(g1! - g2!) <= 3 && Math.abs(b1! - b2!) <= 3, `${hex} -> ${back}`);
    }
  });

  it('maps known HSV values to RGB', () => {
    assert.deepEqual(hsvToRgb({ h: 0, s: 100, v: 100 }), { r: 255, g: 0, b: 0 });
    assert.deepEqual(hsvToRgb({ h: 120, s: 100, v: 100 }), { r: 0, g: 255, b: 0 });
    assert.deepEqual(hsvToRgb({ h: 240, s: 100, v: 100 }), { r: 0, g: 0, b: 255 });
    assert.deepEqual(hsvToRgb({ h: 0, s: 0, v: 100 }), { r: 255, g: 255, b: 255 });
  });

  it('wraps hue and clamps out-of-range input', () => {
    assert.deepEqual(hsvToRgb({ h: 360, s: 100, v: 100 }), hsvToRgb({ h: 0, s: 100, v: 100 }));
    assert.deepEqual(hsvToRgb({ h: -120, s: 100, v: 100 }), hsvToRgb({ h: 240, s: 100, v: 100 }));
    assert.deepEqual(hsvToRgb({ h: 0, s: 500, v: 500 }), { r: 255, g: 0, b: 0 });
  });

  it('accepts three and six digit hex, with or without the hash', () => {
    assert.deepEqual(hexToRgb('#f00'), { r: 255, g: 0, b: 0 });
    assert.deepEqual(hexToRgb('ff0000'), { r: 255, g: 0, b: 0 });
    assert.deepEqual(hexToRgb('  #FF0000 '), { r: 255, g: 0, b: 0 });
    assert.equal(hexToRgb('#ff00'), null);
    assert.equal(hexToRgb('red'), null);
  });

  it('produces warm light below 4000K and cool above', () => {
    const warm = kelvinToRgb(2200);
    const cool = kelvinToRgb(6500);
    assert.ok(warm.r > warm.b, 'warm white is red-dominant');
    assert.ok(cool.b >= warm.b, 'cooler temperatures carry more blue');
    assert.deepEqual(kelvinToRgb(0), kelvinToRgb(1000), 'clamped at the bottom of the range');
  });
});

describe('cron matching', () => {
  const at = (iso: string) => new Date(iso);

  it('matches a specific weekday time', () => {
    const fields = parseCron('30 7 * * 1-5');
    assert.ok(cronMatches(fields, at('2026-10-05T07:30:00'))); // Monday
    assert.ok(!cronMatches(fields, at('2026-10-05T07:31:00')));
    assert.ok(!cronMatches(fields, at('2026-10-04T07:30:00'))); // Sunday
  });

  it('supports steps, lists and ranges', () => {
    assert.ok(cronMatches(parseCron('*/15 * * * *'), at('2026-10-05T10:45:00')));
    assert.ok(!cronMatches(parseCron('*/15 * * * *'), at('2026-10-05T10:46:00')));
    assert.ok(cronMatches(parseCron('0 9,17 * * *'), at('2026-10-05T17:00:00')));
    assert.ok(cronMatches(parseCron('0 8-10 * * *'), at('2026-10-05T09:00:00')));
    assert.ok(!cronMatches(parseCron('0 8-10 * * *'), at('2026-10-05T11:00:00')));
  });

  it('understands day and month names, and both Sunday spellings', () => {
    assert.ok(cronMatches(parseCron('0 0 * * sun'), at('2026-10-04T00:00:00')));
    assert.ok(cronMatches(parseCron('0 0 * * 7'), at('2026-10-04T00:00:00')));
    assert.ok(cronMatches(parseCron('0 0 1 oct *'), at('2026-10-01T00:00:00')));
  });

  it('expands the @daily style aliases', () => {
    assert.ok(cronMatches(parseCron('@daily'), at('2026-10-05T00:00:00')));
    assert.ok(cronMatches(parseCron('@hourly'), at('2026-10-05T13:00:00')));
    assert.ok(!cronMatches(parseCron('@daily'), at('2026-10-05T00:01:00')));
  });

  it('ORs the two day fields when both are restricted, as cron does', () => {
    // The 13th or any Friday.
    const fields = parseCron('0 0 13 * 5');
    assert.ok(cronMatches(fields, at('2026-10-13T00:00:00')), 'the 13th, a Tuesday');
    assert.ok(cronMatches(fields, at('2026-10-09T00:00:00')), 'a Friday');
    assert.ok(!cronMatches(fields, at('2026-10-14T00:00:00')));
  });

  it('rejects malformed expressions', () => {
    assert.throws(() => parseCron('* * * *'), /5 fields/);
    assert.throws(() => parseCron('99 * * * *'), /out of range/);
    assert.throws(() => parseCron('* * * * nope'), /bad cron token/);
    assert.throws(() => parseCron('*/0 * * * *'), /bad cron step/);
  });
});

describe('xml extraction', () => {
  const sample = `<?xml version="1.0"?>
<active-app>
  <input id="tvinput.hdmi2" type="tvin">HDMI2</input>
</active-app>`;

  it('reads leaf text by tag name', () => {
    assert.equal(xmlText(sample, 'input'), 'HDMI2');
    assert.equal(xmlText(sample, 'missing'), undefined);
  });

  it('reads attributes and text for repeated elements', () => {
    const apps = xmlElements('<apps><app id="12">Netflix</app><app id="837">YouTube</app></apps>', 'app');
    assert.equal(apps.length, 2);
    assert.equal(apps[0]?.attrs['id'], '12');
    assert.equal(apps[0]?.text, 'Netflix');
    assert.equal(apps[1]?.text, 'YouTube');
  });

  it('handles self-closing elements', () => {
    const players = xmlElements('<player error="false" state="close"/>', 'player');
    assert.equal(players.length, 1);
    assert.equal(players[0]?.attrs['state'], 'close');
    assert.equal(players[0]?.text, '');
  });

  it('does not confuse a tag with a longer tag that ends in the same name', () => {
    // `<app>` must not match inside `<active-app>`.
    assert.equal(xmlElements('<active-app><app id="1">X</app></active-app>', 'app').length, 1);
  });

  it('decodes the entities Roku emits in channel names', () => {
    assert.equal(xmlText('<t>Tom &amp; Jerry&apos;s &quot;Show&quot;</t>', 't'), 'Tom & Jerry\'s "Show"');
  });
});

describe('async helpers', () => {
  it('clamps, treating NaN as the minimum', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-5, 0, 10), 0);
    assert.equal(clamp(50, 0, 10), 10);
    assert.equal(clamp(Number.NaN, 3, 10), 3);
  });

  it('collapses concurrent calls into one in-flight promise', async () => {
    let calls = 0;
    const fn = single(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return calls;
    });
    const [a, b, c] = await Promise.all([fn(), fn(), fn()]);
    assert.equal(calls, 1, 'only one underlying call');
    assert.deepEqual([a, b, c], [1, 1, 1]);
    await fn();
    assert.equal(calls, 2, 'a later call starts fresh');
  });

  it('times out a promise that never settles', async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 20, 'device read'), /device read timed out after 20ms/);
    assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
  });
});
