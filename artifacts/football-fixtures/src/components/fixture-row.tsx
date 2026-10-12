import { ArrowUpRight, Clock3 } from 'lucide-react';
import { Link } from 'wouter';
import type { Fixture } from '@workspace/api-client-react';
import { TeamCrest } from './team-crest';

function timeLabel(kickoff: string) {
  const date = new Date(kickoff);
  return Number.isNaN(date.getTime()) ? kickoff : new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function matchState(fixture: Fixture) {
  const state = fixture.status.toLowerCase();
  if (state.includes('live') || state.includes('playing')) return 'LIVE';
  if (state.includes('finished') || state.includes('ended')) return 'FT';
  if (fixture.homeScore !== null && fixture.awayScore !== null) return 'FT';
  return timeLabel(fixture.kickoff);
}

function matchHref(fixture: Fixture) {
  try {
    const path = new URL(fixture.sourceUrl).pathname.replace(/\/+$/, '');
    if (/^\/match\/[a-z0-9-]+\/[a-z0-9-]+\/\d+$/i.test(path) && path.endsWith(`/${fixture.id}`)) {
      return path;
    }
  } catch {
    // Keep legacy fixture links usable if the source URL is malformed.
  }
  return `/match/${encodeURIComponent(fixture.id)}`;
}

export function FixtureRow({ fixture }: { fixture: Fixture }) {
  const isLive = matchState(fixture) === 'LIVE';
  const hasScore = fixture.homeScore !== null && fixture.awayScore !== null;
  return (
    <Link href={matchHref(fixture)} className="fixture-row" data-testid={`link-fixture-${fixture.id}`}>
      <div className="fixture-state">
        <span className={isLive ? 'live-label' : 'kickoff-label'}>{isLive && <i />}{matchState(fixture)}</span>
        {fixture.round && <span className="fixture-round">{fixture.round}</span>}
      </div>
      <div className="fixture-versus">
        <div className="fixture-team home-team">
          <TeamCrest src={fixture.homeBadgeUrl} name={fixture.homeTeam} />
          <span>{fixture.homeTeam}</span>
        </div>
        <div className={`fixture-score ${hasScore ? 'has-score' : ''}`}>
          {hasScore ? <><b>{fixture.homeScore}</b><span>–</span><b>{fixture.awayScore}</b></> : <span className="versus-at">vs</span>}
        </div>
        <div className="fixture-team away-team">
          <TeamCrest src={fixture.awayBadgeUrl} name={fixture.awayTeam} />
          <span>{fixture.awayTeam}</span>
        </div>
      </div>
      <span className="fixture-open"><ArrowUpRight size={16} /></span>
    </Link>
  );
}

export function FixtureSkeleton() {
  return <div className="fixture-skeleton"><span /><span /><span /></div>;
}

export function KickoffIcon() {
  return <Clock3 size={13} />;
}
