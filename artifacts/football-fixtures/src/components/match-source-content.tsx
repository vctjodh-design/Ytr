import { ExternalLink, FileText } from 'lucide-react';
import { Link } from 'wouter';
import type { MatchContentPage } from '@workspace/api-client-react';

type SourcePage = Pick<MatchContentPage, 'sourceUrl' | 'sections'> & { tab: string };

function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function MatchSourceContent({ page, tab }: { page?: SourcePage; tab: string }) {
  if (!page) {
    return (
      <section className="match-source-empty" aria-label={`${tab} source breakdown`}>
        <span className="source-empty-index">SOURCE BREAKDOWN</span>
        <p>No parsed source page was returned for {tab}.</p>
      </section>
    );
  }

  const sourceLink = safeSourceUrl(page.sourceUrl);
  const hasSections = page.sections.length > 0;

  return (
    <section className="match-source-content" aria-label={`${tab} source breakdown`}>
      <header className="source-content-head">
        <div>
          <span className="source-content-kicker"><FileText size={13} /> SOURCE BREAKDOWN</span>
          <p>Parsed content supplied for this tab</p>
        </div>
        {sourceLink ? (
          <a href={sourceLink} target="_blank" rel="noreferrer" className="source-page-link">
            OPEN PAGE <ExternalLink size={12} />
          </a>
        ) : <span className="source-url-text">{page.sourceUrl}</span>}
      </header>
      {!hasSections ? (
        <p className="source-content-empty">The source page was returned without parsed sections.</p>
      ) : (
        <div className="source-sections">
          {page.sections.map((section, sectionIndex) => (
            <article className="source-section" key={`${section.title}-${sectionIndex}`}>
              <h3>{section.title}</h3>
              {section.blocks?.length ? (
                <div className="source-content-blocks">
                  {section.blocks.map((block, blockIndex) => {
                    if (block.type === 'image' && block.imageUrl) {
                      const figure = (
                        <figure className="source-image-block" key={`image-${blockIndex}`}>
                          <img src={block.imageUrl} alt={block.imageAlt || ''} loading="lazy" />
                          {block.imageAlt && <figcaption>{block.imageAlt}</figcaption>}
                        </figure>
                      );
                      return block.playerSlug ? (
                        <Link
                          className="source-player-image-link"
                          href={`/player/${encodeURIComponent(block.playerSlug)}`}
                          key={`image-${blockIndex}`}
                        >
                          {figure}
                        </Link>
                      ) : figure;
                    }
                    if (block.type === 'table') {
                      return (
                        <div className="source-table-scroll" key={`table-${blockIndex}`}>
                          <table className="source-table">
                            {block.headers?.length ? (
                              <thead><tr>{block.headers.map((header, headerIndex) => <th key={`${headerIndex}-${header}`}>{header}</th>)}</tr></thead>
                            ) : null}
                            <tbody>
                              {block.rows?.map((row, rowIndex) => (
                                <tr key={`row-${rowIndex}`}>
                                  {row.map((value, cellIndex) => {
                                    const playerSlug = block.playerSlugs?.[rowIndex]?.[cellIndex];
                                    return (
                                      <td key={`${cellIndex}-${value}`}>
                                        {playerSlug ? (
                                          <Link href={`/player/${encodeURIComponent(playerSlug)}`} className="source-player-link">
                                            {value}
                                          </Link>
                                        ) : value}
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
                    return block.text ? (
                      <p className="source-text-entry" key={`text-${blockIndex}`}>
                        {block.playerSlug ? (
                          <Link href={`/player/${encodeURIComponent(block.playerSlug)}`} className="source-player-link">
                            {block.text}
                          </Link>
                        ) : block.text}
                      </p>
                    ) : null;
                  })}
                </div>
              ) : (
                <>
                  {section.text.map((entry, textIndex) => (
                    <p className="source-text-entry" key={`${textIndex}-${entry}`}>{entry}</p>
                  ))}
                  {section.tables.map((table, tableIndex) => (
                    <div className="source-table-scroll" key={`table-${tableIndex}`}>
                      <table className="source-table">
                        {table.headers.length > 0 && (
                          <thead><tr>{table.headers.map((header, headerIndex) => <th key={`${headerIndex}-${header}`}>{header}</th>)}</tr></thead>
                        )}
                        <tbody>
                          {table.rows.map((row, rowIndex) => (
                            <tr key={`row-${rowIndex}`}>
                              {row.map((value, cellIndex) => <td key={`${cellIndex}-${value}`}>{value}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </>
              )}
              {(!section.blocks?.length && section.text.length === 0 && section.tables.length === 0) && (
                <p className="source-content-empty">No text or tables were parsed in this section.</p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
