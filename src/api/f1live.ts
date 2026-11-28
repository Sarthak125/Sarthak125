/**
 * Formula 1's own live timing feed (the source OpenF1 itself is built on), read straight from the browser.
 *
 * During a live session OpenF1 is limited to paying supporters, but F1's feed still publishes timing, tyres, race
 * control, weather, lap count and team radio without an account. Live car positions and car telemetry need an
 * F1 TV subscription and are not available here. The feed is unofficial and undocumented, so everything that uses
 * it falls back to OpenF1 (or the "paused" notice) when it is unavailable.
 *
 * Protocol: ASP.NET SignalR Core over a WebSocket, JSON messages separated by the 0x1e character. After the
 * handshake we call `Subscribe` with a list of topics; the reply holds a full snapshot of each topic, then the
 * server pushes partial updates ("feed" messages) that are merged into the snapshot.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { getSettings } from '../lib/settings';

const URL = 'wss://livetiming.formula1.com/signalrcore';
const RS = '\x1e';
export const F1_TOPICS = [
  'Heartbeat', 'ExtrapolatedClock', 'TimingStats', 'TimingAppData', 'WeatherData', 'TrackStatus', 'DriverList',
  'RaceControlMessages', 'SessionInfo', 'SessionData', 'LapCount', 'TimingData', 'TeamRadio', 'LapSeries',
  'PitLaneTimeCollection',
];

/* eslint-disable @typescript-eslint/no-explicit-any */
export type F1State = Record<string, any>;

/**
 * Merges an update into the current value. F1 sends lists in full in the snapshot but updates them as objects keyed
 * by index ({"2": {...}}), so an object update applied to an array changes those items in place.
 */
export function mergeF1(target: any, delta: any): any {
  if (delta === null || typeof delta !== 'object') return delta;
  if (Array.isArray(delta)) return delta.map((d) => mergeF1(undefined, d));
  if (Array.isArray(target)) {
    const out = target.slice();
    for (const k of Object.keys(delta)) {
      if (k === '_kf' || k === '_deleted') continue;
      const i = Number(k);
      if (Number.isInteger(i)) out[i] = mergeF1(out[i], delta[k]);
    }
    return out;
  }
  const out: Record<string, any> = target && typeof target === 'object' ? { ...target } : {};
  for (const k of Object.keys(delta)) {
    if (k === '_deleted') continue;
    out[k] = mergeF1(out[k], delta[k]);
  }
  if (Array.isArray(delta._deleted)) for (const k of delta._deleted) delete out[k];
  return out;
}

const LAPS_KEY = 'pitwall:feed-laps';
const PITS_KEY = 'pitwall:feed-pits';

/**
 * Longest believable lap, in seconds. The feed's "last lap" for a car leaving the garage can be the time since its
 * previous lap (in qualifying, the whole break between parts, e.g. 19:56.697), so anything longer is an out lap.
 */
export const LONGEST_LAP = 300;
export const realLap = (t: number | null): number | null => (t != null && t > 0 && t <= LONGEST_LAP ? t : null);

/** A pit stop seen in the feed: time from pit entry to pit exit, recorded as it was announced. */
export interface RecordedPit {
  driver: number;
  lap: number;
  /** Seconds in the pit lane. */
  lane: number;
  /** When it arrived (ms since epoch). */
  at: number;
}

function loadPits(sk: number): RecordedPit[] {
  try {
    const saved = JSON.parse(localStorage.getItem(PITS_KEY) ?? 'null') as { sk: number; pits: RecordedPit[] } | null;
    return saved && saved.sk === sk && Array.isArray(saved.pits) ? saved.pits : [];
  } catch {
    return [];
  }
}

/** The stops in F1's PitLaneTimeCollection (it holds each driver's latest one), added to those already recorded. */
export function addPits(have: RecordedPit[], state: F1State, now: number): RecordedPit[] {
  const times = state.PitLaneTimeCollection?.PitTimes ?? {};
  let out = have;
  for (const k of Object.keys(times)) {
    const t = times[k];
    const driver = Number(t?.RacingNumber ?? k);
    const lap = Number(t?.Lap);
    const lane = Number(t?.Duration);
    if (!driver || !lap || !(lane > 0)) continue;
    const i = out.findIndex((p) => p.driver === driver && p.lap === lap);
    if (i >= 0) {
      if (out[i].lane !== lane) out = out.map((p, j) => (j === i ? { ...p, lane } : p));
      continue;
    }
    out = [...out, { driver, lap, lane, at: now }];
  }
  return out;
}

/** Laps recorded earlier on this device for a session (only the latest session is kept). */
function loadLaps(sk: number): RecordedLap[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LAPS_KEY) ?? 'null') as { sk: number; laps: RecordedLap[] } | null;
    return saved && saved.sk === sk && Array.isArray(saved.laps) ? saved.laps : [];
  } catch {
    return [];
  }
}

/** A lap completed while we were connected, recorded from the timing data at the moment it finished. */
export interface RecordedLap {
  driver: number;
  lap: number;
  time: number | null;
  sectors: (number | null)[];
  sectorFlags: ('overall' | 'personal' | 'slower' | 'none')[];
  segments: (number | null)[][];
  pitOut: boolean;
  endedAt: number;
  trap: number | null;
}

export type FeedStatus = 'idle' | 'connecting' | 'live' | 'error';

export interface FeedSnapshot {
  status: FeedStatus;
  /** Seconds the feed is held back to match a TV or stream (Settings), 0 when shown as received. */
  delay: number;
  state: F1State;
  laps: RecordedLap[];
  /** Pit stops seen this session (pit lane time), from F1's PitLaneTimeCollection. */
  pits: RecordedPit[];
  updatedAt: number | null;
  /** When the last timing message arrived from F1 (before any TV delay), for spotting a quiet or stalled feed. */
  receivedAt: number | null;
  /** After a dropped connection: when the next attempt is due. */
  retryAt: number | null;
}

export function parseLapTime(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(v.trim());
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
}

const flagOf = (x: any): RecordedLap['sectorFlags'][number] =>
  !x || !x.Value ? 'none' : x.OverallFastest ? 'overall' : x.PersonalFastest ? 'personal' : 'slower';

class F1LiveFeed {
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private users = 0;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private notifyQueued = false;
  private listeners = new Set<() => void>();
  private snap: FeedSnapshot = { status: 'idle', delay: 0, state: {}, laps: [], pits: [], updatedAt: null, receivedAt: null, retryAt: null };
  // TV delay: messages wait here until they are `delay` seconds old, then are applied in order.
  private pending: { at: number; apply: () => void }[] = []; // `at` = when the message arrived
  private drain: ReturnType<typeof setInterval> | undefined;
  // Per driver: the number of laps last seen and whether the lap in progress started from the pit lane.
  private lapsSeen = new Map<number, number>();
  private pitOutThisLap = new Map<number, boolean>();

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  get = () => this.snap;

  /** Starts the connection for one more user; the returned function releases it. */
  use(): () => void {
    this.users++;
    clearTimeout(this.stopTimer);
    if (!this.ws && this.snap.status !== 'connecting') this.connect();
    return () => {
      this.users--;
      // Keep the connection briefly, so moving between pages does not reconnect.
      if (this.users <= 0) this.stopTimer = setTimeout(() => this.stop(), 60_000);
    };
  }

  private set(patch: Partial<FeedSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    // Many small updates arrive each second; redraw at most twice a second.
    setTimeout(() => {
      this.notifyQueued = false;
      this.listeners.forEach((l) => l());
    }, 500);
  }

  /** Reconnects straight away instead of waiting for the next scheduled attempt. */
  retryNow = () => {
    if (this.users <= 0 || this.ws) return;
    clearTimeout(this.retry);
    this.connect();
  };

  private connect() {
    this.set({ status: 'connecting', retryAt: null });
    let ws: WebSocket;
    try {
      ws = new WebSocket(URL);
    } catch {
      this.fail();
      return;
    }
    this.ws = ws;
    let handshake = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
      // The server drops clients it has not heard from for a while.
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 6 }) + RS), 15_000);
    };
    ws.onmessage = (ev) => {
      for (const part of String(ev.data).split(RS)) {
        if (!part) continue;
        let m: any;
        try {
          m = JSON.parse(part);
        } catch {
          continue;
        }
        if (!handshake) {
          handshake = true;
          if (m.error) return this.fail();
          ws.send(JSON.stringify({ type: 1, target: 'Subscribe', arguments: [F1_TOPICS], invocationId: '0' }) + RS);
          continue;
        }
        if (m.type === 3 && m.invocationId === '0') {
          if (m.error || !m.result) return this.fail();
          this.set({ receivedAt: Date.now() });
          this.attempt = 0;
          const result = m.result;
          this.later(() => {
            this.lapsSeen.clear();
            const state: F1State = {};
            for (const k of Object.keys(result)) state[k] = result[k];
            this.track(state);
            // The snapshot has no lap history: keep the laps recorded so far for this session, from before a dropped
            // connection or, after a reload, from this device.
            const sk = Number(state.SessionInfo?.Key) || 0;
            const kept = Number(this.snap.state.SessionInfo?.Key) === sk && this.snap.laps.length ? this.snap.laps : loadLaps(sk);
            const keptPits = Number(this.snap.state.SessionInfo?.Key) === sk && this.snap.pits.length ? this.snap.pits : loadPits(sk);
            this.set({ status: 'live', state, laps: kept, pits: addPits(keptPits, state, Date.now()), updatedAt: Date.now() });
          });
        } else if (m.type === 1 && m.target === 'feed' && Array.isArray(m.arguments)) {
          const [topic, data] = m.arguments as [string, any];
          this.snap = { ...this.snap, receivedAt: Date.now() };
          this.later(() => {
            const state = { ...this.snap.state, [topic]: mergeF1(this.snap.state[topic], data) };
            const laps = topic === 'TimingData' ? this.track(state) : null;
            if (topic === 'PitLaneTimeCollection') {
              const pits = addPits(this.snap.pits, state, Date.now());
              if (pits !== this.snap.pits) {
                this.set({ state, updatedAt: Date.now(), pits });
                this.savePits();
                return;
              }
            }
            if (laps?.length) {
              const have = new Set(this.snap.laps.map((l) => `${l.driver}-${l.lap}`));
              const fresh = laps.filter((l) => !have.has(`${l.driver}-${l.lap}`));
              this.set({ state, updatedAt: Date.now(), laps: [...this.snap.laps, ...fresh] });
              this.saveLaps();
            } else {
              this.set({ state, updatedAt: Date.now() });
            }
          });
        } else if (m.type === 7) {
          ws.close();
        }
      }
    };
    ws.onerror = () => undefined;
    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.ws === ws) this.ws = null;
      if (this.users > 0) this.fail();
      else this.set({ status: 'idle' });
    };
  }

  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Keeps this session's recorded laps on the device, for reloads. At most every 5 seconds: some car finishes a lap
   * every few seconds, so waiting for a quiet moment could mean never saving.
   */
  private saveLaps() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const sk = Number(this.snap.state.SessionInfo?.Key) || 0;
      if (!sk) return;
      try {
        localStorage.setItem(LAPS_KEY, JSON.stringify({ sk, laps: this.snap.laps }));
      } catch {
        // Storage full or blocked: history then lasts until the page is closed.
      }
    }, 5_000);
  }

  private savePits() {
    const sk = Number(this.snap.state.SessionInfo?.Key) || 0;
    if (!sk) return;
    try {
      localStorage.setItem(PITS_KEY, JSON.stringify({ sk, pits: this.snap.pits }));
    } catch {
      // Storage full or blocked: the stops then last until the page is closed.
    }
  }

  /** Applies a message now, or once it is as old as the TV delay set in Settings. */
  private later(apply: () => void) {
    const delay = liveDelaySeconds();
    if (delay !== this.snap.delay) this.set({ delay });
    if (!delay && !this.pending.length) return apply();
    this.pending.push({ at: Date.now(), apply });
    if (this.drain) return;
    this.drain = setInterval(() => {
      // The delay is read on every tick, so a longer one holds messages back further and a shorter one catches up.
      const d = liveDelaySeconds();
      if (d !== this.snap.delay) this.set({ delay: d });
      const due = Date.now() - d * 1000;
      while (this.pending.length && this.pending[0].at <= due) this.pending.shift()!.apply();
      if (!this.pending.length && d === 0) {
        clearInterval(this.drain);
        this.drain = undefined;
      }
    }, 250);
  }

  /** Notes laps that have just been completed. */
  private track(state: F1State): RecordedLap[] {
    const lines = state.TimingData?.Lines ?? {};
    const stats = state.TimingStats?.Lines ?? {};
    const done: RecordedLap[] = [];
    for (const k of Object.keys(lines)) {
      const n = Number(k);
      const l = lines[k];
      const count = Number(l?.NumberOfLaps ?? 0);
      if (l?.PitOut) this.pitOutThisLap.set(n, true);
      const before = this.lapsSeen.get(n);
      this.lapsSeen.set(n, count);
      // Only laps we saw being completed: the snapshot does not hold earlier laps.
      if (before == null || count <= before) continue;
      const sectors = [0, 1, 2].map((i) => l?.Sectors?.[i]);
      done.push({
        driver: n,
        lap: count,
        time: realLap(parseLapTime(l?.LastLapTime?.Value)),
        sectors: sectors.map((s) => parseLapTime(s?.Value || s?.PreviousValue)),
        sectorFlags: sectors.map(flagOf),
        segments: sectors.map((s) => (Array.isArray(s?.Segments) ? s.Segments.map((x: any) => x?.Status ?? null) : [])),
        pitOut: (this.pitOutThisLap.get(n) ?? false) || realLap(parseLapTime(l?.LastLapTime?.Value)) == null,
        endedAt: Date.now(),
        trap: Number(l?.Speeds?.ST?.Value) || Number(stats[k]?.BestSpeeds?.ST?.Value) || null,
      });
      this.pitOutThisLap.set(n, false);
    }
    return done;
  }

  private fail() {
    this.ws = null;
    clearInterval(this.ping);
    if (this.users <= 0) return this.set({ status: 'error', retryAt: null });
    // Try again, waiting longer each time (up to a minute).
    const wait = Math.min(60_000, 3_000 * 2 ** this.attempt++);
    this.set({ status: 'error', retryAt: Date.now() + wait });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.users > 0 && this.connect(), wait);
  }

  private stop() {
    clearTimeout(this.retry);
    clearInterval(this.drain);
    this.drain = undefined;
    this.pending = [];
    clearInterval(this.ping);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.attempt = 0;
    this.set({ status: 'idle', delay: this.snap.delay, state: {}, laps: [], updatedAt: null, receivedAt: null, retryAt: null });
  }
}

/** The TV delay from Settings, in seconds (0 to 120). */
export function liveDelaySeconds(): number {
  return Math.max(0, Math.min(120, Math.round(getSettings().liveDelay || 0)));
}

export const f1Feed = new F1LiveFeed();

/** F1's live feed while `enabled` (connects on first use, disconnects a minute after the last user leaves). */
export function useF1Feed(enabled: boolean): FeedSnapshot | null {
  useEffect(() => (enabled ? f1Feed.use() : undefined), [enabled]);
  const snap = useSyncExternalStore(f1Feed.subscribe, f1Feed.get);
  return enabled ? snap : null;
}
