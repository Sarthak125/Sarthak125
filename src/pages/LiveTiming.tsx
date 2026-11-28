import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCircuitLaps } from '../api/jolpica';
import { getLayout } from '../lib/sectorLines';
import { useSchedule } from '../hooks/useSeason';
import { isSessionLive, liveEvery, type Lap, type OF1Driver, type Session } from '../api/openf1';
import { Empty, ErrorBox, Loading } from '../components/States';
import { FiaText, FiaWhen } from '../components/FiaText';
import { LiveTrackMap } from '../components/LiveTrackMap';
import { RadioCards } from '../components/RadioCards';
import { LiveStandings } from '../components/LiveStandings';
import { InvestigationsPanel, TrackLimitsPanel } from '../components/FiaPanels';
import { GapChart } from '../components/GapChart';
import { Footer } from '../components/Shell';
import { useNow } from '../hooks/usePoll';
import { useLatestSessions } from '../hooks/useSeason';
import { useLiveTiming, type QualiState, type TimingRow } from '../hooks/useLiveTiming';
import { fmtClock, fmtDuration, fmtGap, fmtLap, fmtSector, fmtShortClock, raceStart } from '../lib/format';
import {
  isMinor,
  openInvestigations,
  summarisePenalties,
  summariseTrackLimits,
  TABS,
  trackStatus,
  type ClassifiedMsg,
  type MsgTab,
} from '../lib/raceControl';
import { teamColour, tyre } from '../lib/teams';
import { StarIcon } from '../components/Icons';
import { useFavourite, useFavouriteTeam, type FavouriteTeam } from '../hooks/useFavourite';
import type { DriverLabel } from '../components/RadioList';
import { driverHref } from '../lib/router';
import { usePoll } from '../hooks/usePoll';
import { openf1, type TeamRadio } from '../api/openf1';
import { FlagIcon } from '../components/Icons';
import type React from 'react';
import { ingestFavourite } from '../lib/alerts';
import { useOpenF1Blocked } from '../lib/openf1Window';
import { OpenF1BlockedNotice } from '../components/OpenF1Blocked';
import { DelayPicker } from '../components/DelayPicker';
import { LongRunPace } from '../components/LongRunPace';
import { RainWatch } from '../components/RainWatch';
import { TyreStrategy } from '../components/TyreStrategy';
import { SpoilerCover } from '../components/SpoilerCover';
import { useSpoilers } from '../hooks/useSpoilers';
import { overtakeAid, type PitDetail } from '../api/openf1';
import { PositionLines, type LineInfo } from '../components/PositionChart';
import { getRacePositions } from '../lib/sectorLines';
import { activeWindow } from '../lib/openf1Window';
import { useF1Feed } from '../api/f1live';
import { FeedStatus } from '../components/FeedStatus';
import { feedSession } from '../lib/f1adapter';
import { getSettings, useSettings } from '../lib/settings';
import type { Meeting } from '../api/openf1';

export function LiveTiming() {
  const sessions = useLatestSessions();
  const blocked = useOpenF1Blocked();
  const now = useNow(1000);
  const [picked, setPicked] = useState<number | null>(null);
  // While a session's live window is open (and OpenF1 is paused for free users), F1's own feed names the session.
  // Only while it is needed: OpenF1 is paused, its session list is not in yet, or a session is live.
  const feedOn =
    !getSettings().openf1Token.trim() &&
    !!activeWindow(now, 60 * 60_000) &&
    (!!blocked || !sessions.data?.length || sessions.data.some((x) => isSessionLive(x, now)));
  const feed = useF1Feed(feedOn);
  const feedSess = feedSession(feed);
  const spoilers = useSpoilers();

  // Any earlier weekend of the season in the header can be opened too (OpenF1 has every session from 2023).
  const { season } = useSettings();
  const year = season === 'current' ? new Date(now).getFullYear() : Number(season);
  const [meetingKey, setMeetingKey] = useState<number | null>(null);
  const meetings = useQuery({
    queryKey: ['of1-meetings', year],
    enabled: year >= 2023,
    staleTime: 30 * 60_000,
    queryFn: async () => (await openf1<Meeting>('meetings', { year })).sort((a, b) => a.date_start.localeCompare(b.date_start)),
  });
  const latestKey = sessions.data?.[0]?.meeting_key ?? null;
  const pastMeetings = (meetings.data ?? []).filter((m) => Date.parse(m.date_start) <= now && !/testing/i.test(m.meeting_name));
  const otherWeekend = meetingKey != null && meetingKey !== latestKey;
  const weekendSessions = useQuery({
    queryKey: ['of1-sessions', meetingKey],
    enabled: otherWeekend,
    staleTime: 30 * 60_000,
    queryFn: async () => (await openf1<Session>('sessions', { meeting_key: meetingKey! })).sort((a, b) => a.date_start.localeCompare(b.date_start)),
  });
  const pickWeekend = (key: number) => {
    setMeetingKey(key === latestKey ? null : key);
    setPicked(null);
  };

  const list = otherWeekend ? (weekendSessions.data ?? []) : sessions.data?.length ? sessions.data : feedSess ? [feedSess] : [];
  const defaultSession = list.find((s) => isSessionLive(s, now)) ?? [...list].reverse().find((s) => Date.parse(s.date_start) <= now) ?? list[0];
  const session = list.find((s) => s.session_key === picked) ?? defaultSession;
  const live = session ? isSessionLive(session, now) : false;

  const t = useLiveTiming(session, live, null);
  const fav = useFavourite();
  const favTeam = useFavouriteTeam();
  const teamNums = t.rows.filter((r) => favTeam?.codes.has(r.driver.name_acronym)).map((r) => r.driver.driver_number);
  const favNum = t.rows.find((r) => r.driver.name_acronym === fav?.code)?.driver.driver_number ?? null;

  useEffect(() => {
    // No pop-ups about the favourite while spoiler-free mode hides this weekend.
    if (!live || !session || !fav || favNum == null || t.loading || spoilers.sessionHidden(session.date_start)) return;
    const me = t.rows.find((r) => r.driver.driver_number === favNum);
    ingestFavourite({ sessionKey: session.session_key, code: fav.code, position: me?.position ?? null, pits: me?.pits ?? 0, messages: t.messages.filter((m) => m.cars.includes(favNum)) });
  }, [live, session, fav, favNum, t.rows, t.messages, t.loading, spoilers]);

  const status = useMemo(() => trackStatus([...t.messages].reverse()), [t.messages]);
  const isRace = /race|sprint/i.test(session?.session_name ?? '') && !/qualifying|shootout/i.test(session?.session_name ?? '');
  const isSprint = /sprint/i.test(session?.session_name ?? '');

  // Planned race distance: laps run by the winner of the latest race (or sprint) at this circuit.
  const schedule = useSchedule(session ? String(session.year) : 'current');
  const round = session
    ? (schedule.data ?? []).find((r) => {
        const d = raceStart(r)?.getTime() ?? Date.parse(r.date);
        return Math.abs(d - Date.parse(session.date_start)) < 4 * 86_400_000;
      })
    : undefined;
  // Pit stop time loss for this circuit (same layout data the track map uses, so it comes from cache).
  const layout = useQuery({
    queryKey: ['circuit', session?.circuit_key, session?.year],
    enabled: !!session?.circuit_key,
    staleTime: Infinity,
    queryFn: ({ signal }) => getLayout(session!.circuit_key, session!.year, session!.meeting_key, signal),
  });
  const pitLoss = layout.data?.pitLoss;
  const planned = useQuery({
    queryKey: ['planned-laps', round?.Circuit.circuitId, isSprint],
    enabled: isRace && !!round,
    staleTime: Infinity,
    queryFn: () => getCircuitLaps(round!.Circuit.circuitId, isSprint),
  });

  if (blocked && !feedSess) {
    if (feed?.status !== 'connecting') return <OpenF1BlockedNotice w={blocked} />;
    return (
      <>
        {getSettings().liveDelay > 0 && <div className="feed-note" role="status">Syncing to your {getSettings().liveDelay} s TV delay: live timing appears once it has caught up with your stream.</div>}
        <Loading rows={10} />
      </>
    );
  }
  if (sessions.error && !feedSess) return <ErrorBox error={sessions.error} what="the session list" />;
  if (sessions.isLoading && !feedSess) return <Loading rows={10} />;
  if (otherWeekend && weekendSessions.isLoading) return <Loading rows={10} />;
  if (!session) return <Empty>No sessions found on OpenF1 yet.</Empty>;

  const qBar = !isRace ? qualiLayout(t.rows, t.quali) : null;
  const hideSpoilers = spoilers.sessionHidden(session.date_start);
  const start = Date.parse(session.date_start);
  const elapsed = live ? now - start : Date.parse(session.date_end) - start;
  const remaining = Math.max(0, Date.parse(session.date_end) - now);
  const upcoming = now < start;
  const total = t.totalLaps ?? planned.data?.laps;
  const wx = t.weather;
  const compass = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];

  return (
    <>
      {t.source === 'f1' && (
        <div className="feed-note" role="note">
          <strong>Live timing straight from Formula 1's feed.</strong> OpenF1 is paused for free users during live sessions, so this page reads F1's own timing instead. Live car positions on the track map, car speed and stationary pit stop times need an F1 TV subscription; they fill in from OpenF1 about 30 minutes after the session. Pit lane times are live.
          <div style={{ marginTop: 8 }}><DelayPicker /> <span className="faint" style={{ fontSize: 12 }}>F1's feed is usually 30 to 60 s ahead of TV.</span></div>
        </div>
      )}
      <section className="card session-bar" aria-label="Session">
        {live ? (
          <span className="pill tone-solid" style={{ borderRadius: 6, padding: '6px 12px', fontSize: 12, letterSpacing: 1 }}>
            <span className="dot live-dot on" style={{ background: '#fff' }} />
            LIVE
          </span>
        ) : null}
        {t.source === 'f1' && feed ? <FeedStatus feed={feed} now={now} /> : null}
        {live && t.source === 'f1' && (feed?.delay ?? 0) > 0 ? (
          <span className="delay-pill" title="Live timing is held back to match your TV (Settings or the TV delay picker)">Delayed {feed!.delay} s</span>
        ) : null}
        {live ? null : upcoming ? (
          <span className="pill tone-blue" style={{ borderRadius: 6, padding: '6px 12px' }}>
            UPCOMING
          </span>
        ) : (
          <span className="pill tone-grey" style={{ borderRadius: 6, padding: '6px 12px' }}>
            FINISHED
          </span>
        )}
        <div>
          <h1>
            {session.location} · {session.session_name}
          </h1>
          <div className="session-pickers">
          {pastMeetings.length > 1 && (
            <label className="field">
              <span className="sr-only">Weekend</span>
              <select className="select" aria-label="Weekend" value={otherWeekend ? meetingKey! : (latestKey ?? '')} onChange={(e) => pickWeekend(Number(e.target.value))}>
                {[...pastMeetings].reverse().map((m) => (
                  <option key={m.meeting_key} value={m.meeting_key}>
                    {m.meeting_name.replace(/ Grand Prix$/, ' GP')}
                    {m.meeting_key === latestKey ? ' (latest)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span className="sr-only">Session</span>
            <select className="select" aria-label="Session" value={session.session_key} onChange={(e) => setPicked(Number(e.target.value))}>
              {list.map((s: Session) => (
                <option key={s.session_key} value={s.session_key}>
                  {s.session_name} · {fmtShortClock(new Date(s.date_start))}
                  {isSessionLive(s, now) ? ' (live)' : ''}
                </option>
              ))}
            </select>
          </label>
          </div>
        </div>
        <div className="metrics">
          {qBar && (
            <div className="metric" title="Qualifying part: Q1 and Q2 knock out the slowest cars, Q3 decides the top 10">
              <div className="l">PART</div>
              <div className="v q-part">
                {[1, 2, 3].map((k) => (
                  <span key={k} className={qBar.part === k ? 'on' : qBar.part == null || k < qBar.part ? 'done' : undefined}>Q{k}</span>
                ))}
              </div>
              <div className="s">{qBar.part == null ? 'Final classification' : qBar.through ? `Top ${qBar.through} go through` : 'Top 10 shoot-out'}</div>
            </div>
          )}
          {qBar?.part != null && qBar.through != null && (
            <div className="metric" title="Time of the last car currently through to the next part. Slower times are in the drop zone.">
              <div className="l">CUT-OFF</div>
              <div className="v">{qBar.cutoff != null ? fmtLap(qBar.cutoff) : '-'}</div>
              <div className="s">P{qBar.through} in Q{qBar.part}</div>
            </div>
          )}
          {!qBar && <div className="metric" title={total ? (t.totalLaps ? `Race distance: ${total} laps (from F1's live timing)` : `Planned distance: ${total} laps, as run in the ${planned.data?.season ?? 'last'} ${isSprint ? 'sprint' : 'race'} here`) : undefined}>
            <div className="l">LAP</div>
            <div className="v">
              {t.currentLap || '-'}
              {isRace && total ? <span className="faint">/{total}</span> : null}
            </div>
            {isRace && total && t.currentLap ? <div className="s">{Math.max(0, total - t.currentLap)} left</div> : null}
          </div>}
          <div className="metric">
            <div className="l">{upcoming ? 'STARTS IN' : live ? (isRace ? 'ELAPSED' : 'TIME LEFT') : 'DURATION'}</div>
            <div className="v">{fmtDuration(upcoming ? start - now : live && !isRace ? remaining : elapsed)}</div>
          </div>
          {pitLoss?.normal && (
            <div className="metric" title="Estimated time lost making a pit stop (MultiViewer). Under a safety car or virtual safety car the field is slower, so a stop costs less.">
              <div className="l">PIT LOSS</div>
              <div className="v">{Number(pitLoss.normal).toFixed(1)}<span className="u"> s</span></div>
              <div className="s">
                {pitLoss.sc ? `SC ${Number(pitLoss.sc).toFixed(1)} s` : ''}
                {pitLoss.sc && pitLoss.vsc ? ' · ' : ''}
                {pitLoss.vsc ? `VSC ${Number(pitLoss.vsc).toFixed(1)} s` : ''}
              </div>
            </div>
          )}
          <div className="metric">
            <div className="l">TRACK</div>
            <div className="v">{wx ? `${wx.track_temperature.toFixed(1)}°C` : '-'}</div>
          </div>
          <div className="metric">
            <div className="l">AIR</div>
            <div className="v">{wx ? `${wx.air_temperature.toFixed(1)}°C` : '-'}</div>
          </div>
          <div className="metric">
            <div className="l">HUMIDITY</div>
            <div className="v">{wx ? `${Math.round(wx.humidity)}%` : '-'}</div>
          </div>
          <div className="metric">
            <div className="l">WIND</div>
            <div className="v">
              {wx ? (
                <>
                  {(wx.wind_speed * 3.6).toFixed(1)}
                  <span className="u"> km/h </span>
                  <span className="wind-dir" title={`From ${wx.wind_direction}°`}>
                    <span style={{ display: 'inline-block', transform: `rotate(${wx.wind_direction + 180}deg)` }}>↑</span> {compass(wx.wind_direction)}
                  </span>
                </>
              ) : '-'}
            </div>
          </div>
          <div className="metric">
            <div className="l">RAIN</div>
            <div className="v" style={{ color: wx?.rainfall ? 'var(--pit-blue)' : undefined }}>{wx ? (wx.rainfall ? 'Yes' : 'No') : '-'}</div>
          </div>
          <div className="metric">
            <div className="l">STATUS</div>
            <div style={{ marginTop: 4 }}>
              {status ? (
                <span className={`pill tone-${status.tone}`} style={{ fontSize: 13 }}>
                  <span className="dot" />
                  {status.label}
                </span>
              ) : (
                <span className="muted">-</span>
              )}
            </div>
          </div>
        </div>
      </section>

      {hideSpoilers ? (
        <SpoilerCover what="Live timing and results" />
      ) : (
        <>
          {live && round?.Circuit.Location.lat && <RainWatch lat={round.Circuit.Location.lat} long={round.Circuit.Location.long} />}

      {t.error ? <ErrorBox error={t.error} what="live timing" /> : null}

      <div className="row top">
        <section className="card w3" style={{ padding: '16px 16px 8px' }} aria-labelledby="tower">
          <div className="card-head" style={{ padding: '0 8px' }}>
            <h2 className="h2" id="tower">
              Timing tower
            </h2>
            <div className="legend">
              <span><i className="sw" style={{ background: 'var(--purple)' }} />Overall best</span>
              <span><i className="sw" style={{ background: 'var(--green)' }} />Personal best</span>
              <span><i className="sw" style={{ background: 'var(--amber)' }} />Slower</span>
              <span><i className="sw" style={{ background: 'var(--pit-blue)' }} />Pit lane</span>
              {t.updatedAt && <span className="faint">Updated {fmtClock(new Date(t.updatedAt))}</span>}
            </div>
          </div>
          {t.loading ? <Loading rows={12} /> : t.rows.length === 0 ? <Empty>No timing data for this session yet.</Empty> : (
            <TimingTable rows={t.rows} isRace={isRace} live={live} upcoming={upcoming} fastest={t.fastest} favNum={favNum} team={favTeam} pitLoss={pitLoss} noCarData={t.source === 'f1'} year={session.year} quali={!isRace ? t.quali : null} neutral={status?.label === 'Safety car' ? 'sc' : status?.label === 'Virtual safety car' ? 'vsc' : null} />
          )}
        </section>
      </div>

      {live && isRace && !upcoming && round && (
        <LiveStandings season={String(session.year)} round={Number(round.round)} sprint={isSprint} rows={t.rows} favCode={fav?.code} favTeam={favTeam?.id} />
      )}

      {/practice/i.test(session.session_name) && !upcoming && (
        <section className="card tight" aria-labelledby="longruns">
          <div className="card-head">
            <h2 className="h2" id="longruns">Long-run pace</h2>
          </div>
          <LongRunPace laps={t.laps} stints={t.stints} drivers={t.driversByNumber} favNum={favNum} live={live} />
        </section>
      )}

      {isRace && !upcoming && (
        <section className="card tight" aria-labelledby="gaps">
          <div className="card-head">
            <h2 className="h2" id="gaps">Gap to leader</h2>
          </div>
          <GapChart laps={t.laps} drivers={t.driversByNumber} order={t.rows.map((r) => r.driver.driver_number)} favNum={favNum} />
        </section>
      )}

      {isRace && !upcoming && (
        <section className="card tight" aria-labelledby="positions">
          <div className="card-head">
            <h2 className="h2" id="positions">Positions lap by lap</h2>
          </div>
          <LivePositions session={session} live={live} sprint={isSprint} rows={t.rows} feed={t.positionTraces} distance={total ?? null} />
        </section>
      )}

      {isRace && !upcoming && (
        <section className="card tight" aria-labelledby="strategy">
          <div className="card-head">
            <h2 className="h2" id="strategy">Tyre strategy</h2>
          </div>
          <TyreStrategy
            stints={t.stints}
            drivers={t.rows.map((r) => ({ num: r.driver.driver_number, code: r.driver.name_acronym, colour: r.colour }))}
            totalLaps={total ?? null}
            currentLap={t.currentLap}
            favNum={favNum}
          />
        </section>
      )}

      <section className="card tight" aria-labelledby="map">
        <div className="card-head">
          <div>
            <h2 className="h2" id="map">Track map</h2>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{live ? 'Every car on track, moving live' : 'Replay where every car was during the session'} · tap a car for full stats</div>
          </div>
          <div className="legend">
            <span><i className="sw" style={{ background: '#f5c518' }} />Yellow flag</span>
            <span><i className="sw" style={{ background: '#ff9f1a' }} />Double yellow</span>
            <span><i className="sw" style={{ background: 'var(--amber)' }} />Safety car (dashed)</span>
            <span><i className="sw" style={{ background: 'var(--accent)' }} />Red flag</span>
          </div>
        </div>
        <LiveTrackMap session={session} live={live} drivers={[...t.driversByNumber.values()]} messages={t.messages} laps={t.laps} favNum={favNum} teamNums={teamNums} noPositions={t.source === 'f1'} />
      </section>

      <RadioPanel session={session} live={live} drivers={t.driversByNumber} favNum={favNum} teamNums={teamNums} laps={t.laps} feedClips={t.source === 'f1' ? t.radio : null} />
      {isRace && !upcoming && <PitStops pits={t.pits} drivers={t.driversByNumber} live={live} fromFeed={t.source === 'f1'} favNum={favNum} teamNums={teamNums} />}
      <FiaSection messages={t.messages} drivers={t.driversByNumber} favNum={favNum} team={favTeam} teamNums={teamNums} isRace={isRace} />
        </>
      )}
      <Footer />
    </>
  );
}

const PILL: Record<NonNullable<TimingRow['status']>, string> = { 'IN PIT': 'in', 'PIT OUT': 'pitout', STOP: 'stop', RETIRED: 'ret', DNS: 'ret', DSQ: 'ret' };
const PILL_TITLE: Record<NonNullable<TimingRow['status']>, string> = {
  'IN PIT': 'In the pit lane or garage',
  'PIT OUT': 'On an out-lap after leaving the pits',
  STOP: 'Stopped out on track (0 km/h)',
  RETIRED: 'Retired from the session',
  DNS: 'Did not start',
  DSQ: 'Disqualified',
};

const SEG: Record<number, string> = { 2048: 'yellow', 2049: 'green', 2051: 'purple', 2064: 'pit' };

/** Mini-sector bar: one block per timing loop, coloured like the official timing screens. */
function Segments({ segs }: { segs: (number | null)[] | null | undefined }) {
  if (!segs?.length) return <div className="segs" aria-hidden="true" />;
  return (
    <div className="segs" aria-hidden="true">
      {segs.map((v, i) => <i key={i} className={v ? SEG[v] ?? 'none' : 'none'} />)}
    </div>
  );
}

function TimingTable({ rows, isRace, live, upcoming, fastest, favNum, team, pitLoss, neutral, noCarData = false, year, quali = null }: { rows: TimingRow[]; year: number; quali?: QualiState | null; isRace: boolean; live: boolean; upcoming: boolean; fastest: number | null; favNum: number | null; team: FavouriteTeam | null; pitLoss?: { normal?: string; sc?: string; vsc?: string }; neutral: 'sc' | 'vsc' | null; noCarData?: boolean }) {
  // Where each car would rejoin if it pitted now: its gap to the leader plus the pit loss, placed among the other
  // cars' gaps. Under a safety car or VSC the field is slower, so the smaller neutralised loss applies.
  const loss = Number((neutral === 'sc' ? pitLoss?.sc : neutral === 'vsc' ? pitLoss?.vsc : pitLoss?.normal) ?? NaN);
  const showPit = live && isRace && !upcoming && Number.isFinite(loss);
  const gaps = rows.map((r, i) => ({ n: r.driver.driver_number, code: r.driver.name_acronym, g: i === 0 ? 0 : typeof r.gap === 'number' ? r.gap : null }));
  const rejoin = (i: number) => {
    const me = gaps[i];
    if (me.g == null || rows[i].status === 'IN PIT' || rows[i].status === 'RETIRED') return null;
    const t = me.g + loss;
    const others = gaps.filter((o, k) => k !== i && o.g != null) as { n: number; code: string; g: number }[];
    const ahead = others.filter((o) => o.g < t).sort((a, b) => b.g - a.g)[0];
    const behind = others.filter((o) => o.g >= t).sort((a, b) => a.g - b.g)[0];
    const pos = 1 + others.filter((o) => o.g < t).length;
    const traffic = (ahead && t - ahead.g < 1) || (behind && behind.g - t < 1);
    return { pos, ahead, behind, t, traffic: !!traffic };
  };
  // Before a race starts, the order is the starting grid and the gap column shows the qualifying lap.
  const onGrid = isRace && upcoming;
  // Qualifying knockout: Q1/Q2/Q3 columns, the drop zone while a part is running, and the cut lines.
  const q = qualiLayout(rows, quali);
  return (
    <div className="scroll-x">
      <table className="tbl timing" style={{ minWidth: isRace ? 960 : 880 }}>
        <thead>
          <tr>
            <th>{onGrid ? 'GRID' : 'POS'}</th>
            <th>DRIVER</th>
            <th className="r">{onGrid ? 'QUALI LAP' : isRace ? 'GAP' : 'GAP (BEST)'}</th>
            {isRace && <th className="r">INT</th>}
            <th>LAST LAP</th>
            {q ? [1, 2, 3].map((k) => <th key={k} className={`r${q.part === k ? ' q-now' : ''}`} title={`Best time in Q${k}`}>Q{k}</th>) : <th className="r">BEST</th>}
            <th className="r" title={live ? 'Lap in progress' : 'Latest lap'}><i className="sec-dot" style={{ background: 'var(--s1)' }} />SECTOR 1</th>
            <th className="r"><i className="sec-dot" style={{ background: 'var(--s2)' }} />SECTOR 2</th>
            <th className="r"><i className="sec-dot" style={{ background: 'var(--s3)' }} />SECTOR 3</th>
            <th>TYRES</th>
            {isRace && <th className="r" title="Places gained or lost against the starting grid">DIFF</th>}
            {showPit && <th title={`Where the car would rejoin if it pitted now (pit loss ${loss.toFixed(1)} s${neutral ? ` under ${neutral === 'sc' ? 'safety car' : 'VSC'}` : ''}). Lapped cars are left out.`}>PIT NOW</th>}
            {!noCarData && <th className="r" title="Current speed. Shows 0 when there is no live data.">SPEED</th>}
            {!noCarData && <th>PEDALS</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const gap = q ? q.gap(r) : onGrid ? fmtLap(r.gridLap) : isRace ? (i === 0 ? 'Leader' : fmtGap(r.gap)) : r.bestLap != null && fastest != null ? (i === 0 ? 'Fastest' : `+${(r.bestLap - fastest).toFixed(3)}`) : '-';
            const l = r.lastLap;
            const c = r.currentLap;
            const isTeam = team?.codes.has(r.driver.name_acronym);
            // Live car data only; with none (no live session, or nothing received yet) the car shows 0.
            const tel = live ? r.car : undefined;
            const speed = tel?.speed ?? 0;
            return (
              <tr key={r.driver.driver_number} className={[favNum === r.driver.driver_number ? 'fav' : '', isTeam ? 'team' : '', r.status === 'IN PIT' ? 'in-pit' : '', r.status === 'RETIRED' || r.status === 'DNS' || r.status === 'DSQ' || r.quali?.out ? 'out' : '', q ? q.rowClass(r) : ''].join(' ').trim() || undefined} style={isTeam ? ({ '--team': team!.colour } as React.CSSProperties) : undefined}>
                <td className="mono muted">{r.position ?? '-'}</td>
                <td>
                  <div className="who">
                    <span className="team-bar" style={{ height: 20, background: r.colour }} />
                    <a className="code name-link" style={{ fontWeight: 700 }} href={driverHref(r.driver.name_acronym)} title={`${r.driver.name_acronym}: full stats`}>{r.driver.name_acronym}</a>
                    <span className="faint" style={{ fontSize: 11 }}>{r.driver.driver_number}</span>
                    {favNum === r.driver.driver_number && <span className="fav-star" role="img" aria-label="Favourite"><StarIcon filled size={14} /></span>}
                  </div>
                </td>
                <td className="r mono">{gap}</td>
                {isRace && <td className="r mono muted">{i > 0 && !onGrid ? fmtGap(r.interval) : '-'}</td>}
                <td>
                  {r.quali?.out && r.status !== 'DSQ' ? (
                    // Knocked out cars sit in the garage, so this beats IN PIT.
                    <span className="pit-pill knocked" title={`Knocked out in Q${r.quali.out}`}>OUT Q{r.quali.out}</span>
                  ) : r.status ? (
                    <span className={`pit-pill ${PILL[r.status]}`} title={PILL_TITLE[r.status]}>{r.status}</span>
                  ) : (
                    l && l.lap_duration == null && l.is_pit_out_lap ? (
                    <span className="lap-pill tone-none faint" title="First lap out of the garage: no lap time">Out lap</span>
                  ) : (
                    <span className={`lap-pill tone-${r.lastLapTone === 'slower' ? 'none' : r.lastLapTone}`}>{fmtLap(l?.lap_duration)}</span>
                  )
                  )}
                </td>
                {q ? (
                  [0, 1, 2].map((k) => {
                    const v = r.quali?.times[k] ?? null;
                    return (
                      <td key={k} className="r">
                        {v != null && v === q.fastest[k] ? <span className="lap-pill best" title={`Fastest in Q${k + 1}`}>{fmtLap(v)}</span> : <span className={`mono${v == null ? ' faint' : ''}`}>{v != null ? fmtLap(v) : '-'}</span>}
                      </td>
                    );
                  })
                ) : (
                  <td className="r">
                    {r.bestLap != null && fastest != null && r.bestLap === fastest ? (
                      <span className="lap-pill best" title="Fastest lap of the session">{fmtLap(r.bestLap)}</span>
                    ) : (
                      <span className="mono">{fmtLap(r.bestLap)}</span>
                    )}
                  </td>
                )}
                {[1, 2, 3].map((k) => {
                  const dur = c ? [c.duration_sector_1, c.duration_sector_2, c.duration_sector_3][k - 1] : null;
                  const segs = c ? [c.segments_sector_1, c.segments_sector_2, c.segments_sector_3][k - 1] : null;
                  return (
                    <td key={k} className="r sector-cell">
                      <div className={`mono tone-${r.currentSectorTone[k - 1]}`}>{dur != null ? fmtSector(dur) : '\u00a0'}</div>
                      <Segments segs={segs} />
                    </td>
                  );
                })}
                <td>
                  <div className="tyre-hist">
                    {r.stints.length === 0 && <span className="faint">-</span>}
                    {r.stints.map((st, k) => {
                      const ty = tyre(st.compound);
                      const now = k === r.stints.length - 1;
                      // Tyre age when it came off (or now, for the current set), counting laps it had before this stint.
                      const age = now ? r.tyreAge : (st.tyre_age_at_start ?? 0) + Math.max(0, (st.lap_end ?? 0) - (st.lap_start ?? 0) + 1);
                      return (
                        <span key={st.stint_number} className={`stint${now ? ' now' : ''}`} title={`${now ? 'Now' : 'Earlier'}: ${ty.name}, ${age ?? '?'} laps old${st.lap_start ? `, from lap ${st.lap_start}` : ''}`}>
                          <span className="mono">{age ?? '-'}</span>
                          <span className="tyre" style={{ borderColor: ty.colour }}>{ty.letter}</span>
                        </span>
                      );
                    })}
                  </div>
                </td>
                {isRace && (
                  <td className="r">
                    {onGrid || r.grid == null || r.position == null ? (
                      <span className="faint">-</span>
                    ) : (
                      <span className={`diff ${r.grid - r.position > 0 ? 'up' : r.grid - r.position < 0 ? 'down' : ''}`} title={`Started P${r.grid}, now P${r.position}`}>
                        {r.grid - r.position > 0 ? `↑${r.grid - r.position}` : r.grid - r.position < 0 ? `↓${r.position - r.grid}` : '–0'}
                      </span>
                    )}
                  </td>
                )}
                {showPit && (
                  <td>
                    {(() => {
                      const p = rejoin(i);
                      if (!p) return <span className="faint">-</span>;
                      return (
                        <span
                          className={`pit-now${p.traffic ? ' traffic' : ''}`}
                          title={`Would rejoin P${p.pos}${p.ahead ? `, ${(p.t - p.ahead.g).toFixed(1)} s behind ${p.ahead.code}` : ' in the lead'}${p.traffic ? ', within a second of another car (traffic)' : ''}`}
                        >
                          <b className="mono">P{p.pos}</b>
                          <span className="muted">{p.ahead ? ` · ${p.ahead.code} +${(p.t - p.ahead.g).toFixed(1)}` : ' · lead'}</span>
                          {p.traffic && <span className="pit-warn" aria-label="traffic"> ⚠</span>}
                        </span>
                      );
                    })()}
                  </td>
                )}
                {!noCarData && (
                  <td className="r mono">
                    {(() => {
                      const aid = overtakeAid(tel, year);
                      return aid && <span className={`drs ${aid.state}`} title={aid.title}>{aid.label}</span>;
                    })()}
                    {speed}<span className="faint" style={{ fontSize: 11 }}> km/h</span>
                  </td>
                )}
                {!noCarData && (
                  <td>
                    <div className="pedals" title={tel ? `Throttle ${tel.throttle}%, brake ${tel.brake ? 'on' : 'off'}` : 'No live car data'}>
                      <i className="thr"><b style={{ width: `${Math.max(0, Math.min(100, tel?.throttle ?? 0))}%` }} /></i>
                      <i className="brk"><b style={{ width: `${tel?.brake ? 100 : 0}%` }} /></i>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** FIA feed: messages shown at first (laptop, phone) and added by each Show more. */
const FIA_FIRST = 8;
const FIA_FIRST_PHONE = 5;
const FIA_STEP = 10;

function FiaSection({ messages, drivers, favNum, team, teamNums, isRace }: { messages: ClassifiedMsg[]; drivers: Map<number, OF1Driver>; favNum: number | null; team: FavouriteTeam | null; teamNums: number[]; isRace: boolean }) {
  const [tab, setTab] = useState<MsgTab>('All');
  const [driver, setDriver] = useState<number | 0>(0);
  // driver -1 means "the favourite team's cars".
  const byDriver = driver === -1 ? messages.filter((m) => m.cars.some((c) => teamNums.includes(c))) : driver ? messages.filter((m) => m.cars.includes(driver)) : messages;
  const [showMinor, setShowMinor] = useState(false);
  // Routine sector and blue flags crowd out the important messages, so All hides them unless asked.
  const minor = tab === 'All' ? byDriver.filter(isMinor).length : 0;
  const shown = tab === 'All' ? byDriver.filter((m) => showMinor || !isMinor(m)) : byDriver.filter((m) => m.tab === tab);
  // The full feed makes the page very long, so it starts with the newest few; Show more adds the next batch.
  const phone = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 599px)').matches;
  const first = phone ? FIA_FIRST_PHONE : FIA_FIRST;
  // A different category or driver starts from the newest few again.
  const view = `${tab}|${driver}|${showMinor}`;
  const [more, setMore] = useState({ view, limit: first });
  const limit = more.view === view ? Math.max(more.limit, first) : first;
  const setLimit = (n: number) => setMore({ view, limit: n });
  const visible = shown.slice(0, limit);
  const fiaHead = useRef<HTMLHeadingElement>(null);
  const penalties = summarisePenalties(messages);
  const limits = summariseTrackLimits(messages);
  const open = openInvestigations(messages);
  const code = (n: number) => drivers.get(n)?.name_acronym ?? `#${n}`;
  const colour = (n: number) => {
    const d = drivers.get(n);
    return teamColour(d?.team_name, d?.team_colour);
  };
  const involved = [...new Set(messages.flatMap((m) => m.cars))].sort((a, b) => code(a).localeCompare(code(b)));

  return (
    <div className="row top">
      <section className="card tight w3" aria-labelledby="fia">
        <div className="card-head">
          <div>
            <h2 className="h2" id="fia" ref={fiaHead}>FIA race control and stewards</h2>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>Every official message for this session, newest first</div>
          </div>
          <label className="field">
            Driver
            <select className="select" value={driver} onChange={(e) => setDriver(Number(e.target.value))}>
              <option value={0}>All drivers</option>
              {involved.map((n) => (
                <option key={n} value={n}>{code(n)}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="tabs" role="tablist" aria-label="Message type">
          {TABS.map((tb) => (
            <button key={tb} role="tab" className="tab" aria-selected={tab === tb} onClick={() => setTab(tb)}>
              {tb}
              <span className="n">{tb === 'All' ? (showMinor ? byDriver.length : byDriver.filter((m) => !isMinor(m)).length) : byDriver.filter((m) => m.tab === tb).length}</span>
            </button>
          ))}
        </div>
        {(favNum != null || (team && teamNums.length > 0)) && (
          <div className="tabs">
            {favNum != null && (
              <button className="tab fav-toggle" aria-pressed={driver === favNum} onClick={() => setDriver(driver === favNum ? 0 : favNum)}>
                ★ {code(favNum)} only
              </button>
            )}
            {team && teamNums.length > 0 && (
              <button className="tab team-toggle" style={{ '--team': team.colour } as React.CSSProperties} aria-pressed={driver === -1} onClick={() => setDriver(driver === -1 ? 0 : -1)}>
                <FlagIcon filled size={14} /> {team.name} only
              </button>
            )}
          </div>
        )}
        {minor > 0 && (
          <div className="minor-note muted">
            {showMinor ? 'Showing' : 'Hiding'} {minor} routine sector and blue flag message{minor === 1 ? '' : 's'}.{' '}
            <button className="link-btn" onClick={() => setShowMinor(!showMinor)}>{showMinor ? 'Hide them' : 'Show them'}</button>
          </div>
        )}
        {shown.length === 0 ? (
          <Empty>No messages in this category.</Empty>
        ) : (
          <div role="log" aria-live="polite" aria-label="Race control messages">
            {visible.map((m) => (
              <div className={favNum != null && m.cars.includes(favNum) ? 'msg fav' : 'msg'} key={m.id}>
                <FiaWhen m={m} />
                <span className={`badge tone-${m.tone}`}>{m.label}</span>
                <FiaText m={m} codeOf={code}>
                  {m.cars.length > 0 && (
                    <div className="chips">
                      {m.cars.map((c) => (
                        drivers.get(c) ? (
                          <a className="chip chip-link" key={c} href={driverHref(code(c))} title={`${code(c)}: full stats`}><i style={{ background: colour(c) }} />{code(c)}</a>
                        ) : (
                          <span className="chip" key={c}><i style={{ background: colour(c) }} />{code(c)}</span>
                        )
                      ))}
                    </div>
                  )}
                </FiaText>
              </div>
            ))}
            {shown.length > first && (
              <div className="more-row">
                <span className="muted">Showing {visible.length} of {shown.length}</span>
                {visible.length < shown.length && (
                  <button className="tab" onClick={() => setLimit(limit + FIA_STEP)}>
                    Show {Math.min(FIA_STEP, shown.length - visible.length)} more
                  </button>
                )}
                {limit > first && (
                  <button
                    className="tab"
                    onClick={() => {
                      setLimit(first);
                      fiaHead.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    }}
                  >
                    Show less
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <div className="col w1">
        <section className="card tight" aria-labelledby="pens">
          <h2 className="h2 sm" id="pens" style={{ marginBottom: 12 }}>Penalties this session</h2>
          {penalties.length === 0 ? <Empty>No penalties so far.</Empty> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {penalties.map((p, i) => (
                <div className="inset" style={{ padding: 12 }} key={`${p.car}-${i}`}>
                  <div className="who">
                    <span className="team-bar" style={{ height: 20, background: colour(p.car) }} />
                    <span className="code">{code(p.car)}</span>
                    <span className="mono" style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--red-soft)' }}>{p.penalty}</span>
                  </div>
                  {(p.reason || p.lap) && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                      {p.reason}
                      {p.lap ? `${p.reason ? ' · ' : ''}Lap ${p.lap}` : ''}
                    </div>
                  )}
                  <div style={{ fontSize: 12, marginTop: 6, color: p.served ? 'var(--green)' : 'var(--amber)' }}>
                    {p.served ? 'Marked as served' : 'Not marked as served yet'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <TrackLimitsPanel limits={limits} penalties={penalties} drivers={drivers} isRace={isRace} favNum={favNum} />
        <InvestigationsPanel open={open} drivers={drivers} />
      </div>
    </div>
  );
}

/** Team radio for the whole session. */
function RadioPanel({ session, live, drivers, favNum, teamNums, laps, feedClips }: { session: Session; live: boolean; drivers: Map<number, OF1Driver>; favNum: number | null; teamNums: number[]; laps: Lap[]; feedClips: TeamRadio[] | null }) {
  const sk = session.session_key;
  const [who, setWho] = useState<number>(0);
  const polled = usePoll<TeamRadio[]>(feedClips ? null : `radio-all-${sk}-${live}`, (_p, signal) => openf1<TeamRadio>('team_radio', { session_key: sk }, signal), live ? liveEvery(60_000) : 0, 1_500);
  // From F1's live feed while OpenF1 is paused.
  const radio = feedClips ? { data: feedClips, error: null, loading: false } : polled;
  const labels = new Map<number, DriverLabel>([...drivers.values()].map((d) => [d.driver_number, { code: d.name_acronym, colour: teamColour(d.team_name, d.team_colour) }]));
  const clips = (radio.data ?? []).filter((c) => (who === -1 ? teamNums.includes(c.driver_number) : who ? c.driver_number === who : true));
  const withRadio = [...new Set((radio.data ?? []).map((c) => c.driver_number))].sort((a, b) => (labels.get(a)?.code ?? '').localeCompare(labels.get(b)?.code ?? ''));
  return (
    <section className="card tight" aria-labelledby="radio">
      <div className="card-head">
        <h2 className="h2" id="radio">Team radio</h2>
        <label className="field">
          Driver
          <select className="select" value={who} onChange={(e) => setWho(Number(e.target.value))}>
            <option value={0}>All drivers</option>
            {favNum != null && <option value={favNum}>★ {labels.get(favNum)?.code}</option>}
            {teamNums.length > 0 && <option value={-1}>⚑ My team</option>}
            {withRadio.map((n) => (
              <option key={n} value={n}>{labels.get(n)?.code ?? n}</option>
            ))}
          </select>
        </label>
      </div>
      {radio.error ? <ErrorBox error={radio.error} what="team radio" /> : radio.loading ? <Loading rows={3} /> : <RadioCards clips={clips} drivers={drivers} favNum={favNum} teamNums={teamNums} laps={laps} limit={8} />}
    </section>
  );
}

/**
 * Lap-by-lap positions on the Live Timing page. Live without an OpenF1 token they come from F1's LapSeries topic
 * (complete from the first lap); after the session from OpenF1, as on the race page.
 */
function LivePositions({ session, live, sprint, rows, feed, distance }: { session: Session; live: boolean; sprint: boolean; rows: TimingRow[]; feed: { laps: number; traces: { driver: number; positions: (number | null)[] }[] } | null; distance: number | null }) {
  const fromOpenF1 = useQuery({
    queryKey: ['race-positions', session.meeting_key, sprint],
    enabled: !feed && !live,
    staleTime: Infinity,
    queryFn: ({ signal }) => getRacePositions(session.meeting_key, sprint, signal),
  });
  const info = useMemo(() => {
    const seen = new Set<string>();
    const m = new Map<number, LineInfo>();
    rows.forEach((r, i) => {
      const team = r.driver.team_name ?? r.driver.name_acronym;
      const dashed = seen.has(team);
      seen.add(team);
      m.set(r.driver.driver_number, { code: r.driver.name_acronym, colour: r.colour, dashed, finish: r.position ?? i + 1 });
    });
    return m;
  }, [rows]);
  const data = feed ?? fromOpenF1.data;
  if (!data) {
    if (live) return <Empty>Lap-by-lap positions appear here after the session.</Empty>;
    if (fromOpenF1.error) return <ErrorBox error={fromOpenF1.error} what="lap-by-lap positions" />;
    return fromOpenF1.isLoading ? <Loading rows={4} /> : <Empty>Lap-by-lap positions are not available for this session.</Empty>;
  }
  return (
    <PositionLines
      laps={data.laps}
      traces={data.traces}
      info={info}
      distance={live ? distance : null}
      note={feed
        ? "Live, from Formula 1's lap-by-lap positions: complete from the start, whenever you opened the page. Team-mates share a colour; the second car's line is dashed. Lines that stop early are retirements."
        : "Position at the end of each lap, from OpenF1. Team-mates share a colour; the second car's line is dashed. Lines that stop early are retirements. These are positions on track, so post-race penalties are not reflected."}
    />
  );
}

/**
 * Every pit stop with its stationary time and time in the pit lane (OpenF1). OpenF1 may only fill in stationary times a
 * few hours after a 2026 session; F1's free live feed has no pit times at all.
 */
function PitStops({ pits, drivers, live, fromFeed, favNum, teamNums }: { pits: PitDetail[]; drivers: Map<number, OF1Driver>; live: boolean; fromFeed: boolean; favNum: number | null; teamNums: number[] }) {
  const [all, setAll] = useState(false);
  const stops = [...pits].sort((a, b) => b.lap_number - a.lap_number || b.date.localeCompare(a.date));
  const lane = (p: PitDetail) => p.lane_duration ?? p.pit_duration ?? null;
  const stationary = stops.map((p) => p.stop_duration).filter((v): v is number => v != null && v > 0);
  const fastest = stationary.length ? Math.min(...stationary) : null;
  const fastestStop = fastest != null ? stops.find((p) => p.stop_duration === fastest) : undefined;
  const shown = all ? stops : stops.slice(0, 10);
  const quickestLane = stops.filter((p) => lane(p) != null).sort((a, b) => lane(a)! - lane(b)!)[0];
  const code = (n: number) => drivers.get(n)?.name_acronym ?? `#${n}`;
  const colour = (n: number) => {
    const d = drivers.get(n);
    return teamColour(d?.team_name, d?.team_colour);
  };
  return (
    <section className="card tight" aria-labelledby="pitstops">
      <div className="card-head">
        <h2 className="h2" id="pitstops">Pit stops</h2>
        {!fastestStop && quickestLane && (
          <span className="muted">
            Quickest pit lane <b className="mono">{lane(quickestLane)!.toFixed(1)} s</b> · {code(quickestLane.driver_number)}, lap {quickestLane.lap_number}
          </span>
        )}
        {fastestStop && fastest != null && (
          <span className="muted">
            Fastest stop <b className="mono" style={{ color: 'var(--purple)' }}>{fastest.toFixed(1)} s</b> · {code(fastestStop.driver_number)}, lap {fastestStop.lap_number}
          </span>
        )}
      </div>
      {stops.length === 0 ? (
        <Empty>{live ? 'No pit stops yet.' : 'No pit stops recorded for this session.'}</Empty>
      ) : (
        <>
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Lap</th>
                  <th>Driver</th>
                  <th className="r" title="Time the car stood still in the pit box">Stationary</th>
                  <th className="r" title="Time from pit entry to pit exit">Pit lane</th>
                  <th className="r">Stop</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const n = stops.filter((x) => x.driver_number === p.driver_number && x.lap_number <= p.lap_number).length;
                  const isFast = fastest != null && p.stop_duration === fastest;
                  return (
                    <tr key={`${p.driver_number}-${p.lap_number}-${p.date}`} className={p.driver_number === favNum ? 'fav' : teamNums.includes(p.driver_number) ? 'team' : undefined} style={{ '--team': colour(p.driver_number) } as React.CSSProperties}>
                      <td className="mono muted">{p.lap_number}</td>
                      <td>
                        <div className="who">
                          <span className="team-bar" style={{ background: colour(p.driver_number) }} />
                          <span className="code">{code(p.driver_number)}</span>
                        </div>
                      </td>
                      <td className="r mono">
                        {p.stop_duration != null && p.stop_duration > 0 ? (
                          <span className={isFast ? 'lap-pill best' : undefined} title={isFast ? 'Fastest stop of the session' : undefined}>{p.stop_duration.toFixed(1)} s</span>
                        ) : (
                          <span className="faint" title={fromFeed ? "Not in Formula 1's free feed: it arrives from OpenF1 after the session" : 'OpenF1 usually adds stationary times a few hours after the session'}>later</span>
                        )}
                      </td>
                      <td className="r mono muted">{lane(p) != null ? `${lane(p)!.toFixed(1)} s` : '-'}</td>
                      <td className="r mono muted">{n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {stops.length > 10 && (
            <button className="tab" style={{ marginTop: 10 }} onClick={() => setAll(!all)}>{all ? 'Show latest 10' : `Show all ${stops.length} stops`}</button>
          )}
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
            {fromFeed
              ? "Newest first. Pit lane is entry to exit, the time a stop really costs, live from Formula 1's feed. The feed only repeats each driver's latest stop, so earlier stops made before you opened Pit Wall are missing until OpenF1 has the full list, about 30 minutes after the session, with the stationary times."
              : 'Newest first. Stationary is the time standing still in the box; pit lane is entry to exit, the time a stop really costs. From OpenF1, which may add stationary times a few hours after the session.'}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Qualifying knockout layout. While a part runs, the cars outside the places that go through to the next part are in
 * the drop zone, and the cut-off is the time of the last car through. Once finished, lines mark where Q1 and Q2 cut.
 */
function qualiLayout(rows: TimingRow[], quali: QualiState | null) {
  if (!quali || !rows.some((r) => r.quali)) return null;
  const fastest = [0, 1, 2].map((k) => {
    const v = rows.map((r) => r.quali?.times[k]).filter((x): x is number => x != null);
    return v.length ? Math.min(...v) : null;
  });
  const part = quali.part;
  // Places that go through from the running part: the number of cars in the next part (none after Q3).
  const through = part != null && part < 3 ? quali.entries[part] ?? null : null;
  const inPart = (r: TimingRow) => !r.quali?.out;
  const dangerFrom = through != null ? through + 1 : null;
  // Cut-off: the time of the last car currently through, in the running part.
  const ranked = part != null ? rows.filter(inPart).map((r) => r.quali?.times[part - 1]).filter((x): x is number => x != null).sort((a, b) => a - b) : [];
  const cutoff = through != null && ranked.length >= through ? ranked[through - 1] : null;
  const gap = (r: TimingRow): string => {
    const t = r.quali?.times;
    if (!t) return '-';
    // Live: against the fastest in the running part. Finished (or knocked out): in the last part the driver ran.
    const k = part != null && !r.quali?.out ? part - 1 : (r.quali?.out ?? (t[2] != null ? 3 : t[1] != null ? 2 : 1)) - 1;
    const v = t[k];
    const best = fastest[k];
    if (v == null || best == null) return '-';
    return v === best ? `Fastest Q${k + 1}` : `+${(v - best).toFixed(3)}`;
  };
  const rowClass = (r: TimingRow): string => {
    const pos = r.position ?? 99;
    if (part != null && dangerFrom != null && inPart(r)) {
      if (pos >= dangerFrom) return pos === dangerFrom ? 'q-drop q-cut' : 'q-drop';
      return '';
    }
    if (part == null) {
      // Finished: a line under the last car into Q2 and the last car into Q3.
      if (pos === quali.entries[1] || pos === quali.entries[2]) return 'q-line';
    }
    return '';
  };
  return { part, fastest, cutoff, through, gap, rowClass };
}
