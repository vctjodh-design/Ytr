import { useState } from 'react';
import { ArrowLeft, CircleAlert, ExternalLink, RotateCw } from 'lucide-react';
import { getGetTeamDetailsQueryKey, useGetTeamDetails } from '@workspace/api-client-react';
import type { TeamContentPageTab } from '@workspace/api-client-react';
import { Link, useParams } from 'wouter';
import { BrandMark } from '@/components/brand-mark';
import { MatchSourceContent } from '@/components/match-source-content';
import { SectionEmpty } from '@/components/section-empty';
import { TeamInDepthDetails } from '@/components/team-in-depth-details';

type TeamTab = TeamContentPageTab | 'in-depth';

const tabs: { id: TeamTab; label: string }[] = [
  { id: 'info', label: 'Info' },
  { id: 'matches', label: 'Matches' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'squad', label: 'Squad' },
  { id: 'standings', label: 'Standings' },
  { id: 'career', label: 'Career' },
  { id: 'competitions', label: 'Competitions' },
  { id: 'injuries-suspensions', label: 'Injuries & Suspensions' },
  { id: 'honours', label: 'Honours' },
  { id: 'historical', label: 'Historical' },
  { id: 'in-depth', label: 'In-depth team details' },
];

function validHttpUrl(value?: string | null) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export default function TeamPage() {
  const { teamSlug = '' } = useParams<{ teamSlug: string }>();
  const [tab, setTab] = useState<TeamTab>('info');
  const { data, isLoading, isError, refetch, isFetching } = useGetTeamDetails(teamSlug, {
    query: {
      enabled: Boolean(teamSlug),
      queryKey: getGetTeamDetailsQueryKey(teamSlug),
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
      retry: 2,
    },
  });
  const team = data?.team;
  const page = tab === 'in-depth' ? undefined : data?.pages?.find((item) => item.tab === tab);
  const sourceLink = validHttpUrl(team?.sourceUrl);

  return (
    <main className="desk-shell team-profile-shell">
      <header className="topbar">
        <BrandMark />
        <div className="topbar-center">
          <span className="desk-status"><i /> CLUB DOSSIER</span>
          <span className="topbar-divider" />
          <span className="topbar-tagline">Every part of the club, from one source.</span>
        </div>
        <Link href="/" className="back-link" data-testid="link-team-back-fixtures">
          <ArrowLeft size={15} />
          ALL FIXTURES
        </Link>
      </header>
      <div className="team-page">
        <div className="team-breadcrumb">
          <Link href="/" data-testid="link-team-home">FIXTURES</Link>
          <span>/</span>
          <span>CLUB PROFILE</span>
          <button
            type="button"
            className={`refresh-button team-refresh ${isFetching ? 'is-refreshing' : ''}`}
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-team"
          >
            <RotateCw size={13} />
            {isFetching ? 'UPDATING' : 'REFRESH'}
          </button>
        </div>

        {isLoading ? (
          <section className="team-loading" role="status" aria-label="Loading team profile" data-testid="status-team-loading">
            <div className="team-loading-bar" />
            <div className="team-loading-bar" />
          </section>
        ) : isError || !data || !team ? (
          <div className="error-panel team-error" data-testid="status-team-error">
            <CircleAlert size={22} />
            <div>
              <strong>Club profile unavailable.</strong>
              <p>We couldn’t retrieve this team’s profile from the source.</p>
            </div>
            <button type="button" onClick={() => refetch()} disabled={isFetching} data-testid="button-retry-team">
              {isFetching ? 'Retrying' : 'Try again'}
            </button>
          </div>
        ) : (
          <>
            <section className="team-identity" data-testid="team-profile">
              <div className="team-badge-frame">
                {team.badgeUrl ? (
                  <img src={team.badgeUrl} alt={`${team.name} badge`} data-testid="img-team-badge" />
                ) : (
                  <span className="team-badge-placeholder" aria-label="Team badge unavailable">
                    {team.name.trim().slice(0, 1).toUpperCase()}
                  </span>
                )}
              </div>
              <div className="team-identity-copy">
                <p className="eyebrow"><span className="eyebrow-mark">TEAM FILE</span> / {team.slug}</p>
                <h1 data-testid="text-team-name">{team.name}</h1>
                {team.country && (
                  <div className="team-place">
                    {team.countryFlagUrl && <img src={team.countryFlagUrl} alt="" />}
                    <span>{team.country}</span>
                  </div>
                )}
              </div>
              <div className="team-metrics">
                <div className="team-metric">
                  <span>WORLD ELO</span>
                  <strong data-testid="text-team-elo">{team.elo || '—'}</strong>
                </div>
                <div className="team-metric">
                  <span>PAGES</span>
                  <strong>{data.pages.length.toString().padStart(2, '0')}</strong>
                </div>
              </div>
            </section>

            <nav className="team-tabs" aria-label="Team profile sections" role="tablist">
              {tabs.map((item, index) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  aria-controls="team-tab-panel"
                  className={tab === item.id ? 'team-tab active' : 'team-tab'}
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  data-testid={`tab-team-${item.id}`}
                >
                  <span className="team-tab-index">{String(index + 1).padStart(2, '0')}</span>
                  {item.label}
                </button>
              ))}
            </nav>

            <section className="team-content" id="team-tab-panel" role="tabpanel" key={tab}>
              <header className="team-content-heading">
                <div>
                  <p className="eyebrow"><span className="eyebrow-mark">{String(tabs.findIndex((item) => item.id === tab) + 1).padStart(2, '0')}</span> / TEAM INTELLIGENCE</p>
                  <h2>{tabs.find((item) => item.id === tab)?.label}<em> / {tab === 'in-depth' ? 'club dossier' : 'source file'}</em></h2>
                </div>
                <span className="team-source-note">{tab === 'in-depth' ? 'RECENT FORM / SOURCE-BACKED' : `${tab.toUpperCase()} / API-PROVIDED CONTENT`}</span>
              </header>
              {tab === 'in-depth' ? (
                <TeamInDepthDetails details={data} />
              ) : page ? (
                <MatchSourceContent page={page} tab={tabs.find((item) => item.id === tab)?.label || tab} />
              ) : (
                <SectionEmpty
                  title={`${tabs.find((item) => item.id === tab)?.label} not supplied`}
                  detail="No page for this section was included in the team profile response."
                />
              )}
            </section>

            <footer className="page-foot match-foot">
              <span>TOUCHLINE DESK <b>·</b> {team.slug}</span>
              <span>
                {sourceLink ? (
                  <a href={sourceLink} target="_blank" rel="noreferrer" data-testid="link-team-source">
                    ORIGINAL TEAM SOURCE <ExternalLink size={12} />
                  </a>
                ) : 'SOURCE LINK NOT PROVIDED'}
              </span>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}
