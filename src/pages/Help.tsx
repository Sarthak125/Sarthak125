import type { ReactNode } from 'react';
import { Footer } from '../components/Shell';
import { href } from '../lib/router';
import { TYRE } from '../lib/teams';

const SECTIONS = [
  { id: 'start', label: 'Getting started' },
  { id: 'raceday', label: 'On race day' },
  { id: 'reading', label: 'Reading Live Timing' },
  { id: 'later', label: 'Watching later' },
  { id: 'planning', label: 'Planning ahead' },
  { id: 'faq', label: 'Questions' },
];

/** Jumps within the page without touching the hash, which holds the route. */
function jump(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * How to use Pit Wall: a guide to the features that are not obvious at first glance, with small examples drawn in the
 * same styles the app uses, so what you read here looks like what you will see.
 */
export function Help() {
  return (
    <>
      <section className="card help-intro">
        <h1 className="h2">How to use Pit Wall</h1>
        <p className="muted">
          Pit Wall follows Formula 1 live and between races: timing, the track map, FIA decisions, standings, the calendar and your favourite driver
          and team. This page explains the parts that are not obvious at first glance.
        </p>
        <nav className="help-toc" aria-label="On this page">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className="tab" onClick={() => jump(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
      </section>

      <Section id="start" title="Getting started">
        <Steps>
          <Step n={1} title="Pick your favourite driver">
            Tap the ☆ on the <a className="help-link" href={href('drivers')}>Drivers</a> page, or choose one in{' '}
            <a className="help-link" href={href('settings')}>Settings</a>. They are highlighted in gold across the app, and the Favourites tab
            follows them: stats, results, team radio, and a live section during sessions.
          </Step>
          <Step n={2} title="Pick your favourite team">
            Tap the ⚑ next to a team in the Constructors' table on <a className="help-link" href={href('standings')}>Standings</a>, or choose
            one in Settings. Its drivers are tinted in the tables and Live Timing, and it gets a Team tab under Favourites.
          </Step>
          <Step n={3} title="Install it like an app">
            In Chrome on Android, open the ⋮ menu and choose <b>Install app</b> (or <b>Add to Home screen</b>), or get the{' '}
            <button type="button" className="link-btn" style={{ padding: 0 }} onClick={() => jump('android')}>Android app</button> below. On a laptop, Chrome and
            Edge show an install button in the address bar. It then opens full screen and works offline with the last data it loaded.
          </Step>
          <Step n={4} title="Turn on alerts">
            While a session is live, pop-ups tell you when your favourite driver changes position, pits or gets an FIA decision. Device
            notifications can be switched on in Settings; they arrive while the app is open or in the background, not after it is closed.
          </Step>
        </Steps>
        <div className="help-android" id="android">
          <div>
            <h3 className="help-h3" style={{ marginTop: 0 }}>Android app</h3>
            <p>
              Pit Wall is also a small Android app (about 1 MB, Android 7 or newer). It opens the same site full screen, so it always has the latest
              features. It is not on the Play Store, so Android asks you to allow installs from your browser the first time.
            </p>
            <ol className="help-list">
              <li>Tap <b>Download for Android</b> on your phone and open the file.</li>
              <li>If asked, allow <b>Install unknown apps</b> for your browser, then tap <b>Install</b>.</li>
              <li>Open <b>Pit Wall</b> from your home screen. It needs Chrome (or another browser that supports it) installed.</li>
            </ol>
          </div>
          <a className="btn primary help-download" href={`${import.meta.env.BASE_URL}pit-wall.apk`} download="pit-wall.apk">
            Download for Android
            <span>APK · version 1.0.0</span>
          </a>
        </div>
      </Section>

      <Section id="raceday" title="On race day">
        <p>
          When a session starts, the Dashboard shows a red <b>LIVE</b> banner and the Live Timing menu item gets a red dot. Open{' '}
          <a className="help-link" href={href('live')}>Live Timing</a> and pick the session from the list under its name.
        </p>
        <h3 className="help-h3">Where the live data comes from</h3>
        <p>
          OpenF1, the free source used most of the time, is limited to paying supporters while a session is live. So during a session Pit Wall
          reads Formula 1's own live timing feed instead, and a blue note at the top of Live Timing says so. A pill next to LIVE shows how that
          connection is doing:
        </p>
        <div className="help-grid">
          <Example demo={<span className="feed-status ok"><i className="feed-status-dot" />F1 feed live</span>}>Connected and data is arriving.</Example>
          <Example demo={<span className="feed-status warn"><i className="feed-status-dot" />No updates for 1 min</span>}>
            Still connected but nothing new. Normal during a red flag or a break.
          </Example>
          <Example demo={<span className="feed-status bad"><i className="feed-status-dot" />Reconnecting in 6 s</span>}>
            The connection dropped. It tries again by itself; <b>Retry now</b> tries straight away. The last timing stays on screen.
          </Example>
          <Example demo={<span className="feed-status bad"><i className="feed-status-dot" />Offline</span>}>Your device has no internet.</Example>
        </div>
        <ul className="help-list">
          <li>
            <b>Not in the free feed:</b> live car positions on the track map, car speed and pedals, and how long a car stood still in its pit
            box need an F1 TV subscription. They fill in from OpenF1 about 30 minutes after the session. Pit lane times (entry to exit) are in
            the free feed and show live.
          </li>
          <li>
            <b>Reloading is safe:</b> laps recorded so far are kept on your device, so the gap chart and sector colours carry on after a reload
            or a dropped connection.
          </li>
          <li>
            <b>Ahead of your TV?</b> F1's feed is usually 30 to 60 seconds ahead of the broadcast. See <i>TV delay</i> under{' '}
            <button type="button" className="link-btn" onClick={() => jump('later')}>Watching later</button>.
          </li>
        </ul>
      </Section>

      <Section id="reading" title="Reading Live Timing">
        <h3 className="help-h3">Colours</h3>
        <div className="help-grid">
          <Example
            demo={
              <span className="segs help-segs" aria-hidden="true">
                <i className="yellow" />
                <i className="green" />
                <i className="purple" />
                <i className="pit" />
              </span>
            }
          >
            <b>Mini-sector bars</b> under each sector time: yellow, green for a personal best, purple for the fastest of anyone, blue in the pit
            lane.
          </Example>
          <Example
            demo={
              <span className="help-swatches" aria-hidden="true">
                <i style={{ background: 'var(--s1)' }}>S1</i>
                <i style={{ background: 'var(--s2)' }}>S2</i>
                <i style={{ background: 'var(--s3)' }}>S3</i>
              </span>
            }
          >
            <b>The three sectors</b> on the track map and in the table headings: S1 red, S2 light blue, S3 yellow.
          </Example>
          <Example demo={<span className="lap-pill best">1:33.112</span>}>
            <b>Purple lap</b>: the fastest lap of the session.
          </Example>
          <Example
            demo={
              <span className="help-swatches" aria-hidden="true">
                {(['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'] as const).map((k) => (
                  <i key={k} style={{ background: TYRE[k].colour, color: k === 'MEDIUM' || k === 'HARD' ? '#111' : '#fff' }}>{TYRE[k].letter}</i>
                ))}
              </span>
            }
          >
            <b>Tyres</b>: soft, medium, hard, intermediate and wet. "3 S 33 M" in the tower means 3 laps on softs, then 33 on mediums (current
            set in bold).
          </Example>
        </div>

        <h3 className="help-h3">Tags and columns</h3>
        <dl className="help-dl">
          <dt>IN PIT · PIT OUT</dt>
          <dd>The car is in the pit lane, or has just left it.</dd>
          <dt>STOP · RETIRED</dt>
          <dd>Stopped out on track, or out of the session (also DNS and DSQ from the official classification).</dd>
          <dt>DIFF</dt>
          <dd>Places gained (green ↑) or lost (red ↓) since the start.</dd>
          <dt>PIT NOW</dt>
          <dd>
            Where the car would rejoin if it pitted this lap, for example "P7 · HAM +1.7". Amber with ⚠ means it would come out in traffic. A guide,
            not a prediction: it ignores slow stops and tyre warm-up.
          </dd>
          <dt>Championship if it ended now</dt>
          <dd>During races and sprints, the standings recalculated from the current order.</dd>
        </dl>

        <h3 className="help-h3">Qualifying</h3>
        <p>
          The tower gets Q1, Q2 and Q3 columns. <b>PART</b> in the session bar shows which part is running and how many cars go through;{' '}
          <b>CUT-OFF</b> is the time of the last car currently through. Cars in the shaded <b>drop zone</b> below the red line are out if nothing
          changes, and knocked-out drivers are dimmed with an <span className="pit-pill knocked">OUT Q1</span> or{' '}
          <span className="pit-pill knocked">OUT Q2</span> tag.
        </p>

        <h3 className="help-h3">Practice</h3>
        <p>
          <b>Long-run pace</b> shows each driver's longest run on one set of tyres: average lap and how much time they lost per lap. It is the usual
          guide to race pace, since the fastest single laps are set on low fuel. Fuel loads are not published, so compare teams with care.
        </p>

        <h3 className="help-h3">Charts in races</h3>
        <ul className="help-list">
          <li><b>Gap to leader</b> and <b>Positions lap by lap</b>: top 10 by default, with a button for everyone. Hover or tap for every value on that lap.</li>
          <li><b>Tyre strategy</b>: each stint as a bar in its tyre colour. Gaps between bars are pit stops; striped bars are used sets. Tap a bar for its laps and the tyre's age.</li>
          <li><b>Pit stops</b>: stationary time and pit lane time for every stop, the fastest in purple.</li>
          <li><b>Track map</b>: tap a car to open that driver's page. For finished sessions, the replay bar lets you scrub through the session.</li>
        </ul>
      </Section>

      <Section id="later" title="Watching later or on TV">
        <Steps>
          <Step n={1} title="TV delay">
            Pick a delay (10 to 120 seconds) on Live Timing or in Settings, and live timing is held back by that much, so overtakes and flags
            appear when you see them on TV. A <span className="delay-pill">Delayed 30 s</span> pill reminds you it is on.
          </Step>
          <Step n={2} title="Spoiler-free mode">
            Turn it on in Settings and the latest race weekend stays hidden until you press <b>Reveal</b>: its sessions on Live Timing, its race page,
            the last race card, and the standings once the sprint or race has started. Alerts pause too. When the next weekend starts, it moves on to
            that one.
          </Step>
        </Steps>
      </Section>

      <Section id="planning" title="Planning ahead">
        <ul className="help-list">
          <li>
            <b>Add to calendar</b>: buttons on the Dashboard's next race card, upcoming race pages and the{' '}
            <a className="help-link" href={href('calendar')}>Calendar</a> download the sessions for Google Calendar, Apple Calendar or Outlook, in
            your own time zone. If a session moves, download it again.
          </li>
          <li><b>Race pages</b> (tap any race name): circuit map and history, weekend weather forecast, results, and charts for finished races.</li>
          <li><b>Rain watch</b>: during a live session, whether rain is expected at the circuit in the next 2 hours.</li>
          <li>
            <b>Season review</b>: <a className="help-link" href={href('review')}>the season in numbers</a> (also linked from Standings): champions,
            highlights, every driver's and team's record, and the team-mate battles. It follows the season picker.
          </li>
          <li><b>Other seasons</b>: the Season picker at the top switches standings, results and the calendar to earlier years.</li>
        </ul>
      </Section>

      <Section id="faq" title="Questions">
        <dl className="help-dl faq">
          <dt>A page says OpenF1 is paused. What does that mean?</dt>
          <dd>
            OpenF1 serves only paying supporters from 30 minutes before a session until 30 minutes after it. Live Timing reads F1's own feed in that
            window; if that is unavailable too, pages show when free access returns and fill in by themselves.
          </dd>
          <dt>Why do some details only appear after the session?</dt>
          <dd>Car positions, speed and stationary pit stop times are not in F1's free feed. They come from OpenF1 once it opens up again. Pit lane times are live.</dd>
          <dt>Times look wrong.</dt>
          <dd>All times are in your device's time zone. Weather days use the circuit's local date.</dd>
          <dt>Do I need an account?</dt>
          <dd>
            No. An OpenF1 token (from its paid supporter plan) is optional and goes in Settings. It is stored only on this device and sent only to
            OpenF1.
          </dd>
          <dt>Where are my settings saved?</dt>
          <dd>Only on this device, in the browser. Each phone or laptop keeps its own favourites and settings.</dd>
          <dt>Is the Android app safe to install?</dt>
          <dd>
            It is built from this project's own code and only opens this website. Android warns about any app from outside the Play Store; only
            install it from this page.
          </dd>
          <dt>Is this official?</dt>
          <dd>No. Pit Wall is an unofficial fan project, not affiliated with Formula 1, the FIA or any team.</dd>
        </dl>
      </Section>
      <Footer />
    </>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="card help-section" id={id} aria-labelledby={`${id}-h`}>
      <h2 className="h2 sm" id={`${id}-h`}>{title}</h2>
      {children}
    </section>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="help-steps">{children}</ol>;
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li>
      <span className="help-num" aria-hidden="true">{n}</span>
      <div>
        <b>{title}</b>
        <p>{children}</p>
      </div>
    </li>
  );
}

function Example({ demo, children }: { demo: ReactNode; children: ReactNode }) {
  return (
    <div className="help-example">
      <div className="help-demo">{demo}</div>
      <div className="help-text">{children}</div>
    </div>
  );
}
