import type {
  Fixture,
  FixtureList,
  LineupPlayer,
  MatchContentPage,
  MatchDetails,
  MatchEvent,
  MatchOdds,
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
const knownFixtures = new Map<string, Fixture>();
const knownMatchPaths = new Map<string, string>();
const knownCompetitionKeys = new Map<string, string>();
const knownOddsMatchKeys = new Map<
  string,
  { year: string; sourceMatchId: string; sourceRegion: string | null }
>();

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

async function getRawHtml(path: string): Promise<string> {
  const cacheKey = `html:${path}`;
  const cached = fromCache<string>(cacheKey);
  if (cached) return cached;

  const pendingKey = `html:${path}`;
  const pending = pendingRequests.get(pendingKey);
  if (pending) return pending;

  const request = (async () => {
    const response = await fetch(`${markdownProxyOrigin}${path}`, {
      headers: {
        Accept: "text/html",
        "User-Agent": "FootballFixturesExplorer/1.0",
        "X-Respond-With": "html",
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      throw new Error(`Source proxy returned HTTP ${response.status}`);
    }

    const html = await response.text();
    if (html.length < 80) {
      throw new Error("The BeSoccer page returned no odds data");
    }
    saveCache(cacheKey, html, 90_000);
    return html;
  })();

  pendingRequests.set(pendingKey, request);
  try {
    return await request;
  } finally {
    pendingRequests.delete(pendingKey);
  }
}

function normalizeScrolledHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/\\&quot;/g, '"')
      .replace(/\\\//g, "/")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/=""([^"\n]*)""/g, '="$1"'),
  );
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code: string) => {
      const value = code.toLowerCase().startsWith("x")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : entity;
    });
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

function cleanHtmlText(text: string): string {
  return decodeEntities(
    text
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function htmlAttribute(tag: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = tag.match(
    new RegExp(`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return value?.[1] ?? value?.[2] ?? value?.[3] ?? null;
}

function parseFixtureCards(
  html: string,
  date: string,
  competitionKeys?: Map<string, string | null>,
  includeUnmarkedCards = false,
): Fixture[] {
  const competitions = Array.from(
    html.matchAll(
      /<a\b(?=[^>]*\bdata-cy=["']competitionName["'])[^>]*>([\s\S]*?)<\/a>/gi,
    ),
    (match) => {
      const openingTag = match[0].slice(0, match[0].indexOf(">") + 1);
      let competitionPath = "";
      try {
        competitionPath = new URL(
          htmlAttribute(openingTag, "href") ?? "",
          besoccerOrigin,
        ).pathname;
      } catch {
        // Keep the competition name even if its source link is malformed.
      }
      return {
        index: match.index ?? 0,
        name: cleanHtmlText(match[1] ?? ""),
        key: competitionKeyFromPath(competitionPath),
      };
    },
  );
  const fixtures: Fixture[] = [];
  const cardExpression = includeUnmarkedCards
    ? /<a\b(?=[^>]*(?:\bdata-cy=["']match["']|\bid=["']match-\d+["']))[^>]*>[\s\S]*?<\/a>/gi
    : /<a\b(?=[^>]*\bdata-cy=["']match["'])[^>]*>[\s\S]*?<\/a>/gi;
  const cards = html.matchAll(cardExpression);

  for (const match of cards) {
    const card = match[0];
    const openingTag = card.slice(0, card.indexOf(">") + 1);
    const matchId =
      htmlAttribute(openingTag, "id")?.match(/^match-(\d+)$/)?.[1] ??
      htmlAttribute(openingTag, "href")?.match(/\/(\d+)(?:[?#].*)?$/)?.[1];
    if (!matchId || match.index === undefined) continue;

    const sourcePath = htmlAttribute(openingTag, "href");
    if (!sourcePath) continue;
    let canonicalPath: string;
    try {
      canonicalPath = new URL(sourcePath, besoccerOrigin).pathname;
    } catch {
      continue;
    }
    if (!/^\/match\/[a-z0-9-]+\/[a-z0-9-]+\/\d+$/i.test(canonicalPath)) continue;

    const names = Array.from(
      card.matchAll(
        /<div\b(?=[^>]*\bteam-name\b)[^>]*>([\s\S]*?)<\/div>/gi,
      ),
      (team) => cleanHtmlText(team[1] ?? ""),
    );
    if (!names[0] || !names[1]) continue;

    const badges = Array.from(
      card.matchAll(/<img\b(?=[^>]*\bteam-shield\b)[^>]*>/gi),
      (image) => ({
        src: htmlAttribute(image[0], "src"),
        alt: htmlAttribute(image[0], "alt"),
      }),
    );
    const kickoff = card.match(
      /<p\b(?=[^>]*\bmatch_hour\b)[^>]*>([\s\S]*?)<\/p>/i,
    )?.[1];
    const marker = card.match(
      /<div\b(?=[^>]*\bdates\b)[^>]*>([\s\S]*?)<\/div>/i,
    )?.[1];
    const statusId = htmlAttribute(openingTag, "data-status-id");
    const minute = marker ? cleanHtmlText(marker).match(/\d{1,3}(?:\+\d{1,2})?['’]/)?.[0] : null;
    const status =
      statusId === "4"
        ? "Finished"
        : statusId === "3"
          ? minute
            ? `${minute.replace(/['’]$/, "")}′`
            : "Live"
          : marker && /postponed/i.test(marker)
            ? "Postponed"
            : marker && /cancelled/i.test(marker)
              ? "Cancelled"
              : "Scheduled";

    fixtures.push({
      id: matchId,
      sourceUrl: `${besoccerOrigin}${canonicalPath}`,
      competition: getCompetitionAt(competitions, match.index, "Football"),
      round: null,
      homeTeam: names[0],
      homeBadgeUrl: badges[0]?.src ?? null,
      awayTeam: names[1],
      awayBadgeUrl: badges[1]?.src ?? null,
      kickoff: kickoff ? `${date} ${cleanHtmlText(kickoff)}` : date,
      status,
      homeScore: null,
      awayScore: null,
    });
    competitionKeys?.set(matchId, getCompetitionKeyAt(competitions, match.index));
  }

  return Array.from(new Map(fixtures.map((fixture) => [fixture.id, fixture])).values());
}

function parseFixtureScrollConfig(
  html: string,
): { keyCache: string; filters: string; url: string } | null {
  const match = html.match(
    /\bgenerateMatches\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']*)["']\s*,\s*'([^']+)'\s*\)/i,
  );
  if (!match?.[1] || match[2] === undefined || !match[3]) return null;

  return {
    keyCache: match[1].trim(),
    filters: match[2] === "null" ? "" : match[2],
    url: match[3],
  };
}

async function getScrolledFixtures(
  html: string,
  date: string,
  competitionKeys: Map<string, string | null>,
): Promise<Fixture[]> {
  const config = parseFixtureScrollConfig(html);
  if (!config) {
    if (parseFixtureCards(html, date, competitionKeys).length > 0) {
      throw new Error("The BeSoccer page omitted its fixture pagination settings");
    }
    return [];
  }

  const fixtures: Fixture[] = [];
  const maxPage = 30;
  for (let page = 2; page <= maxPage; page += 1) {
    const query = new URLSearchParams({
      keyCache: config.keyCache,
      page: String(page),
      filters: config.filters,
      url: config.url,
    });
    const responseHtml = await getRawHtml(
      `/ajax/matchesScroll?${query.toString()}`,
    );
    const moreItems = responseHtml.match(/["']moreItems["']\s*:\s*(true|false)/i);
    if (!moreItems) {
      throw new Error(`BeSoccer did not confirm whether fixture page ${page} was final`);
    }

    fixtures.push(
      ...parseFixtureCards(
        normalizeScrolledHtml(responseHtml),
        date,
        competitionKeys,
        true,
      ),
    );
    if (moreItems[1]?.toLowerCase() === "false") return fixtures;
  }

  throw new Error(`BeSoccer fixture pagination exceeded ${maxPage} pages`);
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

function competitionKeyFromPath(path: string): string | null {
  return path.match(/^\/competition\/(?:scores\/)?([^/?#]+)/i)?.[1]?.toLowerCase() ?? null;
}

function extractCompetitionSections(markdown: string): Array<{
  index: number;
  name: string;
  key: string | null;
}> {
  const sections: Array<{ index: number; name: string; key: string | null }> = [];
  const expression =
    /\[!\[Image \d+:\s*[^\]]+\]\([^)]+\)([^\]]+)\]\((?:https?:\/\/)?(?:www\.)?besoccer\.com(\/competition\/[^)\s]+)\)/g;
  for (const match of markdown.matchAll(expression)) {
    if (match.index !== undefined) {
      sections.push({
        index: match.index,
        name: cleanMarkdown(match[1] ?? ""),
        key: competitionKeyFromPath(match[2] ?? ""),
      });
    }
  }
  return sections;
}

function getCompetitionAt(
  sections: Array<{ index: number; name: string; key: string | null }>,
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

function getCompetitionKeyAt(
  sections: Array<{ index: number; name: string; key: string | null }>,
  index: number,
): string | null {
  let selected: string | null = null;
  for (const section of sections) {
    if (section.index > index) break;
    selected = section.key ?? selected;
  }
  return selected;
}

function competitionKeyFromMatchPage(markdown: string): string | null {
  const match = markdown.match(
    /\]\(https?:\/\/www\.besoccer\.com(\/competition\/scores\/[^)\s]+)\)/i,
  );
  return competitionKeyFromPath(match?.[1] ?? "");
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[+º°]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function roundFixtureDates(matchDate: string): string[] {
  const date = new Date(`${matchDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return [matchDate.slice(0, 10)];

  const weekday = date.getUTCDay();
  const isWeekendRound = [0, 1, 5, 6].includes(weekday);
  const startOffset = isWeekendRound
    ? (weekday + 2) % 7
    : weekday - 2;
  date.setUTCDate(date.getUTCDate() - startOffset);
  const dayCount = isWeekendRound ? 4 : 3;
  return Array.from({ length: dayCount }, (_, index) => {
    const day = new Date(date);
    day.setUTCDate(day.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
}

function normalizeCompetition(name: string): string {
  return name
    .replace(/\s+round\s+\d+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const monthNumbers: Record<string, string> = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
};

function dateFromLabel(label: string, fallbackDate: string): string {
  const match = label.match(
    /\b(\d{1,2})\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\.?(?:\s+(20\d{2}))?\b/i,
  );
  if (!match) return fallbackDate;

  const month = monthNumbers[(match[2] ?? "").toUpperCase()];
  if (!month) return fallbackDate;
  const fallbackYear = Number(fallbackDate.slice(0, 4));
  const fallbackMonth = Number(fallbackDate.slice(5, 7));
  const monthNumber = Number(month);
  let year = Number(match[3] ?? fallbackYear);
  if (!match[3] && fallbackMonth >= 7 && monthNumber <= 6) year += 1;
  else if (!match[3] && fallbackMonth <= 6 && monthNumber >= 7) year -= 1;
  return `${year}-${month}-${String(Number(match[1])).padStart(2, "0")}`;
}

function inferMatchDate(markdown: string): string | null {
  const dateLabel = markdown.match(
    /\b(?:MON|TUE|WED|THU|FRI|SAT|SUN)[, ]+\s*(\d{1,2})\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/i,
  );
  if (!dateLabel) return null;

  const month = monthNumbers[(dateLabel[2] ?? "").toUpperCase()];
  if (!month) return null;
  const seasonYear = Number(markdown.match(/\b(20\d{2})\/\d{2}\b/)?.[1]);
  const monthNumber = Number(month);
  const year = seasonYear
    ? monthNumber >= 7
      ? seasonYear
      : seasonYear + 1
    : new Date().getFullYear();
  return `${year}-${month}-${String(Number(dateLabel[1])).padStart(2, "0")}`;
}

function parseFixtureLinks(
  markdown: string,
  date: string,
  fallbackCompetition = "Football",
  round: string | null = null,
  competitionKeys?: Map<string, string | null>,
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
    const homeTeam = cleanMarkdown(imageMatches[0]?.[1] ?? "");
    const awayTeam = cleanMarkdown(imageMatches[1]?.[1] ?? "");
    if (
      !homeTeam ||
      !awayTeam ||
      /^home team$/i.test(homeTeam) ||
      /^away team$/i.test(awayTeam)
    ) {
      continue;
    }
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
      homeTeam,
      homeBadgeUrl: imageMatches[0]?.[2] ?? null,
      awayTeam,
      awayBadgeUrl: imageMatches[1]?.[2] ?? null,
      kickoff: time
        ? `${dateFromLabel(label, date)} ${time}`
        : dateFromLabel(label, date),
      status,
      homeScore: score ? Number(score[1]) : null,
      awayScore: score ? Number(score[2]) : null,
    });
    competitionKeys?.set(
      idMatch[1],
      getCompetitionKeyAt(competitions, match.index),
    );
  }

  return Array.from(new Map(fixtures.map((fixture) => [fixture.id, fixture])).values());
}

function parseMatchFixture(
  markdown: string,
  matchPath: string,
  matchId: string,
  fallbackDate: string,
): Fixture | null {
  const marker = markdown.indexOf("Markdown Content:");
  const body = marker >= 0
    ? markdown.slice(marker + "Markdown Content:".length)
    : markdown;
  const competitionLink = body.match(
    /\[([^\]]*Round\s+\d+[^\]]*)\]\(https?:\/\/www\.besoccer\.com\/competition\/scores\/[^)]+\)/i,
  );
  if (!competitionLink || competitionLink.index === undefined) return null;

  const tabsIndex = body.search(/^\[Rounds\]\(https?:\/\/www\.besoccer\.com\/match\//im);
  const headerEnd = tabsIndex > competitionLink.index
    ? tabsIndex
    : Math.min(body.length, competitionLink.index + 8000);
  const header = body.slice(competitionLink.index, headerEnd);
  const teamLinks = Array.from(
    header.matchAll(
      /\[([^\]]+)\]\(https?:\/\/www\.besoccer\.com\/team\/[^)]+\)/g,
    ),
  )
    .filter((match) => match.index !== undefined)
    .map((match) => ({
      name: cleanMarkdown(match[1] ?? ""),
      index: match.index ?? 0,
    }));
  const score = header.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/);
  const scoreIndex = score?.index ?? header.length;
  const home = teamLinks.filter((link) => link.index < scoreIndex).at(-1);
  const away = teamLinks.find(
    (link) => link.index > scoreIndex + (score?.[0].length ?? 0),
  );
  if (!home?.name || !away?.name) return null;

  const competitionRound = cleanMarkdown(competitionLink[1] ?? "");
  const round = competitionRound.match(/Round\s+\d+/i)?.[0] ?? null;
  const competition = competitionRound.replace(/\s+Round\s+\d+.*/i, "").trim();
  const matchDate = inferMatchDate(markdown) ?? fallbackDate;
  const kickoffLine = header.match(
    /\b(?:MON|TUE|WED|THU|FRI|SAT|SUN)[, ]+\s*\d{1,2}\s+(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{1,2}:\d{2})\b/i,
  );
  const localBadge = header.match(
    /\[!\[Image \d+:\s*local\]\(([^)]+)\)\]\(https?:\/\/www\.besoccer\.com\/team\/[^)]+\)/i,
  )?.[1] ?? null;
  const visitorBadge = header.match(
    /\[!\[Image \d+:\s*visitor\]\(([^)]+)\)\]\(https?:\/\/www\.besoccer\.com\/team\/[^)]+\)/i,
  )?.[1] ?? null;
  const status = header.match(/\b(Finished|Scheduled|Upcoming|Postponed|Cancelled|Suspended)\b/i)?.[1];

  return {
    id: matchId,
    sourceUrl: `${besoccerOrigin}${matchPath}`,
    competition: competition || "Football",
    round,
    homeTeam: home.name,
    homeBadgeUrl: localBadge,
    awayTeam: away.name,
    awayBadgeUrl: visitorBadge,
    kickoff: kickoffLine?.[1] ? `${matchDate} ${kickoffLine[1]}` : matchDate,
    status: status ?? (score ? "Finished" : "Match details"),
    homeScore: score ? Number(score[1]) : null,
    awayScore: score ? Number(score[2]) : null,
  };
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

    if (substitutesAt >= 0) {
      const substitutesSection = section
        .slice(substitutesAt)
        .split(/## (?:Legend|Referees)\b/i)[0] ?? "";
      const playerLinks = /\]\(https?:\/\/www\.besoccer\.com\/player\/[^)]+\)/g;
      for (const playerLink of substitutesSection.matchAll(playerLinks)) {
        if (playerLink.index === undefined) continue;
        const rawLabel = anchorLabel(substitutesSection, playerLink.index);
        const name = cleanMarkdown(rawLabel.match(/^\s*([^\[]+)/)?.[1] ?? "");
        if (!name || players.some((player) => player.name.toLowerCase() === name.toLowerCase())) {
          continue;
        }
        const playerPhoto = rawLabel.match(
          /!\[Image \d+:\s*Player\]\(([^)]+)\)/i,
        );
        const playerInfo = playerPhoto
          ? rawLabel.slice((playerPhoto.index ?? 0) + playerPhoto[0].length)
          : rawLabel;
        const playerNumber = playerInfo.match(/\b(\d{1,2})\s+(?:GK|Def|Mid|Att)\b/i);
        const position = playerInfo.match(/\b(GK|Def|Mid|Att)\b/i)?.[1] ?? null;
        players.push({
          name,
          number: parseNumber(playerNumber?.[1]),
          position,
          photoUrl: playerPhoto?.[1] ?? null,
          isSubstitute: true,
        });
      }
    }
    lineups.push({ team, formation, coach, players });
  }
  return lineups;
}

function parseEvents(
  markdown: string,
  homeTeam: string,
  awayTeam: string,
): MatchEvent[] {
  const lines = markdown.split("\n");
  const events: MatchEvent[] = [];
  const eventLine = /^\s*(\d{1,3}(?:\+\d{1,2})?)['’]\s*(Goal|Substitution|Yellow card|Red card|Penalty|Own goal|Foul)\b/i;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(eventLine);
    if (!match) continue;
    const nearbyLines = lines.slice(index + 1, index + 14);
    const nearby = nearbyLines.join(" ");
    const players = Array.from(
      nearby.matchAll(/\[([^\]]+)\]\(https?:\/\/www\.besoccer\.com\/player\/[^)]+\)/g),
    )
      .map((player) => cleanMarkdown(player[1] ?? ""))
      .filter(Boolean)
      .filter((player, playerIndex, allPlayers) => allPlayers.indexOf(player) === playerIndex);
    const score = nearby.match(/\b\d{1,2}\s*-\s*\d{1,2}\b/)?.[0] ?? null;
    const side = nearby.match(/!\[Image \d+:\s*(local|visitor)\]/i)?.[1]?.toLowerCase();
    const eventType = match[2] ?? "Event";
    const detail = score ??
      (eventType.toLowerCase() === "substitution" && players.length > 1
        ? `${players[0]} replaced by ${players[1]}`
        : players.length > 1
          ? `Assist: ${players[1]}`
          : null);
    events.push({
      minute: `${match[1]}′`,
      eventType,
      team: side === "local" ? homeTeam : side === "visitor" ? awayTeam : null,
      player: players[0] ?? null,
      detail,
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

const oddsMarkets = new Map([
  ["1", "1X2"],
  ["2", "Over/under"],
  ["3", "Asian handicap"],
  ["4", "Both teams to score"],
  ["5", "Double chance"],
  ["6", "European handicap"],
  ["7", "Draw no bet"],
  ["8", "Correct score"],
  ["9", "Half time/full time"],
  ["10", "Odd/even"],
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textValue(value: unknown): string | null {
  return typeof value === "string"
    ? decodeEntities(value).replace(/\\\//g, "/").trim() || null
    : null;
}

function parseOddsPayload(
  html: string,
  marketId: string,
  sourceRegion: string | null,
): MatchOdds {
  const marketName = oddsMarkets.get(marketId);
  if (!marketName) throw new Error("The selected odds market is not supported");
  const response: MatchOdds = {
    marketId,
    marketName,
    sourceRegion,
    periods: [],
  };

  const dataAttribute = html.match(/\bdata_odds="([^"]*)"/i)?.[1];
  if (!dataAttribute) {
    throw new Error("BeSoccer did not return the selected odds market");
  }

  const normalizedJson = decodeEntities(
    dataAttribute.replace(/\\&quot;/g, "&quot;"),
  ).replace(/(\\+)"/g, (match, slashes: string) =>
    slashes.length % 2 === 0 ? `${slashes.slice(1)}"` : match,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedJson);
  } catch {
    throw new Error("BeSoccer returned odds in an unreadable format");
  }

  if (Array.isArray(parsed)) {
    return response;
  }

  const payload = asRecord(parsed);
  const scopeInfo = asRecord(payload?.scopesInfo);
  const scopes = asRecord(payload?.scopes);
  if (!scopeInfo || !scopes) return response;

  for (const [periodId, rawInfo] of Object.entries(scopeInfo)) {
    const info = asRecord(rawInfo);
    if (!info) continue;

    const columns = asArray(info.columns)
      .map((column) => {
        const record = asRecord(column);
        return textValue(record?.name) ?? textValue(record?.id);
      })
      .filter((column): column is string => Boolean(column));
    const groups = asArray(scopes[periodId]).flatMap((rawGroup) => {
      const group = asRecord(rawGroup);
      if (!group) return [];
      const bookmakers = asArray(group.housesOdds).flatMap((rawBookmaker) => {
        const bookmaker = asRecord(rawBookmaker);
        if (!bookmaker) return [];
        const name =
          textValue(bookmaker.houseName) ??
          textValue(bookmaker.bsHouseName) ??
          textValue(bookmaker.house);
        if (!name) return [];

        const outcomes = asArray(bookmaker.bets).flatMap((rawOutcome) => {
          const outcome = asRecord(rawOutcome);
          if (!outcome) return [];
          const column = textValue(outcome.column);
          if (!column) return [];
          const columnLabel =
            columns.find(
              (value) => value.toLowerCase() === column.toLowerCase(),
            ) ?? column;
          return [{
            label: columnLabel,
            price: textValue(outcome.value),
            initialPrice: textValue(outcome.initialValue),
            movement: textValue(outcome.direction),
            active: outcome.active === true,
            winner: outcome.winner === true,
          }];
        });
        return outcomes.length ? [{ name, outcomes }] : [];
      });
      return bookmakers.length
        ? [{ label: textValue(group.oddName), bookmakers }]
        : [];
    });

    if (groups.length) {
      response.periods.push({
        id: periodId,
        name: textValue(info.description) ?? textValue(info.name) ?? periodId,
        columns,
        groups,
      });
    }
  }

  return response;
}

function parseOddsMatchKey(
  html: string,
): { year: string; sourceMatchId: string; sourceRegion: string | null } | null {
  const filterTag = html.match(/<[^>]+\bid=["']filterBets["'][^>]*>/i)?.[0];
  if (!filterTag) return null;
  const sourceMatchId = filterTag.match(/\bdata-matchid=["']([^"']+)["']/i)?.[1];
  const year = filterTag.match(/\bdata-year=["']([^"']+)["']/i)?.[1];
  const sourceRegion = html.match(
    /<body\b[^>]*\bdata-iso-code=["']([a-z]{2})["']/i,
  )?.[1]?.toUpperCase() ?? null;
  return sourceMatchId && year ? { sourceMatchId, year, sourceRegion } : null;
}

export async function getMatchOdds(
  matchId: string,
  marketId: string,
  requestedPath?: string,
): Promise<MatchOdds> {
  const cacheKey = `match-odds:${matchId}:${marketId}`;
  const cached = fromCache<MatchOdds>(cacheKey);
  if (cached) return cached;

  const matchPath = sourcePathForMatch(matchId, requestedPath);
  const oddsPath = `${matchPath}/odds`;
  let matchKey = knownOddsMatchKeys.get(matchId);
  if (!matchKey) {
    const oddsHtml = await getRawHtml(oddsPath);
    const parsedMatchKey = parseOddsMatchKey(oddsHtml);
    if (!parsedMatchKey) {
      throw new Error("BeSoccer did not include the internal match key for odds");
    }
    matchKey = parsedMatchKey;
    knownOddsMatchKeys.set(matchId, matchKey);
  }

  if (!matchKey) {
    throw new Error("BeSoccer did not include the internal match key for odds");
  }

  const filterPath =
    `/ajax/betsFilter?filter=${encodeURIComponent(marketId)}` +
    `%26year=${encodeURIComponent(matchKey.year)}` +
    `%26matchId=${encodeURIComponent(matchKey.sourceMatchId)}`;
  const sourceHtml = await getRawHtml(filterPath);
  const result = parseOddsPayload(sourceHtml, marketId, matchKey.sourceRegion);
  saveCache(cacheKey, result, 60_000);
  return result;
}

const sourcePageTabs = [
  "rounds",
  "table",
  "analysis",
  "preview",
  "lineups",
  "odds",
  "events",
] as const;

function isPageChrome(line: string): boolean {
  const text = cleanMarkdown(line).toLowerCase();
  return (
    /^url source:/.test(text) ||
    /^published time:/.test(text) ||
    /^copyright/.test(text) ||
    /^play responsibly/.test(text) ||
    /^legal notices and privacy/.test(text) ||
    /^login or register$/.test(text) ||
    /^login$/.test(text) ||
    /^register$/.test(text) ||
    /^user or e-mail$/.test(text) ||
    /^username must/.test(text) ||
    /^incorrect password$/.test(text) ||
    /^forgotten your password/.test(text) ||
    /^do not have an account/.test(text) ||
    /^already have an account/.test(text) ||
    /^by registering/.test(text) ||
    /^password$/.test(text) ||
    /^user$/.test(text) ||
    /^email$/.test(text) ||
    /^confirm password$/.test(text) ||
    /^username must have between/.test(text) ||
    /^confirm email$/.test(text) ||
    /^emails do not match$/.test(text) ||
    /^password must/.test(text) ||
    /^registration successful/.test(text) ||
    /^i am over 14 years old$/.test(text) ||
    /^congratulations!$/.test(text) ||
    /^you must be logged in/.test(text) ||
    /^make a new account/.test(text) ||
    /^continuar con facebook$/.test(text) ||
    /^close$/.test(text) ||
    /^advertisement$/.test(text) ||
    /^loading ad/.test(text) ||
    /^no microphone detected/.test(text) ||
    /^microphone permissions/.test(text) ||
    /^error attempting to use the microphone/.test(text) ||
    /^your device is not compatible/.test(text)
  );
}

function parseSourceSections(markdown: string): MatchContentPage["sections"] {
  const marker = markdown.indexOf("Markdown Content:");
  const body = marker >= 0
    ? markdown.slice(marker + "Markdown Content:".length)
    : markdown;
  const lines = body.split("\n");
  const tabsIndex = lines.findIndex((line) =>
    /^\[Rounds\]\(https?:\/\/www\.besoccer\.com\/match\//i.test(line.trim()),
  );
  const contentLines = tabsIndex >= 0 ? lines.slice(tabsIndex + 1) : lines;
  const sections: MatchContentPage["sections"] = [];
  let current = { title: "Overview", text: [] as string[], tables: [] as Array<{ headers: string[]; rows: string[][] }> };

  const flush = () => {
    if (current.text.length || current.tables.length) sections.push(current);
  };
  const parseTableRow = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cleanMarkdown(cell));
  const isSeparatorRow = (cells: string[]) =>
    cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));

  for (let index = 0; index < contentLines.length; index += 1) {
    const line = contentLines[index]?.trim() ?? "";
    if (!line) continue;
    if (/^copyright\s/i.test(cleanMarkdown(line))) break;
    if (isPageChrome(line)) continue;

    const heading = line.match(/^#{1,6}\s+(.+)$/) ?? line.match(/^\*\*(.+)\*\*$/);
    if (heading) {
      flush();
      current = {
        title: cleanMarkdown(heading[1] ?? "") || "Match information",
        text: [],
        tables: [],
      };
      continue;
    }

    if (line.startsWith("|")) {
      const tableLines = [line];
      while ((contentLines[index + 1]?.trim() ?? "").startsWith("|")) {
        index += 1;
        tableLines.push(contentLines[index]?.trim() ?? "");
      }
      const rows = tableLines.map(parseTableRow).filter((row) => row.some(Boolean));
      const separatorIndex = rows.findIndex(isSeparatorRow);
      const headers = separatorIndex > 0
        ? (rows[separatorIndex - 1] ?? [])
        : (rows[0] ?? []);
      const dataStart = separatorIndex >= 0 ? separatorIndex + 1 : 1;
      const dataRows = rows
        .slice(dataStart)
        .filter((row) => row.some((cell) => cell.trim()));
      if (headers.length || dataRows.length) {
        current.tables.push({ headers, rows: dataRows });
      }
      continue;
    }

    const text = cleanMarkdown(line)
      .replace(/^(?:[-*•]\s*)+/, "")
      .trim();
    if (text && !isPageChrome(text)) current.text.push(text);
  }

  flush();
  return sections;
}

function sourcePathForMatch(matchId: string, requestedPath?: string): string {
  const path = requestedPath?.split(/[?#]/, 1)[0];
  const canonicalMatch = path?.match(
    /^\/match\/[a-z0-9-]+\/[a-z0-9-]+\/(\d+)$/i,
  );
  if (path && canonicalMatch?.[1] === matchId) return path;
  return knownMatchPaths.get(matchId) ?? `/match/${matchId}`;
}

export async function listFixturesForDate(date: string): Promise<FixtureList> {
  const cached = fromCache<FixtureList>(`fixtures:${date}`);
  if (cached) return cached;

  const path = `/livescore/${date}`;
  const competitionKeys = new Map<string, string | null>();
  const [markdownResult, htmlResult] = await Promise.allSettled([
    getMarkdown(path),
    getRawHtml(path),
  ]);
  if (markdownResult.status === "rejected" && htmlResult.status === "rejected") {
    throw markdownResult.reason;
  }

  const markdownFixtures =
    markdownResult.status === "fulfilled"
      ? parseFixtureLinks(
          markdownResult.value,
          date,
          "Football",
          null,
          competitionKeys,
        )
      : [];
  const htmlFixtures =
    htmlResult.status === "fulfilled"
      ? parseFixtureCards(htmlResult.value, date, competitionKeys)
      : [];
  const scrolledFixtures =
    htmlResult.status === "fulfilled"
      ? await getScrolledFixtures(htmlResult.value, date, competitionKeys)
      : [];
  const markdownById = new Map(markdownFixtures.map((fixture) => [fixture.id, fixture]));
  const sourceFixtures = Array.from(
    new Map(
      [...htmlFixtures, ...scrolledFixtures].map((fixture) => [
        fixture.id,
        fixture,
      ]),
    ).values(),
  );
  const htmlIds = new Set(sourceFixtures.map((fixture) => fixture.id));
  const fixtures = [
    ...sourceFixtures.map((fixture) => {
      const textFixture = markdownById.get(fixture.id);
      return textFixture
        ? {
            ...fixture,
            round: textFixture.round,
            status: textFixture.status,
            homeScore: textFixture.homeScore,
            awayScore: textFixture.awayScore,
          }
        : fixture;
    }),
    ...markdownFixtures.filter((fixture) => !htmlIds.has(fixture.id)),
  ];
  for (const fixture of fixtures) {
    knownFixtures.set(fixture.id, fixture);
    const competitionKey = competitionKeys.get(fixture.id);
    if (competitionKey) knownCompetitionKeys.set(fixture.id, competitionKey);
    try {
      const sourcePath = new URL(fixture.sourceUrl).pathname;
      if (/^\/match\/[a-z0-9-]+\/[a-z0-9-]+\/\d+$/i.test(sourcePath)) {
        knownMatchPaths.set(fixture.id, sourcePath);
      }
    } catch {
      // A malformed source URL should not prevent the rest of the fixture list loading.
    }
  }
  const result = {
    date: new Date(`${date}T00:00:00.000Z`),
    sourceUrl: `${besoccerOrigin}${path}`,
    fetchedAt: new Date(),
    fixtures,
  };
  saveCache(`fixtures:${date}`, result, 60_000);
  return result;
}

export async function getMatchById(
  matchId: string,
  requestedPath?: string,
): Promise<MatchDetails> {
  const cached = fromCache<MatchDetails>(`match:${matchId}`);
  if (cached) return cached;

  const matchPath = sourcePathForMatch(matchId, requestedPath);
  const pages = sourcePageTabs.map((tab) => `${matchPath}/${tab}`);
  const [mainResult, ...sectionResults] = await Promise.allSettled([
    getMarkdown(matchPath),
    ...pages.map((path) => getMarkdown(path)),
  ]);
  if (mainResult.status === "rejected") throw mainResult.reason;

  const mainMarkdown = mainResult.value;
  const sectionMarkdown = sectionResults.map((result) =>
    result.status === "fulfilled" ? result.value : "",
  );
  const [
    roundMarkdown,
    tableMarkdown,
    analysisMarkdown,
    previewMarkdown,
    lineupMarkdown,
    oddsMarkdown,
    eventMarkdown,
  ] = sectionMarkdown;
  const knownFixture = knownFixtures.get(matchId);
  const sourceCompetitionKey = competitionKeyFromMatchPage(mainMarkdown);
  const matchDate =
    knownFixture?.kickoff.slice(0, 10) ??
    inferMatchDate(mainMarkdown) ??
    new Date().toISOString().slice(0, 10);
  const roundInfo = parseRound(roundMarkdown ?? "");
  let roundMatches = parseFixtureLinks(
    roundMarkdown ?? "",
    matchDate,
    roundInfo.competition,
    roundInfo.round,
  );
  const pageFixture = parseMatchFixture(
    mainMarkdown,
    matchPath,
    matchId,
    matchDate,
  );
  let fixture = pageFixture ?? knownFixture ?? roundMatches.find((item) => item.id === matchId);

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

  fixture = {
    ...fixture,
    ...(knownFixture ?? {}),
    ...(pageFixture ?? {}),
    homeBadgeUrl: pageFixture?.homeBadgeUrl ?? knownFixture?.homeBadgeUrl ?? fixture.homeBadgeUrl,
    awayBadgeUrl: pageFixture?.awayBadgeUrl ?? knownFixture?.awayBadgeUrl ?? fixture.awayBadgeUrl,
    homeScore: pageFixture?.homeScore ?? knownFixture?.homeScore ?? fixture.homeScore,
    awayScore: pageFixture?.awayScore ?? knownFixture?.awayScore ?? fixture.awayScore,
    kickoff:
      pageFixture?.kickoff.includes(":")
        ? pageFixture.kickoff
        : knownFixture?.kickoff ?? pageFixture?.kickoff ?? fixture.kickoff,
    status:
      pageFixture?.status === "Match details"
        ? knownFixture?.status ?? pageFixture.status
        : pageFixture?.status ?? knownFixture?.status ?? fixture.status,
    competition: fixture.competition || roundInfo.competition,
    round: fixture.round ?? roundInfo.round,
  };

  const roundDateResults = await Promise.allSettled(
    roundFixtureDates(fixture.kickoff).map((date) => listFixturesForDate(date)),
  );
  const roundFixturesById = new Map<string, Fixture>();
  for (const dateResult of roundDateResults) {
    if (dateResult.status !== "fulfilled") continue;
    for (const candidate of dateResult.value.fixtures) {
      const candidateCompetitionKey = knownCompetitionKeys.get(candidate.id);
      const belongsToCompetition =
        sourceCompetitionKey && candidateCompetitionKey
          ? candidateCompetitionKey === sourceCompetitionKey
          : normalizeCompetition(candidate.competition) ===
            normalizeCompetition(fixture.competition);
      if (belongsToCompetition) {
        roundFixturesById.set(candidate.id, {
          ...candidate,
          competition: fixture.competition,
          round: fixture.round,
        });
      }
    }
  }
  roundFixturesById.set(fixture.id, fixture);
  roundMatches = Array.from(roundFixturesById.values()).sort((a, b) =>
    a.kickoff.localeCompare(b.kickoff),
  );

  const sourcePages: MatchContentPage[] = sourcePageTabs.map((tab, index) => {
    const result = sectionResults[index];
    const sourceUrl = `${besoccerOrigin}${matchPath}/${tab}`;
    return {
      tab,
      sourceUrl,
      sections: result?.status === "fulfilled"
        ? parseSourceSections(result.value)
        : [{
            title: "Source section unavailable",
            text: ["BeSoccer did not return this section for the current request."],
            tables: [],
          }],
    };
  });

  const odds = Array.from(
    new Map(
      [mainMarkdown, oddsMarkdown ?? "", ...sectionMarkdown]
        .flatMap((markdown) =>
          markdown ? parseOdds(markdown, `${besoccerOrigin}${matchPath}/odds`) : [],
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
    events: parseEvents(
      eventMarkdown ?? "",
      fixture.homeTeam,
      fixture.awayTeam,
    ),
    odds,
    sourcePages,
  };
  saveCache(`match:${matchId}`, result, 120_000);
  return result;
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}
