import { useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  CircleAlert,
  RotateCw,
} from 'lucide-react';
import {
  getGetMatchOddsQueryKey,
  useGetMatchOdds,
  type GetMatchOddsParams,
  type OddsPeriod,
} from '@workspace/api-client-react';

const markets = [
  { id: '1', name: '1X2' },
  { id: '2', name: 'Over/under' },
  { id: '4', name: 'Both teams to score' },
  { id: '5', name: 'Double chance' },
  { id: '6', name: 'European handicap' },
  { id: '7', name: 'Draw no bet' },
  { id: '8', name: 'Correct score' },
  { id: '9', name: 'Half time/full time' },
  { id: '10', name: 'Odd/even' },
  { id: '3', name: 'Asian handicap' },
] as const;

type MarketId = typeof markets[number]['id'];

function outcomeColumns(period: OddsPeriod) {
  if (period.columns.length) return period.columns;
  return Array.from(
    new Set(
      period.groups.flatMap((group) =>
        group.bookmakers.flatMap((bookmaker) =>
          bookmaker.outcomes.map((outcome) => outcome.label),
        ),
      ),
    ),
  );
}

export function OddsPanel({
  matchId,
  sourcePath,
}: {
  matchId: string;
  sourcePath?: string;
}) {
  const [marketId, setMarketId] = useState<MarketId>('1');
  const [periodId, setPeriodId] = useState('ft');
  const params: GetMatchOddsParams = {
    marketId,
    ...(sourcePath ? { sourcePath } : {}),
  };
  const { data, isLoading, isError, isFetching, refetch } = useGetMatchOdds(
    matchId,
    params,
    {
      query: {
        enabled: Boolean(matchId),
        queryKey: getGetMatchOddsQueryKey(matchId, params),
      },
    },
  );
  const period =
    data?.periods.find((item) => item.id === periodId) ?? data?.periods[0];
  const columns = period ? outcomeColumns(period) : [];

  return (
    <div className="odds-panel" data-testid="match-odds-panel">
      <div className="odds-market-selector" role="tablist" aria-label="Odds markets">
        {markets.map((market) => (
          <button
            type="button"
            role="tab"
            aria-selected={marketId === market.id}
            className={`odds-market-button ${marketId === market.id ? 'active' : ''}`}
            key={market.id}
            onClick={() => {
              setMarketId(market.id);
              setPeriodId('ft');
            }}
            data-testid={`odds-market-${market.id}`}
          >
            {market.name}
          </button>
        ))}
      </div>

      {data?.sourceRegion && (
        <p className="odds-region-note">
          BOOKMAKER FEED: {data.sourceRegion} <span>·</span> operators and prices vary by region
        </p>
      )}

      {isLoading ? (
        <div className="odds-state" role="status">Loading market prices…</div>
      ) : isError ? (
        <div className="error-panel odds-error" data-testid="status-odds-error">
          <CircleAlert size={18} />
          <div>
            <strong>Odds could not be loaded.</strong>
            <p>The source may be temporarily unavailable.</p>
          </div>
          <button type="button" onClick={() => refetch()} disabled={isFetching}>
            <RotateCw size={13} /> Try again
          </button>
        </div>
      ) : !data || !period ? (
        <div className="odds-empty" data-testid="status-odds-empty">
          <strong>{data?.marketName ?? 'Market'} prices unavailable</strong>
          <p>BeSoccer did not return bookmaker prices for this market in the current feed.</p>
        </div>
      ) : (
        <>
          {data.periods.length > 1 && (
            <div className="odds-period-selector" role="tablist" aria-label="Odds period">
              {data.periods.map((item) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={period.id === item.id}
                  className={`odds-period-button ${period.id === item.id ? 'active' : ''}`}
                  key={item.id}
                  onClick={() => setPeriodId(item.id)}
                >
                  {item.name}
                </button>
              ))}
            </div>
          )}

          <section className="odds-period-content" aria-label={`${data.marketName} ${period.name}`}>
            <div className="odds-period-heading">
              <div>
                <span className="eyebrow-mark">LIVE SOURCE DATA</span>
                <h3>{data.marketName}<span> / {period.name}</span></h3>
              </div>
              {isFetching && <span className="odds-updating">UPDATING</span>}
            </div>
            {period.groups.length ? (
              <div className="table-scroll odds-table-scroll">
                <table className="odds-table market-odds-table">
                  <thead>
                    <tr>
                      <th>{marketId === '8' ? 'SCORE' : marketId === '9' ? 'HALF / FULL' : 'LINE'}</th>
                      <th>BOOKMAKER</th>
                      {columns.map((column) => <th key={column}>{column}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {period.groups.flatMap((group, groupIndex) =>
                      group.bookmakers.map((bookmaker, bookmakerIndex) => (
                        <tr key={`${groupIndex}-${bookmaker.name}-${bookmakerIndex}`}>
                          <td className="odds-line-label">{group.label ?? '—'}</td>
                          <td className="bookmaker">{bookmaker.name}</td>
                          {columns.map((column) => {
                            const outcome = bookmaker.outcomes.find(
                              (item) => item.label.toLowerCase() === column.toLowerCase(),
                            );
                            return (
                              <td key={column}>
                                {outcome?.price ? (
                                  <span
                                    className={`odds-price ${outcome.movement === 'up' ? 'is-up' : outcome.movement === 'down' ? 'is-down' : ''}`}
                                    title={outcome.initialPrice ? `Opening price: ${outcome.initialPrice}` : undefined}
                                  >
                                    {outcome.price}
                                    {outcome.movement === 'up' && <ArrowUpRight size={12} aria-label="Odds moved up" />}
                                    {outcome.movement === 'down' && <ArrowDownRight size={12} aria-label="Odds moved down" />}
                                  </span>
                                ) : '—'}
                              </td>
                            );
                          })}
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="odds-empty">
                <strong>No prices for this period</strong>
                <p>The selected bookmaker feed has no prices for {period.name.toLowerCase()}.</p>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
