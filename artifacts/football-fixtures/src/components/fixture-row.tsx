import { ArrowUpRight, Clock3 } from 'lucide-react';
import { Link } from 'wouter';
import type { Fixture } from '@workspace/api-client-react';
import { TeamCrest } from './team-crest';

function dateLabel(kickoff: string) {
  const match = kickoff.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return kickoff;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  const parts = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short' }).formatToParts(date);
  const day = parts.find((part) => part.type === 'day')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return day && month ? `${day} ${month}`.toUpperCase() : kickoff;
}

function timeLabel(kickoff: string, selectedDate: string) {
  const kickoffDate = kickoff.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (kickoffDate && kickoffDate !== selectedDate) return dateLabel(kickoff);

  const time = kickoff.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!time) return kickoffDate ? 'TIME TBC' : kickoff;
  const date = new Date(2000, 0, 1, Number(time[1]), Number(time[2]));
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function matchState(fixture: Fixture, selectedDate: string) {
  const state = fixture.status.toLowerCase();
  if (state.includes('live') || state.includes('playing')) return 'LIVE';
  if (state.includes('finished') || state.includes('ended')) return 'FT';
  if (fixture.homeScore !== null && fixture.awayScore !== null) return 'FT';
  return timeLabel(fixture.kickoff, selectedDate);
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

export function FixtureRow({ fixture, selectedDate }: { fixture: Fixture; selectedDate: string }) {
  const isLive = matchState(fixture, selectedDate) === 'LIVE';
  const hasScore = fixture.homeScore !== null && fixture.awayScore !== null;
  return (
    <Link href={matchHref(fixture)} className="fixture-row" data-testid={`link-fixture-${fixture.id}`}>
      <div className="fixture-state">
        <span className={isLive ? 'live-label' : 'kickoff-label'}>{isLive && <i />}{matchState(fixture, selectedDate)}</span>
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
