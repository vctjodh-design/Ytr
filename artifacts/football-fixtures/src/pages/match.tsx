import { useState } from 'react';
import { useGetMatchDetails, getGetMatchDetailsQueryKey } from '@workspace/api-client-react';
import { ArrowLeft, ArrowUpRight, CircleAlert, ExternalLink, RotateCw } from 'lucide-react';
import { Link, useParams } from 'wouter';
import type { Fixture, MatchDetails } from '@workspace/api-client-react';
import { BrandMark } from '@/components/brand-mark';
import { TeamCrest } from '@/components/team-crest';
import { FixtureRow, FixtureSkeleton } from '@/components/fixture-row';
import { SectionEmpty } from '@/components/section-empty';

const tabs = ['Rounds', 'Standings', 'Lineups', 'Analysis', 'Preview', 'Events', 'Odds'] as const;
type Tab = typeof tabs[number];

function formatKickoff(kickoff: string) {
  const date = new Date(kickoff);
  if (Number.isNaN(date.getTime())) return kickoff;
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(date);
}

function isLive(fixture: Fixture) {
  const status = fixture.status.toLowerCase();
  return status.includes('live') || status.includes('playing');
}

function getState(fixture: Fixture) {
  if (isLive(fixture)) return 'LIVE NOW';
  if (fixture.homeScore !== null && fixture.awayScore !== null) return 'FULL TIME';
  return fixture.status || 'UPCOMING';
}

function TabContent({ tab, details }: { tab: Tab; details: MatchDetails }) {
  if (tab === 'Rounds') {
    const matches = details.roundMatches ?? [];
    return matches.length ? <div className="rounds-content">{matches.map((fixture) => <FixtureRow fixture={fixture} key={fixture.id} />)}</div> : <SectionEmpty title="Round fixtures unavailable" detail="The source did not provide other matches from this round." />;
  }
  if (tab === 'Standings') {
    const rows = details.standings ?? [];
    return rows.length ? (
      <div className="table-scroll"><table className="standings-table"><thead><tr><th>#</th><th>CLUB</th><th>MP</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>PTS</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.team}-${index}`}><td className="position-cell">{row.position}</td><td><span className="standing-team"><TeamCrest src={row.badgeUrl} name={row.team} size="sm" />{row.team}</span></td><td>{row.matchesPlayed ?? '—'}</td><td>{row.wins ?? '—'}</td><td>{row.draws ?? '—'}</td><td>{row.losses ?? '—'}</td><td>{row.goalDifference ?? '—'}</td><td className="points-cell">{row.points ?? '—'}</td></tr>)}</tbody></table></div>
    ) : <SectionEmpty title="Standings not supplied" />;
  }
  if (tab === 'Lineups') {
    const lineups = details.lineups ?? [];
    return lineups.length ? <div className="lineup-columns">{lineups.map((lineup) => <section className="lineup-team" key={lineup.team}><div className="lineup-team-head"><div><h3>{lineup.team}</h3><span>{lineup.formation || 'FORMATION N/A'}{lineup.coach ? ` · ${lineup.coach}` : ''}</span></div><span className="player-count">{lineup.players?.length ?? 0}</span></div>{lineup.players?.length ? <div className="player-list">{lineup.players.map((player, index) => <div className={`player-row ${player.isSubstitute ? 'is-substitute' : ''}`} key={`${player.name}-${index}`}><span className="player-number">{player.number ?? '—'}</span><span>{player.name}</span><span className="player-position">{player.position || (player.isSubstitute ? 'SUB' : '')}</span></div>)}</div> : <SectionEmpty title="Players not supplied" />}</section>)}</div> : <SectionEmpty title="Lineups not available" detail="Lineups have not been published or were not included in the scraped match details." />;
  }
  if (tab === 'Analysis') {
    const stats = details.analysisStats ?? [];
    return stats.length ? <div className="analysis-list">{stats.map((stat, index) => <div className="stat-row" key={`${stat.label}-${index}`}><span className="stat-value">{stat.homeValue || '—'}</span><div className="stat-center"><div className="stat-label">{stat.label}</div><div className="stat-track"><span style={{ width: `${stat.homeValue && stat.awayValue ? `${Math.max(6, Math.min(94, (parseFloat(stat.homeValue) / (parseFloat(stat.homeValue) + parseFloat(stat.awayValue) || 1)) * 100))}%` : '50%'}` }} /></div></div><span className="stat-value">{stat.awayValue || '—'}</span></div>)}</div> : <SectionEmpty title="Analysis unavailable" detail="No statistical comparison was included in the source response." />;
  }
  if (tab === 'Preview') {
    const facts = details.previewFacts ?? [];
    return facts.length ? <div className="preview-grid">{facts.map((fact, index) => <article className="preview-fact" key={`${fact.label}-${index}`}><span>{fact.label}</span><p>{fact.value}</p></article>)}</div> : <SectionEmpty title="No preview facts" detail="The source did not include editorial notes or pre-match facts." />;
  }
  if (tab === 'Events') {
    const events = details.events ?? [];
    return events.length ? <div className="event-timeline">{events.map((event, index) => <article className="event-row" key={`${event.minute}-${index}`}><span className="event-minute">{event.minute}'</span><span className="event-marker" /><div><strong>{event.eventType}</strong><p>{[event.player, event.team, event.detail].filter(Boolean).join(' · ') || 'Event detail not supplied'}</p></div></article>)}</div> : <SectionEmpty title="No events recorded" detail="There is no event timeline available for this fixture yet." />;
  }
  const odds = details.odds ?? [];
  return odds.length ? <div className="table-scroll"><table className="odds-table"><thead><tr><th>BOOKMAKER</th><th>HOME</th><th>DRAW</th><th>AWAY</th><th>SOURCE</th></tr></thead><tbody>{odds.map((odd, index) => <tr key={`${odd.bookmaker}-${index}`}><td className="bookmaker">{odd.bookmaker}</td><td>{odd.homeOdds ?? '—'}</td><td>{odd.drawOdds ?? '—'}</td><td>{odd.awayOdds ?? '—'}</td><td>{odd.sourceUrl ? <a className="table-source" href={odd.sourceUrl} target="_blank" rel="noreferrer">VIEW <ArrowUpRight size={12} /></a> : '—'}</td></tr>)}</tbody></table></div> : <SectionEmpty title="Odds unavailable" detail="No bookmaker prices were returned for this match." />;
}

export default function MatchPage() {
  const { matchId = '' } = useParams<{ matchId: string }>();
  const [tab, setTab] = useState<Tab>('Rounds');
  const { data, isLoading, isError, refetch, isFetching } = useGetMatchDetails(matchId, { query: { enabled: Boolean(matchId), queryKey: getGetMatchDetailsQueryKey(matchId) } });
  const fixture = data?.fixture;

  return (
    <main className="desk-shell match-shell">
      <header className="topbar">
        <BrandMark />
        <div className="topbar-center"><span className="desk-status"><i /> MATCHDAY DESK</span><span className="topbar-divider" /> <span className="topbar-tagline">Fixture intelligence, with the source attached.</span></div>
        <Link href="/" className="back-link" data-testid="link-back-fixtures"><ArrowLeft size={15} /> ALL FIXTURES</Link>
      </header>
      <div className="match-page">
        <div className="match-breadcrumb"><Link href="/" data-testid="link-match-home">FIXTURES</Link><span>/</span><span>MATCH FILE</span><button className={`refresh-button ${isFetching ? 'is-refreshing' : ''}`} onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-match"><RotateCw size={13} /> {isFetching ? 'UPDATING' : 'REFRESH'}</button></div>
        {isLoading ? <div className="match-loading"><div className="match-skeleton-hero" /><FixtureSkeleton /><FixtureSkeleton /></div> : isError || !fixture || !data ? (
          <div className="error-panel match-error" data-testid="status-match-error"><CircleAlert size={22} /><div><strong>Match file unavailable.</strong><p>We couldn't retrieve match details for this fixture.</p></div><button onClick={() => refetch()} data-testid="button-retry-match">Try again</button></div>
        ) : (
          <>
            <section className="match-hero">
              <div className="match-meta"><span className="eyebrow-mark">MATCH FILE / {fixture.id}</span><span className="match-competition">{fixture.competition}{fixture.round ? ` · ${fixture.round}` : ''}</span></div>
              <div className="match-scoreboard">
                <div className="score-team score-home"><TeamCrest src={fixture.homeBadgeUrl} name={fixture.homeTeam} size="lg" /><h1>{fixture.homeTeam}</h1></div>
                <div className="score-middle"><span className={`match-state ${isLive(fixture) ? 'live-label' : ''}`}>{isLive(fixture) && <i />}{getState(fixture)}</span><div className="big-score">{fixture.homeScore !== null && fixture.awayScore !== null ? <><b>{fixture.homeScore}</b><span>:</span><b>{fixture.awayScore}</b></> : <span className="score-vs">VS</span>}</div><span className="kickoff-detail">{formatKickoff(fixture.kickoff)}</span></div>
                <div className="score-team score-away"><TeamCrest src={fixture.awayBadgeUrl} name={fixture.awayTeam} size="lg" /><h1>{fixture.awayTeam}</h1></div>
              </div>
              <div className="match-hero-foot"><span>THE MATCH, IN CONTEXT</span><a href={data.sourceUrl || fixture.sourceUrl} target="_blank" rel="noreferrer" data-testid="link-match-source">ORIGINAL SOURCE <ExternalLink size={12} /></a></div>
            </section>
            <nav className="match-tabs" aria-label="Match information sections">{tabs.map((item, index) => <button className={tab === item ? 'match-tab active' : 'match-tab'} key={item} onClick={() => setTab(item)} data-testid={`tab-${item.toLowerCase()}`}><span className="tab-index">{String(index + 1).padStart(2, '0')}</span>{item}</button>)}</nav>
            <section className="match-data-panel" key={tab}>
              <div className="data-panel-head"><div><p className="eyebrow"><span className="eyebrow-mark">{String(tabs.indexOf(tab) + 1).padStart(2, '0')}</span> MATCH INTELLIGENCE</p><h2>{tab}<em>{tab === 'Rounds' ? ' around it.' : tab === 'Standings' ? ' table.' : tab === 'Lineups' ? ' sheet.' : tab === 'Analysis' ? ' desk.' : tab === 'Preview' ? ' notes.' : tab === 'Events' ? ' log.' : ' market.'}</em></h2></div><span className="data-source">{tab.toUpperCase()} / SOURCE DATA</span></div>
              <TabContent tab={tab} details={data} />
            </section>
            <footer className="page-foot match-foot"><span>TOUCHLINE DESK <b>·</b> {fixture.id}</span><span>{data.fetchedAt ? `SOURCE CAPTURED ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data.fetchedAt))}` : 'SOURCE CAPTURE TIME NOT PROVIDED'}<a href={data.sourceUrl || fixture.sourceUrl} target="_blank" rel="noreferrer" aria-label="Open original match source"><ExternalLink size={12} /></a></span></footer>
          </>
        )}
      </div>
    </main>
  );
}
