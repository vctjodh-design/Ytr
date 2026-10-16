import { ExternalLink, Minus } from 'lucide-react';
import type { Fixture, MatchContentSection, MatchStat, TeamDetails } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { OddsPanel } from '@/components/odds-panel';
import { SourceInlineImages } from '@/components/source-inline-images';

type Props = {
  details: TeamDetails;
  showNextMatch?: boolean;
};

const dossierSections = [
  {
    id: 'coach',
    title: 'Coach performance',
    note: 'Manager record and coaching notes',
    terms: ['coach', 'manager', 'trainer', 'technical staff', 'performance'],
  },
  {
    id: 'lineup',
    title: 'Most-used lineup',
    note: 'First-team selection and formation',
    terms: ['lineup', 'starting eleven', 'formation', 'most used', 'most-used', 'starting 11'],
  },
  {
    id: 'squad',
    title: 'Squad & player stats',
    note: 'Roster and individual season data',
    terms: ['squad', 'player stats', 'player statistics', 'appearances', 'scorers', 'top scorer'],
  },
  {
    id: 'standings',
    title: 'Standings',
    note: 'Competition position and table data',
    terms: ['standings', 'league table', 'classification', 'position'],
  },
  {
    id: 'standouts',
    title: 'Standout players',
    note: 'Notable individual contributions',
    terms: ['standout', 'best player', 'key player', 'top player', 'best scorer', 'top assist'],
  },
  {
    id: 'availability',
    title: 'Injuries & suspensions',
    note: 'Reported squad availability',
    terms: ['injur', 'suspension', 'suspended', 'unavailable', 'absent'],
  },
];

function canonicalPath(sourceUrl: string | null | undefined) {
  if (!sourceUrl) return undefined;
  try {
    const url = new URL(sourceUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

function safeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function completedMatches(matches: Fixture[]) {
  return matches.filter((match) => (
    match.homeScore !== null
    && match.awayScore !== null
    && Number.isFinite(match.homeScore)
    && Number.isFinite(match.awayScore)
  ));
}

function normalizeClubName(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/\b(?:fc|afc|cf|cfc|sc|ac|club)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fixtureSideForTeam(match: Fixture, teamName: string, teamSlug: string) {
  const name = normalizeClubName(teamName);
  const homeName = normalizeClubName(match.homeTeam);
  const awayName = normalizeClubName(match.awayTeam);
  if (homeName === name) return 'home';
  if (awayName === name) return 'away';

  try {
    const segments = new URL(match.sourceUrl).pathname.split('/').filter(Boolean);
    if (segments[0] === 'match') {
      const slug = normalizeClubName(teamSlug);
      if (normalizeClubName(segments[1] || '') === slug) return 'home';
      if (normalizeClubName(segments[2] || '') === slug) return 'away';
    }
  } catch {
    return null;
  }

  return null;
}

function scorePerspective(match: Fixture, teamName: string, teamSlug: string) {
  const side = fixtureSideForTeam(match, teamName, teamSlug);
  if (!side) return null;
  const forGoals = side === 'home' ? match.homeScore : match.awayScore;
  const againstGoals = side === 'home' ? match.awayScore : match.homeScore;
  if (forGoals === null || againstGoals === null) return null;
  return { forGoals, againstGoals };
}

function eloMetric(stats: MatchStat[], terms: string[], excludedTerms: string[] = []) {
  return stats.find((stat) => {
    const label = stat.label.toLocaleLowerCase();
    return terms.every((term) => label.includes(term))
      && excludedTerms.every((term) => !label.includes(term));
  });
}

function statValueForTeam(
  stat: MatchStat | undefined,
  match: Fixture | null,
  teamName: string,
  teamSlug: string,
) {
  if (!stat) return null;
  if (!match) return `Home ${stat.homeValue} · Away ${stat.awayValue}`;
  const side = fixtureSideForTeam(match, teamName, teamSlug);
  if (side === 'home') return stat.homeValue || null;
  if (side === 'away') return stat.awayValue || null;
  return `Home ${stat.homeValue} · Away ${stat.awayValue}`;
}

function average(value: number, total: number) {
  return total ? (value / total).toFixed(2) : '—';
}

function ResultMark({ result }: { result: 'W' | 'D' | 'L' }) {
  return <span className={`in-depth-form-mark is-${result.toLowerCase()}`}>{result}</span>;
}

function parseCoachRecord(section: MatchContentSection) {
  if (!/coach\s+statistics/i.test(section.title)) return null;
  const textBlocks = (section.blocks ?? [])
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text?.trim() ?? '')
    .filter(Boolean);
  const matchesIndex = textBlocks.findIndex((text) => /^matches$/i.test(text));
  const totalMatches = Number(textBlocks[matchesIndex - 1]);
  if (matchesIndex < 1 || !Number.isInteger(totalMatches) || totalMatches < 0) return null;

  const stats = textBlocks.slice(matchesIndex + 1);
  const counts = stats.filter((text) => /^\d+$/.test(text)).map(Number);
  const percentages = stats
    .map((text) => text.match(/^(\d+(?:[.,]\d+)?)%$/)?.[1]?.replace(',', '.'))
    .filter((value): value is string => Boolean(value));
  if (
    counts.length < 3
    || percentages.length < 3
    || counts[0] + counts[1] + counts[2] !== totalMatches
  ) {
    return null;
  }

  return {
    totalMatches,
    wins: counts[0],
    winRate: percentages[0],
    draws: counts[1],
    drawRate: percentages[1],
    losses: counts[2],
    lossRate: percentages[2],
  };
}

function SourceSection({ section }: { section: MatchContentSection }) {
  const hasBlocks = Boolean(section.blocks?.length);
  const coachRecord = parseCoachRecord(section);
  return (
    <article className="in-depth-source-section" data-testid={`source-section-${section.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
      <h4>{section.title}</h4>
      {hasBlocks ? (
        <div className="in-depth-source-body">
          {coachRecord && (
            <div className="coach-record-summary" data-testid="coach-record-summary">
              <div className="coach-record-grid">
                <div className="coach-record-stat">
                  <span>Total matches</span>
                  <strong>{coachRecord.totalMatches}</strong>
                </div>
                <div className="coach-record-stat">
                  <span>Wins</span>
                  <strong>{coachRecord.wins}</strong>
                  <small>{coachRecord.winRate}%</small>
                </div>
                <div className="coach-record-stat">
                  <span>Draws</span>
                  <strong>{coachRecord.draws}</strong>
                  <small>{coachRecord.drawRate}%</small>
                </div>
                <div className="coach-record-stat">
                  <span>Losses</span>
                  <strong>{coachRecord.losses}</strong>
                  <small>{coachRecord.lossRate}%</small>
                </div>
              </div>
            </div>
          )}
          {section.blocks?.map((block, index) => {
            if (coachRecord && !(block.type === 'text' && block.coachSlug)) return null;
            if (block.type === 'image' && block.imageUrl) {
              const image = (
                <figure className="in-depth-source-image" key={`image-${index}`}>
                  <img className="source-image-asset" src={block.imageUrl} alt={block.imageAlt || ''} loading="lazy" />
                  {block.imageAlt && <figcaption>{block.imageAlt}</figcaption>}
                </figure>
              );
              if (block.playerSlug) {
                return (
                  <Link
                    className="in-depth-player-link"
                    href={`/player/${encodeURIComponent(block.playerSlug)}`}
                    key={`image-${index}`}
                    data-testid={`link-source-player-${block.playerSlug}`}
                  >
                    {image}
                  </Link>
                );
              }
              if (block.coachSlug) {
                return (
                  <a
                    className="in-depth-player-link"
                    href={`https://www.besoccer.com/coach/${encodeURIComponent(block.coachSlug)}`}
                    target="_blank"
                    rel="noreferrer"
                    key={`image-${index}`}
                  >
                    {image}
                  </a>
                );
              }
              return image;
            }
            if (block.type === 'table') {
              return (
                <div className="in-depth-table-scroll" key={`table-${index}`}>
                  <table className="in-depth-data-table">
                    {block.headers?.length ? (
                      <thead>
                        <tr>
                          {block.headers.map((header, headerIndex) => <th key={`${header}-${headerIndex}`}>{header}</th>)}
                        </tr>
                      </thead>
                    ) : null}
                    <tbody>
                      {block.rows?.map((row, rowIndex) => block.rowTypes?.[rowIndex] === 'section' ? (
                        <tr className="source-table-section-row" key={`row-${rowIndex}`}>
                          <th colSpan={Math.max(block.headers?.length ?? 0, 1)}>{row[0]}</th>
                        </tr>
                      ) : (
                        <tr key={`row-${rowIndex}`}>
                          {row.map((value, cellIndex) => {
                            const playerSlug = block.playerSlugs?.[rowIndex]?.[cellIndex] || undefined;
                            const coachSlug = block.coachSlugs?.[rowIndex]?.[cellIndex] || undefined;
                            const images = block.cellImages?.[rowIndex]?.[cellIndex];
                            return (
                              <td key={`${cellIndex}-${value}`}>
                                <div className="source-table-cell">
                                  <SourceInlineImages images={images} playerSlug={playerSlug} coachSlug={coachSlug} />
                                  {value ? (
                                    playerSlug ? (
                                      <Link className="in-depth-player-link" href={`/player/${encodeURIComponent(playerSlug)}`} data-testid={`link-source-player-${playerSlug}`}>
                                        {value}
                                      </Link>
                                    ) : coachSlug ? (
                                      <a className="in-depth-player-link" href={`https://www.besoccer.com/coach/${encodeURIComponent(coachSlug)}`} target="_blank" rel="noreferrer">
                                        {value}
                                      </a>
                                    ) : <span>{value}</span>
                                  ) : null}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            }
            if (!block.text) return null;
            return (
              <p className={`in-depth-source-copy${block.images?.length ? ' has-inline-images' : ''}`} key={`text-${index}`}>
                <SourceInlineImages images={block.images} playerSlug={block.playerSlug} coachSlug={block.coachSlug} />
                {block.playerSlug ? (
                  <Link className="in-depth-player-link" href={`/player/${encodeURIComponent(block.playerSlug)}`} data-testid={`link-source-player-${block.playerSlug}`}>
                    {block.text}
                  </Link>
                ) : block.coachSlug ? (
                  <a className="in-depth-player-link" href={`https://www.besoccer.com/coach/${encodeURIComponent(block.coachSlug)}`} target="_blank" rel="noreferrer">
                    {block.text}
                  </a>
                ) : block.text}
              </p>
            );
          })}
        </div>
      ) : (
        <div className="in-depth-source-body">
          {section.text.map((text, index) => <p className="in-depth-source-copy" key={`${index}-${text}`}>{text}</p>)}
          {section.tables.map((table, index) => (
            <div className="in-depth-table-scroll" key={`table-${index}`}>
              <table className="in-depth-data-table">
                {table.headers.length > 0 && (
                  <thead>
                    <tr>{table.headers.map((header, headerIndex) => <th key={`${header}-${headerIndex}`}>{header}</th>)}</tr>
                  </thead>
                )}
                <tbody>
                  {table.rows.map((row, rowIndex) => (
                    <tr key={`row-${rowIndex}`}>{row.map((value, cellIndex) => <td key={`${cellIndex}-${value}`}>{value}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {!section.text.length && !section.tables.length && <p className="in-depth-missing">No parsed source detail was returned for this section.</p>}
        </div>
      )}
    </article>
  );
}

function MatchRow({
  match,
  teamName,
  teamSlug,
  index,
}: {
  match: Fixture;
  teamName: string;
  teamSlug: string;
  index: number;
}) {
  const scoresAvailable = match.homeScore !== null && match.awayScore !== null;
  const perspective = scorePerspective(match, teamName, teamSlug);
  const teamSide = fixtureSideForTeam(match, teamName, teamSlug);
  const result = perspective
    ? perspective.forGoals > perspective.againstGoals ? 'W' : perspective.forGoals < perspective.againstGoals ? 'L' : 'D'
    : null;
  const date = new Date(match.kickoff);
  const dateLabel = Number.isNaN(date.getTime())
    ? match.kickoff
    : new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  const source = safeExternalUrl(match.sourceUrl);

  return (
    <article className="in-depth-match-row" data-testid={`row-recent-match-${match.id}`}>
      <div className="in-depth-match-index">{String(index + 1).padStart(2, '0')}</div>
      <div className="in-depth-match-date">
        <span>{dateLabel}</span>
        <small>{match.competition}</small>
      </div>
      <div className="in-depth-match-scoreline">
        <span className={teamSide === 'home' ? 'is-current-team' : ''}>{match.homeTeam}</span>
        <strong>{scoresAvailable ? `${match.homeScore} – ${match.awayScore}` : '— : —'}</strong>
        <span className={teamSide === 'away' ? 'is-current-team' : ''}>{match.awayTeam}</span>
      </div>
      <div className="in-depth-match-result">
        {result ? <ResultMark result={result} /> : <span className="in-depth-no-result">No result</span>}
      </div>
      {source ? (
        <a className="in-depth-match-source" href={source} target="_blank" rel="noreferrer" aria-label={`Open source for ${match.homeTeam} versus ${match.awayTeam}`} data-testid={`link-match-source-${match.id}`}>
          <ExternalLink size={13} />
        </a>
      ) : <span className="in-depth-match-source is-unavailable" aria-label="Match source unavailable">—</span>}
    </article>
  );
}

export function TeamInDepthDetails({ details, showNextMatch = true }: Props) {
  const teamName = details.team.name;
  const teamSlug = details.team.slug;
  const validMatches = completedMatches(details.recentMatches);
  const teamMatches = validMatches.flatMap((match) => {
    const perspective = scorePerspective(match, teamName, teamSlug);
    return perspective ? [{ match, ...perspective }] : [];
  });
  const form = [...teamMatches].reverse().map(({ forGoals, againstGoals }) => (
    forGoals > againstGoals ? 'W' : forGoals < againstGoals ? 'L' : 'D'
  ));
  const goalsFor = teamMatches.reduce((sum, match) => sum + match.forGoals, 0);
  const goalsAgainst = teamMatches.reduce((sum, match) => sum + match.againstGoals, 0);
  const cleanSheets = teamMatches.filter((match) => match.againstGoals === 0).length;
  const bttsYes = teamMatches.filter((match) => match.forGoals > 0 && match.againstGoals > 0).length;
  const over25 = teamMatches.filter((match) => match.forGoals + match.againstGoals > 2.5).length;
  const over35 = teamMatches.filter((match) => match.forGoals + match.againstGoals > 3.5).length;
  const sections = details.pages.flatMap((page) => page.sections.map((section) => ({ page, section })));
  const nextMatchPath = canonicalPath(details.nextMatch?.sourceUrl);
  const nextMatchSource = details.nextMatch ? safeExternalUrl(details.nextMatch.sourceUrl) : undefined;
  const eloStats = details.eloAnalysisStats || [];
  const eloFixture = details.eloAnalysisMatch;
  const baseEloStat = eloMetric(eloStats, ['elo'], ['general', 'country', 'tilt', 'rank']);
  const fallbackEloStat = eloMetric(eloStats, ['elo'], ['general', 'country', 'tilt']);
  const generalRankStat = eloMetric(eloStats, ['general'], []) ?? eloMetric(eloStats, ['rank'], ['country', 'tilt']);
  const countryRankStat = eloMetric(eloStats, ['country'], []);
  const tiltStat = eloMetric(eloStats, ['tilt'], []);
  const eloDisplay = statValueForTeam(baseEloStat ?? fallbackEloStat, eloFixture, teamName, teamSlug) ?? details.team.elo ?? 'Unavailable';
  const generalRankDisplay = statValueForTeam(generalRankStat, eloFixture, teamName, teamSlug) ?? 'Unavailable';
  const countryRankDisplay = statValueForTeam(countryRankStat, eloFixture, teamName, teamSlug) ?? 'Unavailable';
  const tiltDisplay = statValueForTeam(tiltStat, eloFixture, teamName, teamSlug) ?? 'Unavailable';
  const eloFixtureDate = eloFixture ? new Date(eloFixture.kickoff) : null;
  const eloFixtureDateLabel = eloFixtureDate && !Number.isNaN(eloFixtureDate.getTime())
    ? new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' }).format(eloFixtureDate)
    : eloFixture?.kickoff;
  const eloFixtureSource = eloFixture ? safeExternalUrl(eloFixture.sourceUrl) : undefined;

  return (
    <div className="in-depth-dossier" data-testid="team-in-depth-dossier">
      <section className="in-depth-overview" aria-labelledby="in-depth-overview-title">
        <div className="in-depth-overview-head">
          <div>
            <p className="in-depth-kicker">FORM & PERFORMANCE / LAST TEN COMPLETED</p>
            <h3 id="in-depth-overview-title">A club-wide readout<span>.</span></h3>
          </div>
          <div className="in-depth-sample">
            <span>RESULTS IN SAMPLE</span>
            <strong data-testid="text-form-sample">{teamMatches.length.toString().padStart(2, '0')} <small>/ {details.recentMatches.length.toString().padStart(2, '0')}</small></strong>
          </div>
        </div>
        <div className="in-depth-form-line" data-testid="list-team-form">
          <span className="in-depth-label">FORM</span>
          {form.length ? (
            <div className="in-depth-form-marks">
              {form.map((result, index) => <ResultMark key={`${index}-${result}`} result={result as 'W' | 'D' | 'L'} />)}
            </div>
          ) : (
            <span className="in-depth-missing">Recent scores do not identify this club in the returned fixtures.</span>
          )}
          <span className="in-depth-form-order">OLDEST <Minus size={11} /> MOST RECENT</span>
        </div>
        <div className="in-depth-stat-grid">
          <div className="in-depth-stat-cell" data-testid="stat-average-goals-for">
            <span>GOALS FOR / MATCH</span>
            <strong>{average(goalsFor, teamMatches.length)}</strong>
            <small>{teamMatches.length ? `${goalsFor} goals across ${teamMatches.length} scored results` : 'No scored results available'}</small>
          </div>
          <div className="in-depth-stat-cell" data-testid="stat-average-goals-against">
            <span>GOALS AGAINST / MATCH</span>
            <strong>{average(goalsAgainst, teamMatches.length)}</strong>
            <small>{teamMatches.length ? `${goalsAgainst} conceded across ${teamMatches.length} scored results` : 'No scored results available'}</small>
          </div>
          <div className="in-depth-stat-cell" data-testid="stat-clean-sheets">
            <span>CLEAN SHEETS</span>
            <strong>{teamMatches.length ? `${cleanSheets}/${teamMatches.length}` : '—'}</strong>
            <small>Matches with no goals conceded</small>
          </div>
          <div className="in-depth-stat-cell" data-testid="stat-btts">
            <span>BOTH TEAMS TO SCORE</span>
            <strong>{teamMatches.length ? `${bttsYes} / ${teamMatches.length - bttsYes}` : '—'}</strong>
            <small>Yes / no</small>
          </div>
          <div className="in-depth-stat-cell" data-testid="stat-over-under-25">
            <span>OVER / UNDER 2.5</span>
            <strong>{teamMatches.length ? `${over25} / ${teamMatches.length - over25}` : '—'}</strong>
            <small>Total goals, over / under</small>
          </div>
          <div className="in-depth-stat-cell" data-testid="stat-over-under-35">
            <span>OVER / UNDER 3.5</span>
            <strong>{teamMatches.length ? `${over35} / ${teamMatches.length - over35}` : '—'}</strong>
            <small>Total goals, over / under</small>
          </div>
        </div>
      </section>

      <section className="in-depth-elo-panel" aria-label="Available Elo ratings" data-testid="team-elo-availability">
        <div className="in-depth-elo-reference">
          <div>
            <span className="in-depth-kicker">RATING SIGNAL / REFERENCE MATCH</span>
            {eloFixture ? (
              <>
                <strong>{eloFixture.homeTeam} <i>v</i> {eloFixture.awayTeam}</strong>
                <p>{eloFixture.competition}{eloFixtureDateLabel ? ` · ${eloFixtureDateLabel}` : ''}</p>
              </>
            ) : (
              <>
                <strong>Reference match unavailable</strong>
                <p>No Elo analysis fixture was supplied.</p>
              </>
            )}
          </div>
          {eloFixture ? (
            <div className="in-depth-elo-reference-side">
              {eloFixture.homeScore !== null && eloFixture.awayScore !== null
                ? <span>{eloFixture.homeScore} – {eloFixture.awayScore}</span>
                : <span>{eloFixture.status}</span>}
              {eloFixtureSource ? (
                <a href={eloFixtureSource} target="_blank" rel="noreferrer" aria-label="Open Elo reference match source" data-testid="link-elo-reference-match">
                  <ExternalLink size={13} />
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
        <div>
          <span className="in-depth-kicker">TEAM RATINGS</span>
          <strong>Available Elo</strong>
        </div>
        <div className="in-depth-elo-item">
          <span>ELO</span>
          <strong data-testid="text-elo-rating">{eloDisplay}</strong>
        </div>
        <div className="in-depth-elo-item">
          <span>GENERAL ELO RANKING</span>
          <strong data-testid="text-general-elo-ranking">{generalRankDisplay}</strong>
        </div>
        <div className="in-depth-elo-item">
          <span>COUNTRY ELO RANKING</span>
          <strong data-testid="text-country-elo-ranking">{countryRankDisplay}</strong>
        </div>
        <div className="in-depth-elo-item">
          <span>TILT</span>
          <strong data-testid="text-elo-tilt">{tiltDisplay}</strong>
        </div>
      </section>

      <section className="in-depth-source-grid" aria-label="Source-backed club detail sections">
        {dossierSections.map((group) => {
          const found = sections.filter(({ section }) => {
            const searchable = `${section.title} ${section.text.join(' ')} ${(section.blocks || []).map((block) => `${block.text || ''} ${(block.headers || []).join(' ')}`).join(' ')}`.toLocaleLowerCase();
            return group.terms.some((term) => searchable.includes(term));
          });
          return (
            <article className="in-depth-source-card" key={group.id} data-testid={`dossier-${group.id}`}>
              <header>
                <div>
                  <span className="in-depth-kicker">{group.id.toUpperCase()} / SOURCE FILE</span>
                  <h3>{group.title}</h3>
                </div>
                <p>{group.note}</p>
              </header>
              {found.length ? (
                <div className="in-depth-source-sections">
                  {found.map(({ page, section }, index) => (
                    <div key={`${page.tab}-${section.title}-${index}`}>
                      <SourceSection section={section} />
                      {safeExternalUrl(page.sourceUrl) ? (
                        <a className="in-depth-section-source" href={safeExternalUrl(page.sourceUrl)} target="_blank" rel="noreferrer" data-testid={`link-section-source-${group.id}-${index}`}>
                          OPEN SOURCE PAGE <ExternalLink size={11} />
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="in-depth-source-unavailable" data-testid={`status-missing-${group.id}`}>
                  <span>NOT IN THE RETURNED SOURCE DATA</span>
                  <p>No matching source section was supplied for this detail.</p>
                </div>
              )}
            </article>
          );
        })}
      </section>

      <section className="in-depth-matches" aria-labelledby="recent-matches-title">
        <header className="in-depth-section-heading">
          <div>
            <p className="in-depth-kicker">RESULT LOG / SCORED FIXTURES ONLY</p>
            <h3 id="recent-matches-title">Recent ten matches</h3>
          </div>
          <span>{details.recentMatches.length.toString().padStart(2, '0')} SOURCE ROWS</span>
        </header>
        {details.recentMatches.length ? (
          <div className="in-depth-match-list">
            {details.recentMatches.map((match, index) => <MatchRow key={match.id} match={match} teamName={teamName} teamSlug={teamSlug} index={index} />)}
          </div>
        ) : (
          <div className="in-depth-source-unavailable" data-testid="status-no-recent-matches">
            <span>RECENT RESULTS NOT SUPPLIED</span>
            <p>There are no completed fixture rows in this team response.</p>
          </div>
        )}
      </section>

      {showNextMatch ? (
        <section className="in-depth-next-match" aria-labelledby="next-match-title">
          <header className="in-depth-section-heading">
            <div>
              <p className="in-depth-kicker">UPCOMING / BE SOCCER MARKETS</p>
              <h3 id="next-match-title">Next scheduled match</h3>
            </div>
            {nextMatchSource ? (
              <a href={nextMatchSource} target="_blank" rel="noreferrer" data-testid="link-next-match-source">MATCH SOURCE <ExternalLink size={12} /></a>
            ) : null}
          </header>
          {details.nextMatch ? (
            <>
              <div className="in-depth-next-fixture" data-testid="next-match-fixture">
                <div>
                  <span>{details.nextMatch.competition}</span>
                  <strong>{details.nextMatch.homeTeam} <i>v</i> {details.nextMatch.awayTeam}</strong>
                  <small>{new Date(details.nextMatch.kickoff).toLocaleString()}</small>
                </div>
                <div className="in-depth-kickoff-status">
                  <span>{details.nextMatch.status || 'Scheduled'}</span>
                  {nextMatchSource ? <a href={nextMatchSource} target="_blank" rel="noreferrer" aria-label="Open scheduled match source"><ExternalLink size={14} /></a> : null}
                </div>
              </div>
              <OddsPanel matchId={details.nextMatch.id} sourcePath={nextMatchPath} />
            </>
          ) : (
            <div className="in-depth-source-unavailable" data-testid="status-no-next-match">
              <span>NO UPCOMING FIXTURE SUPPLIED</span>
              <p>Odds are shown when a scheduled match is present in the club response.</p>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
