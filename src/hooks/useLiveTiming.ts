import { useMemo } from 'react';
import {
  liveEvery,
  openf1,
  type CarData,
  type Interval,
  type Lap,
  type OF1Driver,
  type Pit,
  type Position,
  type RaceControlMsg,
  type Session,
  type TeamRadio,
  type Stint,
  type Weather,
  getStartingGrid,
  type PitDetail,
  type SessionResult,
} from '../api/openf1';
import { classify, type ClassifiedMsg } from '../lib/raceControl';
import { teamColour } from '../lib/teams';
import { usePoll } from './usePoll';
import { useF1Feed } from '../api/f1live';
import { feedDrivers, feedLaps, feedMessages, feedPits, feedPositionTraces, feedProgress, feedQuali, feedRadio, feedRows, feedWeather } from '../lib/f1adapter';
import { getSettings } from '../lib/settings';
import { useQuery } from '@tanstack/react-query';

/**
 * Poll intervals while a session is live. With the track map and team radio on the same page this comes to about
 * 28 requests a minute, under OpenF1's default budget of 30. Gaps and race control stay quickest; slower-changing
 * data (laps, tyres, pit stops, weather, classification) is polled less often. `liveEvery` speeds all of it up
 * when the budget in Settings is higher.
 */
const LIVE_MS = { position: 15_000, intervals: 10_000, laps: 30_000, rc: 20_000, stints: 60_000, pit: 60_000, weather: 120_000, car: 15_000, drivers: 300_000, results: 120_000 };

interface Latest<T> {
  byDriver: Map<number, T>;
  last: string | undefined;
}

function mergeLatest<T extends { driver_number: number; date: string }>(prev: Latest<T> | undefined, rows: T[]): Latest<T> {
  const byDriver = new Map(prev?.byDriver);
  let last = prev?.last;
  for (const r of rows) {
    const cur = byDriver.get(r.driver_number);
    if (!cur || cur.date <= r.date) byDriver.set(r.driver_number, r);
    if (!last || r.date > last) last = r.date;
  }
  return { byDriver, last };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Qualifying: the part running (1 to 3, null once finished) and how many cars take part in each part. */
export interface QualiState {
  part: number | null;
  /** Cars in Q1, Q2 and Q3, e.g. [22, 16, 10]. */
  entries: number[];
}

/** Best time in each qualifying part, mapped from OpenF1's classification (duration = [Q1, Q2, Q3]). */
export function qualiFromResults(results: SessionResult[]): { state: QualiState; byDriver: Map<number, { times: (number | null)[]; out: number | null }> } | null {
  const rows = results.filter((r) => Array.isArray(r.duration));
  if (!rows.length) return null;
  const times = new Map(rows.map((r) => [r.driver_number, (r.duration as (number | null)[]).slice(0, 3).map((v) => (typeof v === 'number' && v > 0 ? v : null))]));
  // Cars in each part: everyone in Q1; in Q2 and Q3, those who set a time there or rank inside the cut.
  const entries = [0, 1, 2].map((k) => (k === 0 ? rows.length : [...times.values()].filter((t) => t[k] != null).length));
  const byDriver = new Map<number, { times: (number | null)[]; out: number | null }>();
  for (const r of rows) {
    const t = times.get(r.driver_number)!;
    const pos = r.position ?? 99;
    // Knocked out in Q1 or Q2 by classification position (penalties aside, the order of the cut).
    const out = entries[1] && pos > entries[1] ? 1 : entries[2] && pos > entries[2] ? 2 : null;
    byDriver.set(r.driver_number, { times: t, out });
  }
  return { state: { part: null, entries }, byDriver };
}

export interface TimingRow {
  driver: OF1Driver;
  colour: string;
  position: number | null;
  /** Starting grid slot (races and sprints). */
  grid: number | null;
  /** Qualifying lap that set the grid slot. */
  gridLap: number | null;
  gap: number | string | null;
  interval: number | string | null;
  lastLap: Lap | undefined;
  bestLap: number | null;
  lapsDone: number;
  sectorTone: ('overall' | 'personal' | 'slower' | 'none')[];
  lastLapTone: 'overall' | 'personal' | 'slower' | 'none';
  stint: Stint | undefined;
  /** Every stint so far, oldest first. */
  stints: Stint[];
  tyreAge: number | null;
  pits: number;
  /** The newest lap row; while live it is still in progress, so its sectors fill in as the car goes round. */
  currentLap: Lap | undefined;
  currentSectorTone: ('overall' | 'personal' | 'slower' | 'none')[];
  status: 'IN PIT' | 'PIT OUT' | 'STOP' | 'RETIRED' | 'DNS' | 'DSQ' | null;
  /** Live speed, throttle and brake, when the session is live. */
  car: CarData | undefined;
  /** Fastest speed-trap reading this session. */
  trapSpeed: number | null;
  /** Qualifying: best time in Q1, Q2 and Q3, and the part the driver was knocked out in. */
  quali?: { times: (number | null)[]; out: number | null };
}

/** Last mini-sector code recorded on a lap. */
function lastSegment(l: Lap): number | null {
  const all = [...(l.segments_sector_1 ?? []), ...(l.segments_sector_2 ?? []), ...(l.segments_sector_3 ?? [])].filter((v): v is number => v != null && v > 0);
  return all.length ? all[all.length - 1] : null;
}

/** Whether a car is in the pit lane, or on its way out, from pit records and mini-sector codes. */
function pitStatus(mine: Lap[], pits: Pit[], t: number): TimingRow['status'] {
  const latest = mine[mine.length - 1];
  const p = pits.filter((x) => Date.parse(x.date) <= t).sort((a, b) => a.date.localeCompare(b.date)).pop();
  if (p) {
    const entered = Date.parse(p.date);
    const laterLap = mine.some((l) => l.date_start && Date.parse(l.date_start) > entered + 5_000);
    if (p.pit_duration != null ? t < entered + p.pit_duration * 1000 : !laterLap) return 'IN PIT';
  }
  if (!latest) return null;
  if (latest.lap_duration == null) {
    if (latest.is_pit_out_lap) {
      const segs = (latest.segments_sector_1 ?? []).filter((v): v is number => v != null && v > 0);
      return segs.length === 0 || segs.every((v) => v === 2064) ? 'IN PIT' : 'PIT OUT';
    }
    return null;
  }
  // The newest lap is finished and ended in the pit lane, with no lap after it: the car is in the garage.
  return lastSegment(latest) === 2064 ? 'IN PIT' : null;
}

export function useLiveTiming(session: Session | undefined, live: boolean, carDriver: number | null) {
  // During a live session without an OpenF1 token, read F1's own live timing feed instead (see api/f1live).
  const feed = useF1Feed(live && !getSettings().openf1Token.trim());
  // While the feed reconnects after a drop, keep showing what it last sent (the status pill says it is reconnecting).
  const fromFeed = !!feed && feed.status !== 'idle' && Number(feed.state.SessionInfo?.Key) === session?.session_key;
  const sk = fromFeed ? undefined : session?.session_key;
  const every = (ms: number) => (live ? liveEvery(ms) : 0);
  const endMs = session ? Date.parse(session.date_end) : 0;

  const drivers = usePoll<OF1Driver[]>(sk ? `drv-${sk}` : null, (_p, signal) => openf1('drivers', { session_key: sk }, signal), every(LIVE_MS.drivers));

  const positions = usePoll<Latest<Position>>(
    sk ? `pos-${sk}-${live}` : null,
    async (prev, signal) => mergeLatest(prev, await openf1<Position>('position', { session_key: sk, 'date>': prev?.last }, signal)),
    every(LIVE_MS.position),
  );

  const intervals = usePoll<Latest<Interval>>(
    sk ? `int-${sk}-${live}` : null,
    async (prev, signal) => {
      // Intervals are published every few seconds, so only ask for recent rows.
      const since = prev?.last ?? iso(live ? Date.now() - 60_000 : endMs - 20 * 60_000);
      return mergeLatest(prev, await openf1<Interval>('intervals', { session_key: sk, 'date>': since }, signal));
    },
    every(LIVE_MS.intervals),
  );

  const laps = usePoll<Map<string, Lap>>(
    sk ? `laps-${sk}-${live}` : null,
    async (prev, signal) => {
      // Lap rows fill in as sectors complete, so re-read the last two laps each time.
      const maxLap = prev ? Math.max(0, ...[...prev.values()].map((l) => l.lap_number)) : 0;
      const rows = await openf1<Lap>('laps', { session_key: sk, 'lap_number>=': prev ? Math.max(1, maxLap - 1) : undefined }, signal);
      const next = new Map(prev);
      for (const l of rows) next.set(`${l.driver_number}-${l.lap_number}`, l);
      return next;
    },
    every(LIVE_MS.laps),
  );

  const raceControl = usePoll<RaceControlMsg[]>(
    sk ? `rc-${sk}-${live}` : null,
    async (prev, signal) => {
      const last = prev?.length ? prev[prev.length - 1].date : undefined;
      const rows = await openf1<RaceControlMsg>('race_control', { session_key: sk, 'date>': last }, signal);
      return [...(prev ?? []), ...rows].sort((a, b) => a.date.localeCompare(b.date));
    },
    every(LIVE_MS.rc),
  );

  const stints = usePoll<Stint[]>(sk ? `st-${sk}-${live}` : null, (_p, signal) => openf1('stints', { session_key: sk }, signal), every(LIVE_MS.stints));
  const isRaceSession = /race|sprint/i.test(session?.session_name ?? '') && !/qualifying|shootout/i.test(session?.session_name ?? '');
  const grid = useQuery({
    queryKey: ['grid', sk],
    enabled: !!sk && !!session && isRaceSession,
    // Refreshed every few minutes before the start, in case the official grid (with penalties) is published late.
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: ({ signal }) => getStartingGrid(session!, signal),
  });

  // Official classification: marks retirements (DNF), non-starters and disqualifications.
  const results = usePoll<SessionResult[]>(sk ? `res-${sk}-${live}` : null, (_p, signal) => openf1('session_result', { session_key: sk }, signal), every(LIVE_MS.results));
  const pits = usePoll<Pit[]>(sk ? `pit-${sk}-${live}` : null, (_p, signal) => openf1('pit', { session_key: sk }, signal), every(LIVE_MS.pit));
  const weather = usePoll<Weather[]>(sk ? `wx-${sk}-${live}` : null, (_p, signal) => openf1('weather', { session_key: sk }, signal), every(LIVE_MS.weather));

  // Speed, throttle and brake for every car, in one request. Only while live: after the session the cars are parked.
  const cars = usePoll<Latest<CarData>>(
    sk && live ? `cars-${sk}` : null,
    async (prev, signal) => {
      const since = iso(Date.now() - 5_000);
      const rows = await openf1<CarData>('car_data', { session_key: sk, 'date>': prev?.last && prev.last > since ? prev.last : since }, signal);
      return mergeLatest(prev, rows);
    },
    liveEvery(LIVE_MS.car),
  );

  const messages: ClassifiedMsg[] = useMemo(
    () => (raceControl.data ?? []).map(classify).reverse(),
    [raceControl.data],
  );

  const rows: TimingRow[] = useMemo(() => {
    const list = drivers.data ?? [];
    const allLaps = [...(laps.data?.values() ?? [])];
    const best = (k: 'lap_duration' | 'duration_sector_1' | 'duration_sector_2' | 'duration_sector_3', ls: Lap[]) => {
      const vals = ls.map((l) => l[k]).filter((v): v is number => v != null && v > 0);
      return vals.length ? Math.min(...vals) : null;
    };
    const overall = {
      lap: best('lap_duration', allLaps),
      s: [best('duration_sector_1', allLaps), best('duration_sector_2', allLaps), best('duration_sector_3', allLaps)],
    };
    const tone = (v: number | null, pb: number | null, ob: number | null) =>
      v == null ? 'none' : ob != null && v <= ob ? 'overall' : pb != null && v <= pb ? 'personal' : 'slower';

    const isRace = /race|sprint/i.test(session?.session_name ?? '') && !/qualifying|shootout/i.test(session?.session_name ?? '');
    const newestStart = Math.max(0, ...allLaps.map((l) => (l.date_start ? Date.parse(l.date_start) : 0)));
    const out = list.map((d): TimingRow => {
      const mine = allLaps.filter((l) => l.driver_number === d.driver_number).sort((a, b) => a.lap_number - b.lap_number);
      const completed = mine.filter((l) => l.lap_duration != null);
      const lastLap = completed[completed.length - 1];
      const pbLap = best('lap_duration', mine);
      const pbS = [best('duration_sector_1', mine), best('duration_sector_2', mine), best('duration_sector_3', mine)];
      const myStints = (stints.data ?? []).filter((s) => s.driver_number === d.driver_number).sort((a, b) => a.stint_number - b.stint_number);
      const stint = myStints[myStints.length - 1];
      const lapsDone = mine.length ? mine[mine.length - 1].lap_number : 0;
      const tyreAge = stint ? (stint.tyre_age_at_start ?? 0) + Math.max(0, lapsDone - (stint.lap_start ?? lapsDone)) : null;
      const iv = intervals.data?.byDriver.get(d.driver_number);
      const gridSlot = grid.data?.find((g) => g.driver_number === d.driver_number);
      // The driver's newest lap: live, its sectors and mini-sectors fill in as the car goes round.
      const currentLap = mine[mine.length - 1];
      const myPits = (pits.data ?? []).filter((p) => p.driver_number === d.driver_number);
      const traps = mine.map((l) => l.st_speed ?? 0).filter((v) => v > 0);
      return {
        driver: d,
        colour: teamColour(d.team_name, d.team_colour),
        // Before the start there are no live positions, so the starting grid sets the order.
        position: positions.data?.byDriver.get(d.driver_number)?.position ?? gridSlot?.position ?? null,
        grid: gridSlot?.position ?? null,
        gridLap: gridSlot?.lap_duration ?? null,
        gap: iv?.gap_to_leader ?? null,
        interval: iv?.interval ?? null,
        lastLap,
        bestLap: pbLap,
        lapsDone,
        lastLapTone: tone(lastLap?.lap_duration ?? null, pbLap, overall.lap),
        sectorTone: [0, 1, 2].map((i) =>
          tone(
            lastLap ? [lastLap.duration_sector_1, lastLap.duration_sector_2, lastLap.duration_sector_3][i] : null,
            pbS[i],
            overall.s[i],
          ),
        ),
        stint,
        stints: myStints,
        tyreAge,
        pits: myPits.length,
        currentLap,
        currentSectorTone: [0, 1, 2].map((i) =>
          tone(currentLap ? [currentLap.duration_sector_1, currentLap.duration_sector_2, currentLap.duration_sector_3][i] : null, pbS[i], overall.s[i]),
        ),
        // Once a session is over every car is parked, so the pit status only means something while live.
        status: (() => {
          const res = (results.data ?? []).find((x) => x.driver_number === d.driver_number);
          if (res?.dsq) return 'DSQ';
          if (res?.dns) return 'DNS';
          if (res?.dnf) return 'RETIRED';
          if (!live) return null;
          const pit = pitStatus(mine, myPits, Date.now());
          const car = cars.data?.byDriver.get(d.driver_number);
          // Out on track at 0 km/h, after the start.
          const stopped = !!car && car.speed === 0 && pit !== 'IN PIT' && lapsDone > 0;
          // In a race, a car that is stopped or parked and has not started a lap for 4 minutes while others have.
          const lastStart = mine.length && mine[mine.length - 1].date_start ? Date.parse(mine[mine.length - 1].date_start!) : 0;
          if (isRace && (stopped || pit === 'IN PIT') && lastStart && newestStart - lastStart > 4 * 60_000) return 'RETIRED';
          return stopped ? 'STOP' : pit;
        })(),
        car: cars.data?.byDriver.get(d.driver_number),
        trapSpeed: traps.length ? Math.max(...traps) : null,
      };
    });
    out.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    // Finished races: the official classification has the final gap for every car. The gaps polled near the
    // scheduled end can be missing when a race finishes early, so fill them in and work out the intervals.
    if (!live && isRace && results.data?.length) {
      const res = new Map(results.data.map((r) => [r.driver_number, r]));
      for (const r of out) {
        const g = res.get(r.driver.driver_number)?.gap_to_leader;
        if (r.gap == null && g != null && !Array.isArray(g)) r.gap = typeof g === 'number' ? g : String(g);
      }
      out.forEach((r, i) => {
        const prev = out[i - 1];
        if (r.interval == null && i > 0 && typeof r.gap === 'number' && typeof prev?.gap === 'number') r.interval = Math.max(0, r.gap - prev.gap);
      });
    }
    return out;
  }, [drivers.data, laps.data, stints.data, intervals.data, positions.data, pits.data, cars.data, results.data, grid.data, live, session?.session_name]);

  const isQualiSession = /qualifying|shootout/i.test(session?.session_name ?? '');
  const qualiData = useMemo(() => (isQualiSession ? qualiFromResults(results.data ?? []) : null), [isQualiSession, results.data]);
  const qualiRows = useMemo(
    () => (qualiData ? rows.map((r) => ({ ...r, quali: qualiData.byDriver.get(r.driver.driver_number) })) : rows),
    [rows, qualiData],
  );

  const currentLap = rows.reduce((m, r) => Math.max(m, r.lapsDone), 0);
  const fastest = rows.reduce<number | null>((m, r) => (r.bestLap != null && (m == null || r.bestLap < m) ? r.bestLap : m), null);
  const latestWeather = weather.data?.length ? weather.data[weather.data.length - 1] : undefined;

  const errors = [drivers, positions, laps, raceControl].map((s) => s.error).filter(Boolean);
  const loading = drivers.loading || positions.loading;
  const updatedAt = Math.max(positions.updatedAt ?? 0, laps.updatedAt ?? 0, raceControl.updatedAt ?? 0) || null;

  const fromF1 = useMemo(() => {
    if (!fromFeed || !feed) return null;
    const feedRowsList = feedRows(feed, isRaceSession);
    const progress = feedProgress(feed);
    const best = feedRowsList.reduce<number | null>((m, r) => (r.bestLap != null && (m == null || r.bestLap < m) ? r.bestLap : m), null);
    const drivers = feedDrivers(feed);
    return {
      rows: feedRowsList,
      messages: feedMessages(feed).map(classify).reverse(),
      stints: feedRowsList.flatMap((r) => r.stints),
      weather: feedWeather(feed),
      car: null,
      currentLap: progress.lap ?? feedRowsList.reduce((m, r) => Math.max(m, r.lapsDone), 0),
      fastest: best,
      loading: false,
      error: null,
      updatedAt: feed.updatedAt,
      driversByNumber: new Map(drivers.map((d) => [d.driver_number, d])),
      laps: feedLaps(feed),
      pits: feedPits(feed),
      source: 'f1' as const,
      radio: feedRadio(feed),
      quali: isQualiSession ? feedQuali(feed) : null,
      positionTraces: feedPositionTraces(feed),
      totalLaps: progress.total,
      remaining: progress.remaining,
    };
  }, [fromFeed, feed, isRaceSession, isQualiSession]);
  if (fromF1) return fromF1;

  return {
    source: 'openf1' as const,
    quali: (qualiData?.state ?? null) as QualiState | null,
    radio: null as TeamRadio[] | null,
    positionTraces: null as ReturnType<typeof feedPositionTraces>,
    totalLaps: null as number | null,
    remaining: null as string | null,
    rows: qualiRows,
    messages,
    stints: stints.data ?? [],
    weather: latestWeather,
    car: (carDriver != null ? cars.data?.byDriver.get(carDriver) : undefined) ?? null,
    currentLap,
    fastest,
    loading,
    error: errors[0] ?? null,
    updatedAt,
    driversByNumber: new Map((drivers.data ?? []).map((d) => [d.driver_number, d])),
    laps: [...(laps.data?.values() ?? [])],
    pits: (pits.data ?? []) as PitDetail[],
  };
}
