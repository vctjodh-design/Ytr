import { useState } from 'react';
import { CircleAlert, ExternalLink, RotateCw } from 'lucide-react';
import {
  getGetTeamDetailsQueryKey,
  useGetTeamDetails,
  type Fixture,
} from '@workspace/api-client-react';
import { OddsPanel } from '@/components/odds-panel';
import { TeamInDepthDetails } from '@/components/team-in-depth-details';

type Side = 'home' | 'away';

type Props = {
  fixture: Fixture;
  matchId: string;
  sourcePath?: string;
  homeTeamSlug?: string | null;
  awayTeamSlug?: string | null;
};

function matchSourcePath(fixture: Fixture, sourcePath?: string) {
  if (sourcePath) return sourcePath;
  try {
    const url = new URL(fixture.sourceUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

function TeamChoice({
  side,
  name,
  badgeUrl,
  selected,
  disabled,
  onSelect,
}: {
  side: Side;
  name: string;
  badgeUrl?: string | null;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`match-team-choice ${selected ? 'is-selected' : ''}`}
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      data-testid={`button-match-team-${side}`}
    >
      <span className="match-team-choice-badge">
        {badgeUrl ? <img src={badgeUrl} alt="" /> : name.trim().slice(0, 1).toUpperCase()}
      </span>
      <span className="match-team-choice-copy">
        <small>{side === 'home' ? 'HOME TEAM' : 'AWAY TEAM'}</small>
        <strong>{name}</strong>
      </span>
    </button>
  );
}

export function MatchTeamDetails({
  fixture,
  matchId,
  sourcePath,
  homeTeamSlug,
  awayTeamSlug,
}: Props) {
  const [selectedSide, setSelectedSide] = useState<Side>(homeTeamSlug ? 'home' : 'away');
  const selectedSlug = selectedSide === 'home' ? homeTeamSlug : awayTeamSlug;
  const selectedName = selectedSide === 'home' ? fixture.homeTeam : fixture.awayTeam;
  const selectedBadge = selectedSide === 'home' ? fixture.homeBadgeUrl : fixture.awayBadgeUrl;
  const teamQuery = useGetTeamDetails(selectedSlug || '', {
    query: {
      enabled: Boolean(selectedSlug),
      queryKey: getGetTeamDetailsQueryKey(selectedSlug || ''),
      staleTime: 120_000,
      refetchOnMount: true,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  });
  const currentMatchPath = matchSourcePath(fixture, sourcePath);

  return (
    <div className="match-team-dossier" data-testid="match-team-dossier">
      <section className="match-team-dossier-switcher">
        <div className="match-team-dossier-intro">
          <p className="in-depth-kicker">BOTH CLUBS / CURRENT FIXTURE</p>
          <h3>In-depth team details</h3>
          <p>Select either club to view its coach, squad, standings, availability, ratings, and last ten results.</p>
        </div>
        <div className="match-team-choice-list" role="group" aria-label="Choose a team">
          <TeamChoice
            side="home"
            name={fixture.homeTeam}
            badgeUrl={fixture.homeBadgeUrl}
            selected={selectedSide === 'home'}
            disabled={!homeTeamSlug}
            onSelect={() => setSelectedSide('home')}
          />
          <TeamChoice
            side="away"
            name={fixture.awayTeam}
            badgeUrl={fixture.awayBadgeUrl}
            selected={selectedSide === 'away'}
            disabled={!awayTeamSlug}
            onSelect={() => setSelectedSide('away')}
          />
        </div>
      </section>

      <section className="match-team-current-odds" aria-labelledby="match-team-odds-title">
        <header>
          <div>
            <p className="in-depth-kicker">CURRENT MATCH / AVAILABLE MARKETS</p>
            <h3 id="match-team-odds-title">{fixture.homeTeam} <i>v</i> {fixture.awayTeam}</h3>
          </div>
          {fixture.sourceUrl ? (
            <a href={fixture.sourceUrl} target="_blank" rel="noreferrer" data-testid="link-team-details-match-source">
              MATCH SOURCE <ExternalLink size={12} />
            </a>
          ) : null}
        </header>
        <OddsPanel matchId={matchId} sourcePath={currentMatchPath} />
      </section>

      {!selectedSlug ? (
        <div className="error-panel match-team-dossier-error" role="status" data-testid="status-team-details-unavailable">
          <CircleAlert size={20} />
          <div>
            <strong>Team source link unavailable.</strong>
            <p>We couldn’t identify the BeSoccer team profile for {selectedName} from this match.</p>
          </div>
        </div>
      ) : teamQuery.isLoading ? (
        <div className="match-team-dossier-loading" role="status" data-testid="status-team-details-loading">
          <span className="team-loading-bar" />
          <div>
            <strong>Loading {selectedName} team details</strong>
            <p>Fetching the team pages and recent match analysis from the source.</p>
          </div>
        </div>
      ) : teamQuery.isError || !teamQuery.data ? (
        <div className="error-panel match-team-dossier-error" role="alert" data-testid="status-team-details-error">
          <CircleAlert size={20} />
          <div>
            <strong>Team details unavailable.</strong>
            <p>We couldn’t retrieve the full team profile for {selectedName}.</p>
          </div>
          <button type="button" onClick={() => teamQuery.refetch()} disabled={teamQuery.isFetching} data-testid="button-retry-team-details">
            <RotateCw size={13} />
            {teamQuery.isFetching ? 'UPDATING' : 'RETRY'}
          </button>
        </div>
      ) : (
        <section className="match-team-dossier-profile" aria-label={`${teamQuery.data.team.name} in-depth team profile`}>
          <header className="match-team-dossier-profile-head">
            <div className="match-team-dossier-profile-identity">
              {teamQuery.data.team.badgeUrl ? (
                <img src={teamQuery.data.team.badgeUrl} alt="" />
              ) : (
                <span>{teamQuery.data.team.name.trim().slice(0, 1).toUpperCase()}</span>
              )}
              <div>
                <p className="in-depth-kicker">{selectedSide === 'home' ? 'HOME TEAM' : 'AWAY TEAM'} / FULL DOSSIER</p>
                <h3>{teamQuery.data.team.name}</h3>
                {teamQuery.data.team.country && <p>{teamQuery.data.team.country}</p>}
              </div>
            </div>
            <a href={teamQuery.data.team.sourceUrl} target="_blank" rel="noreferrer" data-testid="link-open-full-team-profile">
              OPEN TEAM SOURCE <ExternalLink size={12} />
            </a>
          </header>
          <TeamInDepthDetails details={teamQuery.data} showNextMatch={false} />
        </section>
      )}
    </div>
  );
}
