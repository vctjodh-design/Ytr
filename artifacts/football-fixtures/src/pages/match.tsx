import { useState } from 'react';
import {
  ArrowLeft,
  ArrowLeftRight,
  CircleAlert,
  ExternalLink,
  Goal,
  RotateCw,
} from 'lucide-react';
import {
  getGetMatchDetailsQueryKey,
  useGetMatchDetails,
  type Fixture,
  type MatchDetails,
  type StandingRow,
} from '@workspace/api-client-react';
import { Link, useParams } from 'wouter';
import { BrandMark } from '@/components/brand-mark';
import { FixtureRow, FixtureSkeleton } from '@/components/fixture-row';
import { MatchSourceContent } from '@/components/match-source-content';
import { OddsPanel } from '@/components/odds-panel';
import { SectionEmpty } from '@/components/section-empty';
import { TeamCrest } from '@/components/team-crest';

const tabs = ['Rounds', 'Standings', 'Analysis', 'Preview', 'Lineups', 'Odds', 'Events'] as const;
type Tab = typeof tabs[number];
type StandingScope = 'overall' | 'home' | 'away';

function formatKickoff(kickoff: string) {
  const date = new Date(kickoff);
  if (Number.isNaN(date.getTime())) return kickoff;
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
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

function numericValue(value: string) {
  const parsed = Number.parseFloat(value.replace('%', '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function teamSlugFromMatchSource(sourceUrl: string, side: 'home' | 'away') {
  try {
    const match = new URL(sourceUrl).pathname.match(
      /^\/match\/([a-z0-9-]+)\/([a-z0-9-]+)\/\d+$/i,
    );
    return match?.[side === 'home' ? 1 : 2] ?? null;
  } catch {
    return null;
  }
}

function StandingTable({ rows }: { rows: StandingRow[] }) {
  return (
    <div className="table-scroll standings-scroll">
      <table className="standings-table">
        <thead>
          <tr>
            <th>#</th>
            <th>CLUB</th>
            <th>MP</th>
            <th>W</th>
            <th>D</th>
            <th>L</th>
            <th>GF</th>
            <th>GA</th>
            <th>GD</th>
            <th>PTS</th>
            <th>FORM</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.team}-${index}`} data-testid={`standing-row-${index + 1}`}>
              <td className="position-cell">{row.position ?? '—'}</td>
              <td>
                <span className="standing-team">
                  <TeamCrest src={row.badgeUrl} name={row.team} size="sm" teamSlug={row.teamSlug} />
                  <span>{row.team}</span>
                </span>
              </td>
              <td>{row.matchesPlayed ?? '—'}</td>
              <td>{row.wins ?? '—'}</td>
              <td>{row.draws ?? '—'}</td>
              <td>{row.losses ?? '—'}</td>
              <td>{row.goalsFor ?? '—'}</td>
              <td>{row.goalsAgainst ?? '—'}</td>
              <td>{row.goalDifference ?? '—'}</td>
              <td className="points-cell">{row.points ?? '—'}</td>
              <td className="form-cell">{row.form || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StandingsContent({ details }: { details: MatchDetails }) {
  const [scope, setScope] = useState<StandingScope>('overall');
  const rowsByScope = {
    overall: details.standings ?? [],
    home: details.homeStandings ?? [],
    away: details.awayStandings ?? [],
  };
  const labels: { id: StandingScope; label: string }[] = [
    { id: 'overall', label: 'Overall' },
    { id: 'home', label: 'Home' },
    { id: 'away', label: 'Away' },
  ];
  const rows = rowsByScope[scope];

  return (
    <div className="standings-content">
      <div className="standings-toolbar">
        <div className="standings-scope" role="tablist" aria-label="Standings split">
          {labels.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={scope === item.id}
              className={`standings-scope-button ${scope === item.id ? 'active' : ''}`}
              onClick={() => setScope(item.id)}
              data-testid={`standings-${item.id}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="standings-caption">
          {rows.length ? `${rows.length} source rows` : 'No source rows'}
        </span>
      </div>
      {rows.length ? (
        <StandingTable rows={rows} />
      ) : (
        <SectionEmpty
          title={`${labels.find((item) => item.id === scope)?.label} standings unavailable`}
          detail="The source did not return this standings split for the match."
        />
      )}
    </div>
  );
}

function StatList({
  stats,
  testPrefix,
}: {
  stats: MatchDetails['analysisStats'];
  testPrefix: string;
}) {
  return (
    <div className="analysis-list">
      {stats.map((stat, index) => {
        const home = numericValue(stat.homeValue);
        const away = numericValue(stat.awayValue);
        const share = home !== null && away !== null && home + away > 0
          ? Math.max(6, Math.min(94, (home / (home + away)) * 100))
          : 50;
        return (
          <div className="stat-row" key={`${stat.label}-${index}`} data-testid={`${testPrefix}-row-${index}`}>
            <span className="stat-value home-stat-value">{stat.homeValue || '—'}</span>
            <div className="stat-center">
              <div className="stat-label">{stat.label}</div>
              <div className="stat-track" aria-hidden="true">
                <span style={{ width: `${share}%` }} />
              </div>
            </div>
            <span className="stat-value away-stat-value">{stat.awayValue || '—'}</span>
          </div>
        );
      })}
    </div>
  );
}

function Rating({ rating }: { rating: number | null }) {
  if (rating === null || !Number.isFinite(rating)) {
    return <span className="player-rating is-unrated" aria-label="No rating supplied">—</span>;
  }
  const ratingTone = rating >= 7.5 ? 'rating-high' : rating < 6 ? 'rating-low' : 'rating-mid';
  return (
    <span className={`player-rating ${ratingTone}`} data-testid={`player-rating-${rating}`}>
      {rating.toFixed(1)}
    </span>
  );
}

function LineupsContent({ details }: { details: MatchDetails }) {
  const lineups = details.lineups ?? [];
  if (!lineups.length) {
    return (
      <SectionEmpty
        title="Lineups not available"
        detail="Lineups have not been published or were not included in the source match file."
      />
    );
  }

  return (
    <div className="lineup-columns">
      {lineups.map((lineup) => {
        const players = lineup.players ?? [];
        const starters = players.filter((player) => !player.isSubstitute);
        const substitutes = players.filter((player) => player.isSubstitute);
        return (
          <section className="lineup-team" key={lineup.team} data-testid={`lineup-${lineup.team.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
            <div className="lineup-team-head">
              <div>
                <h3>{lineup.team}</h3>
                <span>
                  {lineup.formation || 'FORMATION NOT SUPPLIED'}
                  {lineup.coach ? ` · ${lineup.coach}` : ''}
                </span>
              </div>
              <span className="player-count">{players.length} PLAYERS</span>
            </div>
            {players.length ? (
              <>
                {starters.length > 0 && (
                  <div className="lineup-group">
                    <div className="lineup-group-label"><span>Starting XI</span><span>{starters.length}</span></div>
                    <div className="player-list">
                      {starters.map((player, index) => (
                        <div className="player-row" key={`${player.name}-${index}`}>
                          <span className="player-number">{player.number ?? '—'}</span>
                          {player.photoUrl ? (
                            <img className="player-photo" src={player.photoUrl} alt="" loading="lazy" />
                          ) : (
                            <span className="player-photo-fallback" aria-hidden="true">{player.name.slice(0, 1)}</span>
                          )}
                          <span className="player-name">
                            <strong>{player.name}</strong>
                            {player.position && <small>{player.position}</small>}
                          </span>
                          <Rating rating={player.rating} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {substitutes.length > 0 && (
                  <div className="lineup-group substitutes-group">
                    <div className="lineup-group-label"><span>Substitutes</span><span>{substitutes.length}</span></div>
                    <div className="player-list">
                      {substitutes.map((player, index) => (
                        <div className="player-row is-substitute" key={`${player.name}-${index}`}>
                          <span className="player-number">{player.number ?? '—'}</span>
                          {player.photoUrl ? (
                            <img className="player-photo" src={player.photoUrl} alt="" loading="lazy" />
                          ) : (
                            <span className="player-photo-fallback" aria-hidden="true">{player.name.slice(0, 1)}</span>
                          )}
                          <span className="player-name">
                            <strong>{player.name}</strong>
                            {player.position && <small>{player.position}</small>}
                          </span>
                          <Rating rating={player.rating} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <SectionEmpty title="Players not supplied" detail="The source returned a team sheet without player rows." />
            )}
          </section>
        );
      })}
    </div>
  );
}

function EventIcon({ eventType }: { eventType: string }) {
  const normalized = eventType.toLowerCase();
  if (normalized.includes('goal')) {
    return <Goal size={15} strokeWidth={1.7} />;
  }
  if (normalized.includes('sub')) {
    return <ArrowLeftRight size={15} strokeWidth={1.7} />;
  }
  if (normalized.includes('yellow')) {
    return <span className="event-card yellow-card" aria-hidden="true" />;
  }
  if (normalized.includes('red')) {
    return <span className="event-card red-card" aria-hidden="true" />;
  }
  return <span className="event-dot" aria-hidden="true" />;
}

function EventsContent({ details }: { details: MatchDetails }) {
  const events = details.events ?? [];
  if (!events.length) {
    return (
      <SectionEmpty
        title="No events recorded"
        detail="There is no event timeline available for this fixture in the source response."
      />
    );
  }
  return (
    <div className="event-timeline">
      {events.map((event, index) => (
        <article className="event-row" key={`${event.minute}-${event.eventType}-${index}`} data-testid={`match-event-${index}`}>
          <span className="event-minute">
            {event.minute || '—'}
            {event.minute && !event.minute.includes("'") && !event.minute.includes('′') ? "'" : ''}
          </span>
          <span className={`event-marker event-marker-${event.eventType.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
            <EventIcon eventType={event.eventType} />
          </span>
          <div className="event-copy">
            <div className="event-heading">
              <strong>{event.eventType || 'Match event'}</strong>
              {event.team && <span>{event.team}</span>}
            </div>
            <p>{[event.player, event.detail].filter(Boolean).join(' · ') || 'Event detail not supplied by source'}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

function TabContent({
  tab,
  details,
  matchId,
  sourcePath,
  selectedDate,
}: {
  tab: Tab;
  details: MatchDetails;
  matchId: string;
  sourcePath?: string;
  selectedDate: string;
}) {
  if (tab === 'Rounds') {
    const matches = details.roundMatches ?? [];
    return matches.length ? (
      <div className="rounds-content">
        {matches.map((fixture) => (
          <FixtureRow fixture={fixture} selectedDate={selectedDate} key={fixture.id} />
        ))}
      </div>
    ) : (
      <SectionEmpty title="Round fixtures unavailable" detail="The source did not provide other matches from this round." />
    );
  }

  if (tab === 'Standings') {
    return <StandingsContent details={details} />;
  }

  if (tab === 'Lineups') {
    return <LineupsContent details={details} />;
  }

  if (tab === 'Analysis') {
    const analysisStats = details.analysisStats ?? [];
    const matchStatistics = details.matchStatistics ?? [];
    if (!analysisStats.length && !matchStatistics.length) {
      return <SectionEmpty title="Analysis unavailable" detail="No statistical comparison was included in the source response." />;
    }
    return (
      <div className="analysis-sections">
        {analysisStats.length > 0 && (
          <section className="analysis-block">
            <div className="analysis-section-heading">
              <h3>Season comparison</h3>
              <span>HOME <i /> AWAY</span>
            </div>
            <StatList stats={analysisStats} testPrefix="analysis-stat" />
          </section>
        )}
        {matchStatistics.length > 0 && (
          <section className="analysis-block match-statistics-block">
            <div className="analysis-section-heading">
              <h3>Match statistics</h3>
              <span>AS REPORTED</span>
            </div>
            <StatList stats={matchStatistics} testPrefix="match-stat" />
          </section>
        )}
      </div>
    );
  }

  if (tab === 'Preview') {
    const facts = details.previewFacts ?? [];
    const previewPage = details.sourcePages?.find((page) => page.tab === 'preview');
    return (
      <>
        {facts.length > 0 && (
          <div className="preview-grid">
            {facts.map((fact, index) => (
              <article className="preview-fact" key={`${fact.label}-${index}`} data-testid={`preview-fact-${index}`}>
                <span>{fact.label}</span>
                <p>{fact.value}</p>
              </article>
            ))}
          </div>
        )}
        {previewPage ? (
          <MatchSourceContent page={previewPage} tab="Preview" />
        ) : facts.length === 0 ? (
          <SectionEmpty title="No preview facts" detail="The source did not include editorial notes or pre-match facts." />
        ) : null}
      </>
    );
  }

  if (tab === 'Events') {
    return <EventsContent details={details} />;
  }

  return <OddsPanel matchId={matchId} sourcePath={sourcePath} />;
}

export default function MatchPage() {
  const { homeSlug, awaySlug, matchId = '' } = useParams<{
    homeSlug?: string;
    awaySlug?: string;
    matchId: string;
  }>();
  const requestParams = homeSlug && awaySlug
    ? { sourcePath: `/match/${homeSlug}/${awaySlug}/${matchId}` }
    : undefined;
  const [tab, setTab] = useState<Tab>('Rounds');
  const { data, isLoading, isError, refetch, isFetching } = useGetMatchDetails(
    matchId,
    requestParams,
    {
      query: {
        enabled: Boolean(matchId),
        queryKey: getGetMatchDetailsQueryKey(matchId, requestParams),
        staleTime: 0,
        refetchOnMount: 'always',
        refetchOnWindowFocus: false,
        retry: 2,
      },
    },
  );
  const fixture = data?.fixture;
  const sourceUrl = data?.sourceUrl || fixture?.sourceUrl;

  return (
    <main className="desk-shell match-shell">
      <header className="topbar">
        <BrandMark />
        <div className="topbar-center">
          <span className="desk-status"><i /> MATCHDAY DESK</span>
          <span className="topbar-divider" />
          <span className="topbar-tagline">Fixture intelligence, with the source attached.</span>
        </div>
        <Link href="/" className="back-link" data-testid="link-back-fixtures">
          <ArrowLeft size={15} />
          ALL FIXTURES
        </Link>
      </header>
      <div className="match-page">
        <div className="match-breadcrumb">
          <Link href="/" data-testid="link-match-home">FIXTURES</Link>
          <span>/</span>
          <span>MATCH FILE</span>
          <button
            type="button"
            className={`refresh-button ${isFetching ? 'is-refreshing' : ''}`}
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-match"
          >
            <RotateCw size={13} />
            {isFetching ? 'UPDATING' : 'REFRESH'}
          </button>
        </div>
        {isLoading ? (
          <div className="match-loading" role="status" aria-label="Loading match file">
            <div className="match-skeleton-hero" />
            <FixtureSkeleton />
            <FixtureSkeleton />
          </div>
        ) : isError || !fixture || !data ? (
          <div className="error-panel match-error" data-testid="status-match-error">
            <CircleAlert size={22} />
            <div>
              <strong>Match file unavailable.</strong>
              <p>We couldn't retrieve match details for this fixture.</p>
            </div>
            <button type="button" onClick={() => refetch()} disabled={isFetching} data-testid="button-retry-match">
              {isFetching ? 'Retrying' : 'Try again'}
            </button>
          </div>
        ) : (
          <>
            <section className="match-hero">
              <div className="match-meta">
                <span className="eyebrow-mark">MATCH FILE / {fixture.id}</span>
                <span className="match-competition">
                  {fixture.competition}{fixture.round ? ` · ${fixture.round}` : ''}
                </span>
              </div>
              <div className="match-scoreboard">
                <div className="score-team score-home" data-testid="match-home-team">
                  <TeamCrest
                    src={fixture.homeBadgeUrl}
                    name={fixture.homeTeam}
                    size="lg"
                    teamSlug={homeSlug ?? teamSlugFromMatchSource(fixture.sourceUrl, 'home')}
                  />
                  <h1>{fixture.homeTeam}</h1>
                </div>
                <div className="score-middle">
                  <span className={`match-state ${isLive(fixture) ? 'live-label' : ''}`} data-testid="match-status">
                    {isLive(fixture) && <i />}
                    {getState(fixture)}
                  </span>
                  <div className="big-score" data-testid="match-score">
                    {fixture.homeScore !== null && fixture.awayScore !== null ? (
                      <>
                        <b>{fixture.homeScore}</b>
                        <span>:</span>
                        <b>{fixture.awayScore}</b>
                      </>
                    ) : (
                      <span className="score-vs">VS</span>
                    )}
                  </div>
                  <span className="kickoff-detail" data-testid="match-kickoff">{formatKickoff(fixture.kickoff)}</span>
                </div>
                <div className="score-team score-away" data-testid="match-away-team">
                  <TeamCrest
                    src={fixture.awayBadgeUrl}
                    name={fixture.awayTeam}
                    size="lg"
                    teamSlug={awaySlug ?? teamSlugFromMatchSource(fixture.sourceUrl, 'away')}
                  />
                  <h1>{fixture.awayTeam}</h1>
                </div>
              </div>
              <div className="match-hero-foot">
                <span>THE MATCH, IN CONTEXT</span>
                {sourceUrl ? (
                  <a href={sourceUrl} target="_blank" rel="noreferrer" data-testid="link-match-source">
                    ORIGINAL SOURCE <ExternalLink size={12} />
                  </a>
                ) : (
                  <span className="source-missing-label">SOURCE LINK NOT PROVIDED</span>
                )}
              </div>
            </section>
            <nav className="match-tabs" aria-label="Match information sections">
              {tabs.map((item, index) => (
                <button
                  type="button"
                  aria-pressed={tab === item}
                  className={tab === item ? 'match-tab active' : 'match-tab'}
                  key={item}
                  onClick={() => setTab(item)}
                  data-testid={`tab-${item.toLowerCase()}`}
                >
                  <span className="tab-index">{String(index + 1).padStart(2, '0')}</span>
                  {item}
                </button>
              ))}
            </nav>
            <section className="match-data-panel" key={tab}>
              <div className="data-panel-head">
                <div>
                  <p className="eyebrow">
                    <span className="eyebrow-mark">{String(tabs.indexOf(tab) + 1).padStart(2, '0')}</span>
                    {' '}MATCH INTELLIGENCE
                  </p>
                  <h2>
                    {tab}
                    <em>
                      {tab === 'Rounds' ? ' around it.' :
                        tab === 'Standings' ? ' table.' :
                          tab === 'Lineups' ? ' sheet.' :
                            tab === 'Analysis' ? ' desk.' :
                              tab === 'Preview' ? ' notes.' :
                                tab === 'Events' ? ' log.' : ' market.'}
                    </em>
                  </h2>
                </div>
                <span className="data-source">{tab.toUpperCase()} / SOURCE DATA</span>
              </div>
              <TabContent
                tab={tab}
                details={data}
                matchId={matchId}
                sourcePath={requestParams?.sourcePath}
                selectedDate={fixture.kickoff.slice(0, 10)}
              />
            </section>
            <footer className="page-foot match-foot">
              <span>TOUCHLINE DESK <b>·</b> {fixture.id}</span>
              <span>
                {data.fetchedAt
                  ? `SOURCE CAPTURED ${new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(data.fetchedAt))}`
                  : 'SOURCE CAPTURE TIME NOT PROVIDED'}
                {sourceUrl && (
                  <a href={sourceUrl} target="_blank" rel="noreferrer" aria-label="Open original match source">
                    <ExternalLink size={12} />
                  </a>
                )}
              </span>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}
