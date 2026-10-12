import type {
  Fixture,
  FixtureList,
  LineupPlayer,
  MatchDetails,
  MatchEvent,
  MatchStat,
  OddsEntry,
  PreviewFact,
  StandingRow,
  TeamLineup,
} from "@workspace/api-zod";

const besoccerOrigin = "https://www.besoccer.com";
const markdownProxyOrigin = "https://r.jina.ai/http://www.besoccer.com";
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const pendingRequests = new Map<string, Promise<string>>();

function fromCache<T>(key: string): T | undefined {
  const cached = responseCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return undefined;
  }
  return cached.value as T;
}

function saveCache(key: string, value: unknown, ttlMs: number): void {
  responseCache.set(key, { expiresAt: Date.now() + ttlMs, value });
}

async function getMarkdown(path: string): Promise<string> {
  const cached = fromCache<string>(`page:${path}`);
  if (cached) return cached;

  const pending = pendingRequests.get(path);
  if (pending) return pending;

  const request = (async () => {
    const response = await fetch(`${markdownProxyOrigin}${path}`, {
      headers: {
        Accept: "text/plain",
        "User-Agent": "FootballFixturesExplorer/1.0",
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      throw new Error(`Source proxy returned HTTP ${response.status}`);
    }

    const markdown = await response.text();
    if (markdown.length < 120 || !markdown.includes("URL Source:")) {
      throw new Error("The BeSoccer page returned no readable match data");
    }
    saveCache(`page:${path}`, markdown, 90_000);
    return markdown;
  })();

  pendingRequests.set(path, request);
  try {
    return await request;
  } finally {
    pendingRequests.delete(path);
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

function cleanMarkdown(text: string): string {
  return decodeEntities(
    text
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/[*_`#]/g, "")
      .replace(/\\+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function anchorLabel(markdown: string, closingBracket: number): string {
  let depth = 0;
  for (let index = closingBracket; index >= 0; index -= 1) {
    if (markdown[index] === "]") depth += 1;
    if (markdown[index] === "[") {
      depth -= 1;
      if (depth === 0) return markdown.slice(index + 1, closingBracket);
    }
  }
  return "";
}

function extractCompetitionSections(markdown: string): Array<{
  index: number;
  name: string;
}> {
  const sections: Array<{ index: number; name: string }> = [];
  const expression =
    /\[!\[Image \d+:\s*[^\]]+\]\([^)]+\)([^\]]+)\]\((?:https?:\/\/)?(?:www\.)?besoccer\.com\/competition\/[^)]+\)/g;
  for (const match of markdown.matchAll(expression)) {
    if (match.index !== undefined) {
      sections.push({
        index: match.index,
        name: cleanMarkdown(match[1] ?? ""),
      });
    }
  }
  return sections;
}

function getCompetitionAt(
  sections: Array<{ index: number; name: string }>,
  index: number,
  fallback: string,
): string {
  let selected = fallback;
  for (const section of sections) {
    if (section.index > index) break;
    selected = section.name || selected;
  }
  return selected;
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[+º°]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFixtureLinks(
  markdown: string,
  date: string,
  fallbackCompetition = "Football",
  round: string | null = null,
): Fixture[] {
  const fixtures: Fixture[] = [];
  const competitions = extractCompetitionSections(markdown);
  const linkExpression =
    /\]\((?:https?:\/\/)?(?:www\.)?besoccer\.com(\/match\/[^)\s]+)\)/g;

  for (const match of markdown.matchAll(linkExpression)) {
    if (match.index === undefined) continue;
    const path = match[1] ?? "";
    const idMatch = path.match(/\/(\d+)$/);
    if (!idMatch) continue;

    const label = anchorLabel(markdown, match.index);
    const imageMatches = Array.from(
      label.matchAll(/!\[Image \d+:\s*([^\]]+)\]\(([^)]+)\)/g),
    );
    const score = cleanMarkdown(label).match(/\b(\d{1,2})\s*-\s*(\d{1,2})\b/);
    const statusLabel = label.match(/\*\*([^*]+)\*\*\s*$/)?.[1]?.trim();
    const time = label.match(/\b(\d{1,2}:\d{2})\b/)?.[1];
    const liveMinute = statusLabel?.match(/\d{1,3}(?:\+\d{1,2})?['’]/)?.[0];
    let status = "Scheduled";
    if (statusLabel?.toUpperCase() === "FT") status = "Finished";
    else if (liveMinute) status = `${liveMinute.replace(/['’]$/, "")}′`;
    else if (statusLabel) status = cleanMarkdown(statusLabel);

    fixtures.push({
      id: idMatch[1],
      sourceUrl: `${besoccerOrigin}${path}`,
      competition: getCompetitionAt(
        competitions,
        match.index,
        fallbackCompetition,
      ),
      round,
      homeTeam: cleanMarkdown(imageMatches[0]?.[1] ?? "Home team"),
      homeBadgeUrl: imageMatches[0]?.[2] ?? null,
      awayTeam: cleanMarkdown(imageMatches[1]?.[1] ?? "Away team"),
      awayBadgeUrl: imageMatches[1]?.[2] ?? null,
      kickoff: time ? `${date} ${time}` : date,
      status,
      homeScore: score ? Number(score[1]) : null,
      awayScore: score ? Number(score[2]) : null,
    });
  }

  return Array.from(new Map(fixtures.map((fixture) => [fixture.id, fixture])).values());
}

function parseRound(markdown: string): {
  competition: string;
  round: string | null;
} {
  const title =
    markdown.match(/# Matches Round (\d+) - ([^\n]+)/i) ??
    markdown.match(/Round (\d+)\s*[-–]\s*([^\n]+)/i);
  if (title) return { round: `Round ${title[1]}`, competition: cleanMarkdown(title[2]) };

  const header = markdown.match(
    /\[([^\]]+?)\s*\\+\s*Round (\d+)\]\((?:https?:\/\/)?(?:www\.)?besoccer\.com\/competition\//i,
  );
  if (header) {
    return {
      competition: cleanMarkdown(header[1] ?? "Football"),
      round: `Round ${header[2]}`,
    };
  }
  return { competition: "Football", round: null };
}

function parseStandings(markdown: string): StandingRow[] {
  const rows: StandingRow[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 11 || !/^\d+$/.test(cells[0] ?? "")) continue;

    const position = parseNumber(cells[0]) ?? 0;
    const teamLink = cells[2]?.match(/\[([^\]]+)\]\(/);
    const team = cleanMarkdown(teamLink?.[1] ?? cells[2] ?? "");
    if (!team) continue;

    const formMatch = cells[2]?.match(/\]\([^)]+\)\s*(.*)$/);
    const badgeUrl = cells[1]?.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1] ?? null;
    rows.push({
      position,
      team,
      badgeUrl,
      form: formMatch?.[1] ? cleanMarkdown(formMatch[1]) : null,
      points: parseNumber(cells[3]),
      matchesPlayed: parseNumber(cells[4]),
      wins: parseNumber(cells[5]),
      draws: parseNumber(cells[6]),
      losses: parseNumber(cells[7]),
      goalsFor: parseNumber(cells[8]),
      goalsAgainst: parseNumber(cells[9]),
      goalDifference: parseNumber(cells[10]),
    });
    if (rows.length >= 20) break;
  }
  return rows;
}

function parseAnalysis(markdown: string): MatchStat[] {
  const stats: MatchStat[] = [];
  const text = cleanMarkdown(markdown);
  const pairPatterns: Array<{ label: string; expression: RegExp }> = [
    { label: "ELO", expression: /(\d+(?:\.\d+)?)\s+ELO\s+(\d+(?:\.\d+)?)/i },
    { label: "Tilt", expression: /(\d+(?:\.\d+)?)%\s*Tilt\s+(\d+(?:\.\d+)?)%/i },
    {
      label: "General ELO ranking",
      expression: /(\d+º?)\s+General ELO ranking\s+(\d+º?)/i,
    },
    {
      label: "Country ELO ranking",
      expression: /(\d+º?)\s+Country ELO ranking\s+(\d+º?)/i,
    },
  ];

  for (const { label, expression } of pairPatterns) {
    const match = text.match(expression);
    if (match) {
      stats.push({
        label,
        homeValue: match[1] ?? "—",
        awayValue: match[2] ?? "—",
      });
    }
  }

  const probability = text.match(
    /ELO win probability\s+([\d.]+%)\s+(.+?)\s+([\d.]+%)\s+Draw\s+([\d.]+%)\s+(.+?)(?:\s|$)/i,
  );
  if (probability) {
    stats.push({
      label: "Win probability",
      homeValue: `${probability[2]} ${probability[1]}`,
      awayValue: `${probability[5]} ${probability[4]}`,
    });
    stats.push({
      label: "Draw probability",
      homeValue: probability[3] ?? "—",
      awayValue: "—",
    });
  }
  return stats;
}

function parsePreview(markdown: string): PreviewFact[] {
  const facts: PreviewFact[] = [];
  const text = cleanMarkdown(markdown);
  const comparisonLabels = ["Wins", "Draws", "Losses"];
  for (const label of comparisonLabels) {
    const expression = new RegExp(
      `${label}\\s+([\\d-]+)\\s+([\\d-]+)`,
      "i",
    );
    const match = text.match(expression);
    if (match) facts.push({ label, value: `${match[1]} – ${match[2]}` });
  }

  const squadValues = text.match(
    /([\d.]+)\s+Squad value \(M€\)\s+([\d.]+)/i,
  );
  if (squadValues) {
    facts.push({
      label: "Squad value (M€)",
      value: `${squadValues[1]} – ${squadValues[2]}`,
    });
  }

  const section = markdown.match(
    /## Match information([\s\S]*?)(?:## Recent form|## H2H|$)/i,
  )?.[1];
  if (section) {
    const linkedValues = Array.from(
      section.matchAll(/\[([^\]]+)\]\(https?:\/\/www\.besoccer\.com\/(?:referee|match)\/[^)]+\)/g),
    )
      .map((match) => cleanMarkdown(match[1] ?? ""))
      .filter(Boolean);
    if (linkedValues.length) {
      facts.push({ label: "Match information", value: linkedValues.join(" · ") });
    }
  }
  return facts;
}

function parseLineups(
  markdown: string,
  homeTeam: string,
  awayTeam: string,
): TeamLineup[] {
  const teamNames = [homeTeam, awayTeam];
  const headings = Array.from(markdown.matchAll(/^\*\*(.+?)\*\*\s*$/gm));
  const lineups: TeamLineup[] = [];

  for (const team of teamNames) {
    const heading = headings.find(
      (match) => cleanMarkdown(match[1] ?? "").toLowerCase() === team.toLowerCase(),
    );
    if (!heading || heading.index === undefined) continue;
    const start = heading.index + heading[0].length;
    const nextTeamHeading = headings.find(
      (match) =>
        match.index !== undefined &&
        match.index > start &&
        teamNames.some(
          (name) =>
            cleanMarkdown(match[1] ?? "").toLowerCase() === name.toLowerCase(),
        ),
    );
    const end = nextTeamHeading?.index ?? markdown.length;
    const section = markdown.slice(start, end);
    const formation = section.match(/\b\d{1,2}-\d{1,2}(?:-\d{1,2}){1,2}\b/)?.[0] ?? null;
    const coach = markdown
      .slice(Math.max(0, heading.index - 500), heading.index)
      .match(/\[\*\*([^\]]+)\*\*\]\(https?:\/\/www\.besoccer\.com\/coach\/[^)]+\)/)?.[1] ?? null;
    const substitutesAt = section.search(/## Substitutes/i);
    const players: LineupPlayer[] = [];
    const playerExpression =
      /^\s*[*-]\s+\[!\[Image \d+:\s*([^\]]+)\]\(([^)]+)\)(.*?)\]\(https?:\/\/www\.besoccer\.com\/player\/[^)]+\)/gm;

    for (const playerMatch of section.matchAll(playerExpression)) {
      if (playerMatch.index === undefined) continue;
      const description = cleanMarkdown(playerMatch[3] ?? "");
      const numberMatch = description.match(/(?:^|\s)c?\s*(\d{1,2})\s+/);
      const name = description
        .replace(/^\s*c?\s*\d{1,2}\s+/, "")
        .replace(/\s+\d+(?:\.\d+)?\s*$/, "")
        .replace(/\s+\d{1,3}['’].*$/, "")
        .trim();
      if (!name) continue;
      players.push({
        name,
        number: parseNumber(numberMatch?.[1]),
        position: null,
        photoUrl: playerMatch[2] ?? null,
        isSubstitute: substitutesAt >= 0 && playerMatch.index > substitutesAt,
      });
    }
    lineups.push({ team, formation, coach, players });
  }
  return lineups;
}

function parseEvents(markdown: string): MatchEvent[] {
  const lines = markdown.split("\n");
  const events: MatchEvent[] = [];
  const eventLine = /^\s*(\d{1,3}(?:\+\d{1,2})?)['’]\s*(Goal|Substitution|Yellow card|Red card|Penalty|Own goal|Foul)\b/i;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(eventLine);
    if (!match) continue;
    const nearby = lines.slice(index + 1, index + 8).join(" ");
    const players = Array.from(
      nearby.matchAll(/\[([^\]]+)\]\(https?:\/\/www\.besoccer\.com\/player\/[^)]+\)/g),
    )
      .map((player) => cleanMarkdown(player[1] ?? ""))
      .filter(Boolean);
    const score = nearby.match(/\b\d{1,2}\s*-\s*\d{1,2}\b/)?.[0] ?? null;
    events.push({
      minute: `${match[1]}′`,
      eventType: match[2] ?? "Event",
      team: null,
      player: players[0] ?? null,
      detail: score ?? (players.length > 1 ? `Assist: ${players[1]}` : null),
    });
  }

  return Array.from(
    new Map(
      events.map((event) => [
        `${event.minute}:${event.eventType}:${event.player ?? ""}`,
        event,
      ]),
    ).values(),
  );
}

function parseOdds(markdown: string, sourceUrl: string): OddsEntry[] {
  const entries: OddsEntry[] = [];
  const expression =
    /1\s*➜\s*(\d+(?:\.\d+)?)[\s\S]{0,800}?x\s*➜\s*(\d+(?:\.\d+)?)[\s\S]{0,800}?2\s*➜\s*(\d+(?:\.\d+)?)/gi;
  for (const match of markdown.matchAll(expression)) {
    if (match.index === undefined) continue;
    const preceding = markdown.slice(Math.max(0, match.index - 900), match.index);
    const brandMatches = Array.from(
      preceding.matchAll(/!\[(?:Image \d+:\s*)?([^\]]+)\]\([^)]+\)/g),
    );
    const bookmaker = cleanMarkdown(brandMatches.at(-1)?.[1] ?? "Bookmaker");
    entries.push({
      bookmaker,
      homeOdds: parseNumber(match[1]),
      drawOdds: parseNumber(match[2]),
      awayOdds: parseNumber(match[3]),
      sourceUrl,
    });
  }
  return Array.from(
    new Map(entries.map((entry) => [entry.bookmaker, entry])).values(),
  );
}

export async function listFixturesForDate(date: string): Promise<FixtureList> {
  const cached = fromCache<FixtureList>(`fixtures:${date}`);
  if (cached) return cached;

  const path = `/livescore/${date}`;
  const markdown = await getMarkdown(path);
  const fixtures = parseFixtureLinks(markdown, date);
  const result = {
    date: new Date(`${date}T00:00:00.000Z`),
    sourceUrl: `${besoccerOrigin}${path}`,
    fetchedAt: new Date(),
    fixtures,
  };
  saveCache(`fixtures:${date}`, result, 60_000);
  return result;
}

export async function getMatchById(matchId: string): Promise<MatchDetails> {
  const cached = fromCache<MatchDetails>(`match:${matchId}`);
  if (cached) return cached;

  const matchPath = `/match/${matchId}`;
  const pages = [
    `${matchPath}/rounds`,
    `${matchPath}/table`,
    `${matchPath}/analysis`,
    `${matchPath}/preview`,
    `${matchPath}/lineups`,
    `${matchPath}/events`,
  ];
  const [mainResult, ...sectionResults] = await Promise.allSettled([
    getMarkdown(matchPath),
    ...pages.map((path) => getMarkdown(path)),
  ]);
  if (mainResult.status === "rejected") throw mainResult.reason;

  const mainMarkdown = mainResult.value;
  const sectionMarkdown = sectionResults.map((result) =>
    result.status === "fulfilled" ? result.value : "",
  );
  const [roundMarkdown, tableMarkdown, analysisMarkdown, previewMarkdown, lineupMarkdown, eventMarkdown] =
    sectionMarkdown;
  const matchDate = new Date().toISOString().slice(0, 10);
  const roundInfo = parseRound(roundMarkdown ?? "");
  const roundMatches = parseFixtureLinks(
    roundMarkdown ?? "",
    matchDate,
    roundInfo.competition,
    roundInfo.round,
  );
  let fixture = roundMatches.find((item) => item.id === matchId);

  if (!fixture) {
    fixture = parseFixtureLinks(
      mainMarkdown,
      matchDate,
      roundInfo.competition,
      roundInfo.round,
    ).find((item) => item.id === matchId);
  }
  if (!fixture) {
    const title = mainMarkdown.match(/^Title:\s*(.+)$/m)?.[1] ?? "";
    const matchup = title.match(/(.+?)\s+vs\s+(.+?)(?:,\s*|\s+-\s+)/i);
    if (!matchup) throw new Error("Match details are not available for this id");
    fixture = {
      id: matchId,
      sourceUrl: `${besoccerOrigin}${matchPath}`,
      competition: roundInfo.competition,
      round: roundInfo.round,
      homeTeam: cleanMarkdown(matchup[1] ?? ""),
      homeBadgeUrl: null,
      awayTeam: cleanMarkdown(matchup[2] ?? ""),
      awayBadgeUrl: null,
      kickoff: matchDate,
      status: "Match details",
      homeScore: null,
      awayScore: null,
    };
  }

  const odds = Array.from(
    new Map(
      sectionMarkdown
        .flatMap((markdown) =>
          markdown ? parseOdds(markdown, `${besoccerOrigin}${matchPath}`) : [],
        )
        .map((entry) => [entry.bookmaker, entry]),
    ).values(),
  );
  const result: MatchDetails = {
    fixture,
    sourceUrl: `${besoccerOrigin}${matchPath}`,
    fetchedAt: new Date(),
    roundMatches,
    standings: parseStandings(tableMarkdown ?? ""),
    analysisStats: parseAnalysis(analysisMarkdown ?? ""),
    previewFacts: parsePreview(previewMarkdown ?? ""),
    lineups: parseLineups(
      lineupMarkdown ?? "",
      fixture.homeTeam,
      fixture.awayTeam,
    ),
    events: parseEvents(eventMarkdown ?? ""),
    odds,
  };
  saveCache(`match:${matchId}`, result, 120_000);
  return result;
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}
