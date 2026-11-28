/**
 * Turns F1's live timing feed (api/f1live) into the same shapes the app uses for OpenF1 data, so the timing tower,
 * FIA feed, team radio and session bar work unchanged during a live session.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FeedSnapshot, RecordedLap } from '../api/f1live';
import { parseLapTime, realLap } from '../api/f1live';
import type { Lap, OF1Driver, PitDetail, RaceControlMsg, Session, Stint, TeamRadio, Weather } from '../api/openf1';
import type { QualiState, TimingRow } from '../hooks/useLiveTiming';
import { teamColour } from './teams';

type Tone = 'overall' | 'personal' | 'slower' | 'none';

const list = (v: any): any[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v).sort((a, b) => Number(a) - Number(b)).map((k) => v[k]) : []);
const num = (v: any): number | null => {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) ? null : n;
};
/** F1 times are UTC without a zone ("2026-11-22T04:17:59"); OpenF1 shapes expect ISO with a zone. */
const utc = (v: any): string => (typeof v !== 'string' ? new Date().toISOString() : /[zZ]|[+-]\d\d:\d\d$/.test(v) ? v : `${v}Z`);
/** Local time plus GMT offset ("-08:00:00") to an ISO UTC date. */
function localToUtc(local: string | undefined, offset: string | undefined): string {
  if (!local) return new Date(0).toISOString();
  const m = /^(-)?(\d+):(\d+)/.exec(offset ?? '00:00');
  const mins = m ? (Number(m[2]) * 60 + Number(m[3])) * (m[1] ? -1 : 1) : 0;
  return new Date(Date.parse(`${local}Z`) - mins * 60_000).toISOString();
}

/** The session the feed is about, as an OpenF1 session. */
export function feedSession(s: FeedSnapshot | null): Session | null {
  const info = s?.state.SessionInfo;
  if (!info?.Key) return null;
  return {
    session_key: Number(info.Key),
    session_name: info.Name ?? info.Type ?? 'Session',
    session_type: info.Type ?? '',
    date_start: localToUtc(info.StartDate, info.GmtOffset),
    date_end: localToUtc(info.EndDate, info.GmtOffset),
    meeting_key: Number(info.Meeting?.Key ?? 0),
    location: info.Meeting?.Location ?? '',
    country_name: info.Meeting?.Country?.Name ?? '',
    circuit_short_name: info.Meeting?.Circuit?.ShortName ?? '',
    circuit_key: Number(info.Meeting?.Circuit?.Key ?? 0),
    year: Number(String(info.StartDate ?? '').slice(0, 4)) || new Date().getFullYear(),
  };
}

export function feedDrivers(s: FeedSnapshot): OF1Driver[] {
  const dl = s.state.DriverList ?? {};
  return Object.keys(dl)
    .filter((k) => /^\d+$/.test(k) && dl[k]?.Tla)
    .map((k) => {
      const d = dl[k];
      return {
        driver_number: Number(k),
        broadcast_name: d.BroadcastName ?? d.Tla,
        full_name: [d.FirstName, d.LastName].filter(Boolean).join(' ') || d.FullName || d.Tla,
        name_acronym: d.Tla,
        team_name: d.TeamName ?? null,
        team_colour: d.TeamColour ?? null,
        first_name: d.FirstName ?? null,
        last_name: d.LastName ?? null,
        headshot_url: d.HeadshotUrl ?? null,
        country_code: null,
      };
    });
}

export function feedMessages(s: FeedSnapshot): RaceControlMsg[] {
  return list(s.state.RaceControlMessages?.Messages).map((m) => ({
    date: utc(m.Utc),
    category: m.Category ?? 'Other',
    flag: m.Flag ?? null,
    scope: m.Scope ?? null,
    sector: num(m.Sector),
    driver_number: num(m.RacingNumber) ?? (() => {
      const c = /CAR (\d+)/.exec(m.Message ?? '');
      return c ? Number(c[1]) : null;
    })(),
    lap_number: num(m.Lap),
    message: m.Message ?? '',
  }));
}

export function feedWeather(s: FeedSnapshot): Weather | undefined {
  const w = s.state.WeatherData;
  if (!w) return undefined;
  return {
    date: new Date(s.updatedAt ?? Date.now()).toISOString(),
    air_temperature: num(w.AirTemp) ?? 0,
    track_temperature: num(w.TrackTemp) ?? 0,
    humidity: num(w.Humidity) ?? 0,
    pressure: num(w.Pressure) ?? 0,
    rainfall: num(w.Rainfall) ?? 0,
    wind_direction: num(w.WindDirection) ?? 0,
    wind_speed: num(w.WindSpeed) ?? 0,
  };
}

export function feedRadio(s: FeedSnapshot): TeamRadio[] {
  const path = s.state.SessionInfo?.Path ?? '';
  return list(s.state.TeamRadio?.Captures).map((c) => ({
    date: utc(c.Utc),
    driver_number: Number(c.RacingNumber),
    recording_url: `https://livetiming.formula1.com/static/${path}${c.Path}`,
  }));
}

function feedStints(n: number, app: any): Stint[] {
  let lap = 1;
  return list(app?.Stints).map((st, i) => {
    const total = num(st.TotalLaps) ?? 0;
    const start = num(st.StartLaps) ?? 0;
    const len = Math.max(0, total - start);
    const s: Stint = { driver_number: n, stint_number: i + 1, compound: st.Compound ?? null, lap_start: lap, lap_end: lap + Math.max(0, len - 1), tyre_age_at_start: start };
    lap += len;
    return s;
  });
}

const toneOf = (x: any): Tone => (!x || !x.Value ? 'none' : x.OverallFastest ? 'overall' : x.PersonalFastest ? 'personal' : 'slower');

/** Recorded laps as OpenF1 laps (only laps completed while the page was open). */
/** Pit stops recorded from the feed, as pit stop rows: pit lane time only (the stationary time is not in the feed). */
export function feedPits(s: FeedSnapshot): PitDetail[] {
  return s.pits.map((p) => ({ date: new Date(p.at).toISOString(), driver_number: p.driver, lap_number: p.lap, pit_duration: p.lane, lane_duration: p.lane, stop_duration: null }));
}

export function feedLaps(s: FeedSnapshot): Lap[] {
  return s.laps.map((r: RecordedLap) => ({
    date_start: r.time != null ? new Date(r.endedAt - r.time * 1000).toISOString() : null,
    driver_number: r.driver,
    lap_number: r.lap,
    lap_duration: r.time,
    duration_sector_1: r.sectors[0],
    duration_sector_2: r.sectors[1],
    duration_sector_3: r.sectors[2],
    is_pit_out_lap: r.pitOut,
    segments_sector_1: r.segments[0],
    segments_sector_2: r.segments[1],
    segments_sector_3: r.segments[2],
    st_speed: r.trap,
  }));
}

/** The timing tower rows. */
export function feedRows(s: FeedSnapshot, isRace: boolean): TimingRow[] {
  const lines = s.state.TimingData?.Lines ?? {};
  const appLines = s.state.TimingAppData?.Lines ?? {};
  const stats = s.state.TimingStats?.Lines ?? {};
  const recorded = feedLaps(s);
  const rows = feedDrivers(s).map((d): TimingRow => {
    const n = d.driver_number;
    const l = lines[n] ?? {};
    const app = appLines[n];
    const sectors = [0, 1, 2].map((i) => list(l.Sectors)[i]);
    const done = num(l.NumberOfLaps) ?? 0;
    const mine = recorded.filter((x) => x.driver_number === n);
    const last = mine.find((x) => x.lap_number === done);
    const rawLast = parseLapTime(l.LastLapTime?.Value);
    const lastTime = realLap(rawLast);
    // A "lap" longer than any real one is a car leaving the garage: shown as an out lap, with no time.
    const lastLap: Lap | undefined = last ?? (rawLast != null ? {
      date_start: null, driver_number: n, lap_number: done, lap_duration: lastTime,
      duration_sector_1: null, duration_sector_2: null, duration_sector_3: null, is_pit_out_lap: lastTime == null ? true : null,
    } : undefined);
    const recordedFlags = s.laps.find((x) => x.driver === n && x.lap === done)?.sectorFlags;
    const stints = feedStints(n, app);
    const stint = stints[stints.length - 1];
    const lastStint = list(app?.Stints).slice(-1)[0];
    // Gaps: races use gap/interval; practice and qualifying give the difference to the fastest lap.
    const qStats = list(l.Stats).slice(-1)[0];
    const gapRaw = l.GapToLeader ?? qStats?.TimeDiffToFastest;
    const intRaw = l.IntervalToPositionAhead?.Value ?? qStats?.TimeDifftoPositionAhead;
    const asGap = (v: any): number | string | null => {
      if (v == null || v === '') return null;
      if (typeof v === 'string' && /^LAP/i.test(v)) return 0;
      const x = Number(String(v).replace('+', ''));
      return Number.isFinite(x) ? x : String(v);
    };
    const inProgress = !l.Retired && !l.Stopped;
    const currentLap: Lap | undefined = inProgress ? {
      date_start: null,
      driver_number: n,
      lap_number: done + 1,
      lap_duration: null,
      duration_sector_1: parseLapTime(sectors[0]?.Value),
      duration_sector_2: parseLapTime(sectors[1]?.Value),
      duration_sector_3: parseLapTime(sectors[2]?.Value),
      is_pit_out_lap: !!l.PitOut,
      segments_sector_1: list(sectors[0]?.Segments).map((x) => x?.Status ?? null),
      segments_sector_2: list(sectors[1]?.Segments).map((x) => x?.Status ?? null),
      segments_sector_3: list(sectors[2]?.Segments).map((x) => x?.Status ?? null),
      st_speed: num(l.Speeds?.ST?.Value),
    } : lastLap;
    const status: TimingRow['status'] = l.Retired ? 'RETIRED' : l.Stopped ? 'STOP' : l.InPit ? 'IN PIT' : l.PitOut ? 'PIT OUT' : null;
    return {
      driver: d,
      colour: teamColour(d.team_name, d.team_colour),
      position: num(l.Position),
      grid: isRace ? num(app?.GridPos) : null,
      gridLap: null,
      gap: asGap(gapRaw),
      interval: asGap(intRaw),
      lastLap,
      bestLap: parseLapTime(l.BestLapTime?.Value) ?? parseLapTime(stats[n]?.PersonalBestLapTime?.Value),
      lapsDone: inProgress && done > 0 ? done + 1 : done,
      lastLapTone: !l.LastLapTime?.Value || lastTime == null ? 'none' : l.LastLapTime.OverallFastest ? 'overall' : l.LastLapTime.PersonalFastest ? 'personal' : 'slower',
      sectorTone: recordedFlags ?? ['none', 'none', 'none'],
      stint,
      stints,
      tyreAge: num(lastStint?.TotalLaps),
      pits: num(l.NumberOfPitStops) ?? Math.max(0, stints.length - 1),
      currentLap,
      currentSectorTone: sectors.map(toneOf),
      status,
      car: undefined,
      trapSpeed: num(stats[n]?.BestSpeeds?.ST?.Value),
      quali: isRace ? undefined : feedQualiRow(l, s),
    };
  });
  return rows.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
}

/** Lap counter and time left from the feed. */
export function feedProgress(s: FeedSnapshot): { lap: number | null; total: number | null; remaining: string | null; trackStatus: string | null } {
  return {
    lap: num(s.state.LapCount?.CurrentLap),
    total: num(s.state.LapCount?.TotalLaps),
    remaining: s.state.ExtrapolatedClock?.Remaining ?? null,
    trackStatus: s.state.TrackStatus?.Message ?? null,
  };
}

/**
 * Every driver's position at the start (index 0, the grid) and at the end of each lap so far, from F1's LapSeries
 * topic. Complete from the first lap, however late the page was opened.
 */
export function feedPositionTraces(s: FeedSnapshot): { laps: number; traces: { driver: number; positions: (number | null)[] }[] } | null {
  const ls = s.state.LapSeries;
  if (!ls || typeof ls !== 'object') return null;
  const traces = Object.keys(ls)
    .filter((k) => /^\d+$/.test(k))
    .map((k) => ({ driver: Number(k), positions: list(ls[k]?.LapPosition).map((p) => num(p)) }))
    .filter((t) => t.positions.length > 0);
  if (!traces.length) return null;
  return { laps: Math.max(...traces.map((t) => t.positions.length - 1)), traces };
}

/** Qualifying state from the feed: current part (SessionPart) and cars per part (NoEntries). */
export function feedQuali(s: FeedSnapshot): QualiState | null {
  const td = s.state.TimingData;
  const part = num(td?.SessionPart);
  const entries = list(td?.NoEntries).map((v) => num(v) ?? 0).filter((v) => v > 0);
  if (!part && !entries.length) return null;
  const finished = /finished|finalised|ends/i.test(String(s.state.SessionInfo?.SessionStatus ?? ''));
  return { part: finished ? null : part, entries: entries.length ? entries : [Object.keys(td?.Lines ?? {}).length] };
}

/** A driver's best time in each qualifying part, and the part they were knocked out in. */
function feedQualiRow(l: any, s: FeedSnapshot): TimingRow['quali'] {
  const times = [0, 1, 2].map((i) => parseLapTime(list(l?.BestLapTimes)[i]?.Value));
  if (times.every((t) => t == null) && !l?.KnockedOut) return undefined;
  const part = num(s.state.TimingData?.SessionPart) ?? 1;
  const lastWithTime = times.reduce((m, t, i) => (t != null ? i + 1 : m), 0);
  // Knocked out drivers stay in the part they last ran in.
  const out = l?.KnockedOut ? Math.max(1, Math.min(lastWithTime || part - 1, part - 1) || lastWithTime || 1) : null;
  return { times, out };
}
