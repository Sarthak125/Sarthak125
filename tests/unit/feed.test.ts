import { describe, expect, it } from 'vitest';
import snapshot from '../fixtures/feed-snapshot.json';
import { addPits, mergeF1, parseLapTime, realLap, type FeedSnapshot } from '../../src/api/f1live';
import { feedDrivers, feedMessages, feedPits, feedRows, feedSession, feedWeather } from '../../src/lib/f1adapter';

const snap = (state: object): FeedSnapshot => ({ status: 'live', delay: 0, state: state as FeedSnapshot['state'], laps: [], pits: [], updatedAt: Date.parse('2026-11-22T04:22:46Z'), receivedAt: null, retryAt: null });

describe('mergeF1', () => {
  it('merges nested objects without losing other keys', () => {
    expect(mergeF1({ a: { b: 1, c: 2 } }, { a: { b: 3 } })).toEqual({ a: { b: 3, c: 2 } });
  });
  it('applies index-keyed updates to arrays in place, keeping the other fields', () => {
    const sectors = [{ Value: '28.1', Segments: [2049] }, { Value: '', Segments: [2048, 0] }, { Value: '' }];
    expect(mergeF1(sectors, { 1: { Value: '32.5' } })).toEqual([{ Value: '28.1', Segments: [2049] }, { Value: '32.5', Segments: [2048, 0] }, { Value: '' }]);
  });
  it('replaces a list sent in full', () => {
    expect(mergeF1([1, 2, 3], [4])).toEqual([4]);
  });
  it('removes deleted keys', () => {
    expect(mergeF1({ a: 1, b: 2 }, { _deleted: ['a'] })).toEqual({ b: 2 });
  });
});

describe('parseLapTime', () => {
  it('reads minutes and seconds', () => expect(parseLapTime('1:36.214')).toBeCloseTo(96.214));
  it('reads seconds only', () => expect(parseLapTime('28.142')).toBeCloseTo(28.142));
  it('returns null for empty or odd values', () => {
    expect(parseLapTime('')).toBeNull();
    expect(parseLapTime('LAP 12')).toBeNull();
  });
});

describe('F1 feed adapter (Las Vegas race snapshot)', () => {
  const s = snap(snapshot);
  it('finds the session as OpenF1 would name it', () => {
    const sess = feedSession(s)!;
    expect(sess.session_key).toBe(11420);
    expect(sess.session_name).toBe('Race');
    expect(sess.date_start).toBe('2026-11-22T04:00:00.000Z');
    expect(sess.circuit_key).toBe(152);
  });
  it('builds a full timing tower in position order', () => {
    const rows = feedRows(s, true);
    expect(rows.length).toBe(feedDrivers(s).length);
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.map((r) => r.position)).toEqual([...rows.map((r) => r.position)].sort((a, b) => (a ?? 99) - (b ?? 99)));
    expect(rows[0].gap).toBe(0);
    expect(rows.slice(1, 5).every((r) => typeof r.gap === 'number' && r.gap > 0)).toBe(true);
    expect(rows.every((r) => r.driver.name_acronym.length === 3)).toBe(true);
  });
  it('maps race control messages and weather', () => {
    const msgs = feedMessages(s);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.every((m) => /Z$|[+-]\d\d:\d\d$/.test(m.date))).toBe(true);
    const w = feedWeather(s)!;
    expect(w.air_temperature).toBeGreaterThan(0);
  });
});

describe('out laps', () => {
  it('treats anything longer than 5 minutes as no lap time', () => {
    expect(realLap(97.2)).toBe(97.2);
    expect(realLap(parseLapTime('19:56.697'))).toBeNull();
    expect(realLap(null)).toBeNull();
  });
  it('shows a car leaving the garage as an out lap, not a 19-minute lap', () => {
    const state = JSON.parse(JSON.stringify(snapshot));
    const n = Object.keys(state.TimingData.Lines)[0];
    state.TimingData.Lines[n].LastLapTime = { Value: '19:56.697', Status: 0, OverallFastest: false, PersonalFastest: false };
    const row = feedRows(snap(state), true).find((r) => String(r.driver.driver_number) === n)!;
    expect(row.lastLap?.lap_duration).toBeNull();
    expect(row.lastLap?.is_pit_out_lap).toBe(true);
    expect(row.lastLapTone).toBe('none');
  });
});

describe('pit lane times from the feed', () => {
  const state = (times: object) => ({ PitLaneTimeCollection: { PitTimes: times } });
  it('records each new stop, keeping earlier ones as the feed moves on to the next', () => {
    let pits = addPits([], state({ 1: { RacingNumber: '1', Duration: '22.4', Lap: '14' } }), 1000);
    expect(pits).toEqual([{ driver: 1, lap: 14, lane: 22.4, at: 1000 }]);
    // Same stop again: nothing new.
    expect(addPits(pits, state({ 1: { RacingNumber: '1', Duration: '22.4', Lap: '14' } }), 2000)).toBe(pits);
    // The driver's next stop replaces the first in the feed, but both are kept here.
    pits = addPits(pits, state({ 1: { RacingNumber: '1', Duration: '23.1', Lap: '33' }, 44: { RacingNumber: '44', Duration: '21.9', Lap: '20' } }), 3000);
    expect(pits.map((p) => `${p.driver}/${p.lap}/${p.lane}`)).toEqual(['1/14/22.4', '1/33/23.1', '44/20/21.9']);
  });
  it('takes a corrected time for the same stop and ignores empty entries', () => {
    const pits = addPits([{ driver: 1, lap: 14, lane: 22.4, at: 1 }], state({ 1: { RacingNumber: '1', Duration: '22.6', Lap: '14' }, 5: { RacingNumber: '5', Duration: '', Lap: '' } }), 2);
    expect(pits).toEqual([{ driver: 1, lap: 14, lane: 22.6, at: 1 }]);
  });
  it('turns recorded stops into pit stop rows with the pit lane time only', () => {
    const s = { ...snap({}), pits: [{ driver: 44, lap: 20, lane: 21.9, at: Date.parse('2026-11-22T04:30:00Z') }] };
    expect(feedPits(s)).toEqual([{ date: '2026-11-22T04:30:00.000Z', driver_number: 44, lap_number: 20, pit_duration: 21.9, lane_duration: 21.9, stop_duration: null }]);
  });
});
