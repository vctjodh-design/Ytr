import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ArrowLeft, CircleAlert, ExternalLink, RotateCw } from 'lucide-react';
import {
  getGetPlayerDetailsQueryKey,
  useGetPlayerDetails,
} from '@workspace/api-client-react';
import type { PlayerContentPageTab } from '@workspace/api-client-react';
import { Link, useParams } from 'wouter';
import { BrandMark } from '@/components/brand-mark';
import { MatchSourceContent } from '@/components/match-source-content';
import { SectionEmpty } from '@/components/section-empty';
import { TeamCrest } from '@/components/team-crest';

const tabs: { id: PlayerContentPageTab; label: string }[] = [
  { id: 'info', label: 'Info' },
  { id: 'matches', label: 'Matches' },
  { id: 'career', label: 'Career' },
  { id: 'achievements', label: 'Achievements' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'attributes', label: 'Attributes' },
  { id: 'transfers', label: 'Transfers' },
  { id: 'teammates', label: 'Teammates' },
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

function displayValue(value: string | number | null | undefined, suffix = '') {
  return value === null || value === undefined || value === '' ? '—' : `${value}${suffix}`;
}

export default function PlayerPage() {
  const { playerSlug = '' } = useParams<{ playerSlug: string }>();
  const [tab, setTab] = useState<PlayerContentPageTab>('info');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const profileQuery = useGetPlayerDetails(playerSlug, { tab: 'info' }, {
    query: {
      enabled: Boolean(playerSlug),
      queryKey: getGetPlayerDetailsQueryKey(playerSlug, { tab: 'info' }),
      staleTime: 90_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  });
  const sectionQuery = useGetPlayerDetails(playerSlug, { tab }, {
    query: {
      enabled: Boolean(playerSlug) && tab !== 'info',
      queryKey: getGetPlayerDetailsQueryKey(playerSlug, { tab }),
      staleTime: 90_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  });
  const activeQuery = tab === 'info' ? profileQuery : sectionQuery;
  const data = activeQuery.data;
  const isLoading = profileQuery.isLoading;
  const isError = profileQuery.isError;
  const refetch = activeQuery.refetch;
  const isFetching = activeQuery.isFetching;
  const player = profileQuery.data?.player ?? data?.player;
  const page = data?.pages?.find((item) => item.tab === tab);
  const sourceLink = validHttpUrl(player?.sourceUrl);
  const activeTabIndex = tabs.findIndex((item) => item.id === tab);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setTab(tabs[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <main className="desk-shell player-profile-shell">
      <header className="topbar">
        <BrandMark />
        <div className="topbar-center">
          <span className="desk-status"><i /> PLAYER DOSSIER</span>
          <span className="topbar-divider" />
          <span className="topbar-tagline">A record built from the source.</span>
        </div>
        <Link href="/" className="back-link" data-testid="link-player-back-fixtures">
          <ArrowLeft size={15} />
          ALL FIXTURES
        </Link>
      </header>

      <div className="player-page">
        <div className="player-breadcrumb">
          <Link href="/" data-testid="link-player-home">FIXTURES</Link>
          <span>/</span>
          <span>PLAYER FILE</span>
          {player && (
            <button
              type="button"
              className={`refresh-button player-refresh ${isFetching ? 'is-refreshing' : ''}`}
              onClick={() => refetch()}
              disabled={isFetching}
              data-testid="button-refresh-player"
            >
              <RotateCw size={13} />
              {isFetching ? 'UPDATING' : 'REFRESH'}
            </button>
          )}
        </div>

        {isLoading ? (
          <section className="player-loading" role="status" aria-label="Loading player profile" data-testid="status-player-loading">
            <div className="player-skeleton-portrait" />
            <div className="player-skeleton-copy">
              <span />
              <span />
              <span />
            </div>
          </section>
        ) : isError ? (
          <div className="error-panel player-error" data-testid="status-player-error">
            <CircleAlert size={22} />
            <div>
              <strong>Player file unavailable.</strong>
              <p>We couldn’t retrieve this player’s record from the source.</p>
            </div>
            <button type="button" onClick={() => refetch()} disabled={isFetching} data-testid="button-retry-player">
              {isFetching ? 'Retrying' : 'Try again'}
            </button>
          </div>
        ) : !profileQuery.data || !player ? (
          <SectionEmpty
            title="Player file not found"
            detail="No player record was returned for this address. Check the link or return to fixtures."
          />
        ) : (
          <>
            <section className="player-identity" data-testid="player-profile">
              <div className="player-portrait">
                <span className="player-initials" aria-hidden="true">
                  {player.name.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}
                </span>
                {player.photoUrl && (
                  <img
                    src={player.photoUrl}
                    alt={`${player.name} portrait`}
                    data-testid="img-player-photo"
                    onError={(event) => { event.currentTarget.style.display = 'none'; }}
                  />
                )}
                {player.shirtNumber !== null && player.shirtNumber !== undefined && (
                  <span className="player-shirt-number" aria-label={`Shirt number ${player.shirtNumber}`}>
                    {player.shirtNumber}
                  </span>
                )}
              </div>

              <div className="player-identity-copy">
                <p className="eyebrow"><span className="eyebrow-mark">PLAYER FILE</span> / {player.slug}</p>
                <h1 data-testid="text-player-name">{player.name}</h1>
                <div className="player-role-line">
                  {player.position && <span className="player-position">{player.position}</span>}
                  {player.position && player.currentTeam && <span className="player-meta-separator" />}
                  {player.currentTeam && (
                    player.teamSlug ? (
                      <Link
                        href={`/team/${encodeURIComponent(player.teamSlug)}`}
                        className="player-team-link"
                        data-testid="link-player-team"
                      >
                        <TeamCrest
                          src={player.teamBadgeUrl}
                          name={player.currentTeam}
                          size="sm"
                        />
                        <span>{player.currentTeam}</span>
                      </Link>
                    ) : (
                      <span className="player-team-link is-unlinked" data-testid="text-player-team">
                        <TeamCrest src={player.teamBadgeUrl} name={player.currentTeam} size="sm" />
                        <span>{player.currentTeam}</span>
                      </span>
                    )
                  )}
                </div>
                {player.nationality && (
                  <div className="player-nationality" data-testid="text-player-nationality">
                    {player.nationalityFlagUrl && (
                      <img src={player.nationalityFlagUrl} alt="" loading="lazy" />
                    )}
                    <span>{player.nationality}</span>
                  </div>
                )}
              </div>

              <dl className="player-facts">
                <div className="player-fact">
                  <dt>AGE</dt>
                  <dd>{displayValue(player.age)}</dd>
                </div>
                <div className="player-fact">
                  <dt>HEIGHT</dt>
                  <dd>{displayValue(player.heightCm, ' cm')}</dd>
                </div>
                <div className="player-fact">
                  <dt>WEIGHT</dt>
                  <dd>{displayValue(player.weightKg, ' kg')}</dd>
                </div>
                <div className="player-fact player-fact-accent">
                  <dt>RATING</dt>
                  <dd>{displayValue(player.rating)}</dd>
                </div>
                <div className="player-fact player-value-fact">
                  <dt>MARKET VALUE</dt>
                  <dd>{displayValue(player.marketValue)}</dd>
                </div>
              </dl>
            </section>

            <nav className="player-tabs" aria-label="Player profile sections" role="tablist">
              {tabs.map((item, index) => (
                <button
                  type="button"
                  role="tab"
                  id={`player-tab-${item.id}`}
                  aria-selected={tab === item.id}
                  aria-controls="player-tab-panel"
                  tabIndex={tab === item.id ? 0 : -1}
                  className={tab === item.id ? 'player-tab active' : 'player-tab'}
                  key={item.id}
                  ref={(element) => { tabRefs.current[index] = element; }}
                  onClick={() => setTab(item.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  data-testid={`tab-player-${item.id}`}
                >
                  <span className="player-tab-index">{String(index + 1).padStart(2, '0')}</span>
                  {item.label}
                </button>
              ))}
            </nav>

            <section
              className="player-content"
              id="player-tab-panel"
              role="tabpanel"
              aria-labelledby={`player-tab-${tab}`}
              tabIndex={0}
              key={tab}
            >
              <header className="player-content-heading">
                <div>
                  <p className="eyebrow"><span className="eyebrow-mark">{String(activeTabIndex + 1).padStart(2, '0')}</span> / PLAYER RECORD</p>
                  <h2>{tabs[activeTabIndex]?.label}<em> / source file</em></h2>
                </div>
                <span className="player-source-note">{tab.toUpperCase()} / API-PROVIDED CONTENT</span>
              </header>
              {tab !== 'info' && sectionQuery.isLoading ? (
                <div className="player-loading" role="status" data-testid="status-player-tab-loading">
                  <div className="player-skeleton-copy"><span /><span /><span /></div>
                </div>
              ) : tab !== 'info' && sectionQuery.isError ? (
                <div className="error-panel player-error" role="alert" data-testid="status-player-tab-error">
                  <CircleAlert size={20} />
                  <div><strong>This section is unavailable.</strong><p>The source page could not be loaded.</p></div>
                  <button type="button" onClick={() => sectionQuery.refetch()} disabled={sectionQuery.isFetching}>
                    {sectionQuery.isFetching ? 'Retrying' : 'Try again'}
                  </button>
                </div>
              ) : page ? (
                <MatchSourceContent page={page} tab={tabs[activeTabIndex]?.label || tab} />
              ) : (
                <SectionEmpty
                  title={`${tabs[activeTabIndex]?.label || tab} not supplied`}
                  detail="No page for this section was included in the player profile response."
                />
              )}
            </section>

            <footer className="page-foot player-page-foot">
              <span>TOUCHLINE DESK <b>·</b> {player.slug}</span>
              <span>
                {sourceLink ? (
                  <a href={sourceLink} target="_blank" rel="noreferrer" data-testid="link-player-source">
                    ORIGINAL PLAYER SOURCE <ExternalLink size={12} />
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
