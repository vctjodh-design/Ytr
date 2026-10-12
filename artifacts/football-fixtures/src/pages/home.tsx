import { useMemo, useState } from 'react';
import { useListFixtures, getListFixturesQueryKey } from '@workspace/api-client-react';
import { CalendarDays, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, RotateCw, Sparkles } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { FixtureRow, FixtureSkeleton } from '@/components/fixture-row';
import { SectionEmpty } from '@/components/section-empty';

function localDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDate(value: string, amount: number) {
  const next = new Date(`${value}T12:00:00`);
  next.setDate(next.getDate() + amount);
  return localDate(next);
}

function readableDate(value: string) {
  const parsed = new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(parsed);
}

export default function HomePage() {
  const today = localDate(new Date());
  const [date, setDate] = useState(today);
  const { data, isLoading, isError, refetch, isFetching } = useListFixtures({ date }, { query: { queryKey: getListFixturesQueryKey({ date }) } });
  const fixtures = data?.fixtures ?? [];
  const groups = useMemo(() => {
    const collection = new Map<string, typeof fixtures>();
    fixtures.forEach((fixture) => {
      const group = collection.get(fixture.competition) ?? [];
      group.push(fixture);
      collection.set(fixture.competition, group);
    });
    return Array.from(collection.entries());
  }, [fixtures]);

  return (
    <main className="desk-shell">
      <header className="topbar">
        <BrandMark />
        <div className="topbar-center"><span className="desk-status"><i /> MATCHDAY DESK</span><span className="topbar-divider" /> <span className="topbar-tagline">Fixtures, context, and the details between.</span></div>
        <div className="topbar-right"><span className="source-chip">BE SOCCER FEED</span><span className="topbar-date">{new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date())}</span></div>
      </header>
      <div className="desk-layout">
        <aside className="left-rail">
          <div className="rail-kicker">THE DAILY EDITION</div>
          <div className="rail-date-large">{new Intl.DateTimeFormat(undefined, { day: '2-digit' }).format(new Date(`${date}T12:00:00`))}</div>
          <div className="rail-date-month">{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00`))}</div>
          <div className="rail-rule" />
          <p className="rail-copy">One date. Every fixture. Context as it arrives.</p>
          <div className="rail-foot"><span className="rail-dot" /> LIVE DATA<br /><span>Source-led, always.</span></div>
        </aside>
        <section className="main-desk">
          <div className="page-heading">
            <div>
              <p className="eyebrow"><span className="eyebrow-mark">01</span> FIXTURES / {date === today ? 'TODAY' : 'ARCHIVE'}</p>
              <h1>Matchday <em>ledger.</em></h1>
              <p className="page-deck">The full picture of football, one kickoff at a time.</p>
            </div>
            <div className="heading-aside"><Sparkles size={14} /><span>SCRAPED FROM<br />BESOCCER</span></div>
          </div>
          <div className="date-toolbar">
            <div className="date-nav">
              <button className="icon-button" onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day" data-testid="button-previous-day"><ChevronLeft size={18} /></button>
              <button className="date-current" onClick={() => setDate(today)} data-testid="button-jump-today">{date === today ? 'TODAY' : 'JUMP TO TODAY'}</button>
              <button className="icon-button" onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day" data-testid="button-next-day"><ChevronRight size={18} /></button>
            </div>
            <label className="date-picker">
              <CalendarDays size={15} />
              <span>{readableDate(date)}</span>
              <input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="Choose fixtures date" data-testid="input-fixtures-date" />
            </label>
            <button className={`refresh-button ${isFetching ? 'is-refreshing' : ''}`} onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-fixtures"><RotateCw size={14} /> <span>{isFetching ? 'UPDATING' : 'REFRESH'}</span></button>
          </div>
          <div className="date-caption"><span>{readableDate(date)}</span><span className="caption-line" /><span>{isLoading ? 'CHECKING THE BOARD' : `${fixtures.length} FIXTURE${fixtures.length === 1 ? '' : 'S'}`}</span></div>
          {isLoading ? (
            <div className="fixture-list"><FixtureSkeleton /><FixtureSkeleton /><FixtureSkeleton /></div>
          ) : isError ? (
            <div className="error-panel" data-testid="status-fixtures-error"><CircleAlert size={22} /><div><strong>Could not load the fixture board.</strong><p>The source may be temporarily unavailable.</p></div><button onClick={() => refetch()} data-testid="button-retry-fixtures">Try again</button></div>
          ) : fixtures.length === 0 ? (
            <SectionEmpty title="No fixtures listed" detail="There are no fixtures available from the source for this date. Try another day on the calendar." />
          ) : (
            <div className="fixture-groups">
              {groups.map(([competition, matches], index) => (
                <section className="competition-group" key={competition} data-testid={`group-competition-${index}`}>
                  <div className="competition-heading"><span className="competition-index">{String(index + 1).padStart(2, '0')}</span><h2>{competition}</h2><span className="competition-count">{matches.length} MATCH{matches.length === 1 ? '' : 'ES'}</span><span className="competition-rule" /></div>
                  <div className="fixture-list">{matches.map((fixture) => <FixtureRow fixture={fixture} key={fixture.id} />)}</div>
                </section>
              ))}
            </div>
          )}
          <footer className="page-foot"><span>FIXTURES DESK <b>·</b> {date}</span>{data?.fetchedAt && <span>UPDATED {new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(data.fetchedAt))} <a href={data.sourceUrl} target="_blank" rel="noreferrer" aria-label="Open fixtures source"><ExternalLink size={12} /></a></span>}</footer>
        </section>
        <aside className="right-rail">
          <div className="rail-card-note"><span className="note-stamp">FIELD NOTE / 01</span><h3>More than<br />the scoreline.</h3><p>Open any fixture for source-backed team data, event logs, odds and match context.</p><div className="note-mark">TD<span>—</span></div></div>
          <div className="right-rail-bottom"><span className="mini-ball" /> FOOTBALL, IN FULL.</div>
        </aside>
      </div>
    </main>
  );
}
