import type {
  Fixture,
  FixtureList,
  LineupPlayer,
  MatchContentPage,
  MatchDetails,
  MatchEvent,
  MatchOdds,
  MatchStandingsRound,
  MatchStat,
  OddsEntry,
  PlayerContentPage,
  PlayerContentPageTab,
  PlayerDetails,
  PlayerProfile,
  PreviewFact,
  StandingRow,
  TeamContentPage,
  TeamContentPageTab,
  TeamDetails,
  TeamProfile,
  TeamLineup,
} from "@workspace/api-zod";
import { logger } from "./logger";

const besoccerOrigin = "https://www.besoccer.com";
const markdownProxyOrigin = "https://r.jina.ai/http://www.besoccer.com";
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const pendingRequests = new Map<string, Promise<string>>();
const rawHtmlWaiters: Array<() => void> = [];
let activeRawHtmlRequests = 0;
const knownFixtures = new Map<string, Fixture>();
const knownMatchPaths = new Map<string, string>();
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

function sourceCacheTtl(path: string): number {
  return /^\/livescore\/\d{4}-\d{2}-\d{2}(?:[?#]|$)/i.test(path) ||
    /^\/ajax\/matchesScroll(?:[?#]|$)/i.test(path)
    ? 15_000
    : 90_000;
}

async function acquireRawHtmlSlot(): Promise<void> {
  if (activeRawHtmlRequests < 2) {
    activeRawHtmlRequests += 1;
    return;
  }
  await new Promise<void>((resolve) => rawHtmlWaiters.push(resolve));
}

function releaseRawHtmlSlot(): void {
  const next = rawHtmlWaiters.shift();
  if (next) {
    next();
  } else {
    activeRawHtmlRequests -= 1;
  }
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
    saveCache(`page:${path}`, markdown, sourceCacheTtl(path));
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
    await acquireRawHtmlSlot();
    try {
      const requestUrl = `${markdownProxyOrigin}${path}`;
      const requestOptions = {
        headers: {
          Accept: "text/html",
          "User-Agent": "FootballFixturesExplorer/1.0",
          "X-Respond-With": "html",
        },
        signal: AbortSignal.timeout(25_000),
      };
      let response = await fetch(requestUrl, requestOptions);
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const retryAfterMs = retryAfter
          ? /^\d+(?:\.\d+)?$/.test(retryAfter)
            ? Number(retryAfter) * 1_000
            : Date.parse(retryAfter) - Date.now()
          : 1_200;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(5_000, Math.max(500, retryAfterMs))),
        );
        response = await fetch(requestUrl, requestOptions);
      }
      if (!response.ok) {
        throw new Error(`Source proxy returned HTTP ${response.status}`);
      }

      const html = await response.text();
      if (html.length < 80) {
        throw new Error("The BeSoccer page returned no odds data");
      }
      saveCache(cacheKey, html, sourceCacheTtl(path));
      return html;
    } finally {
      releaseRawHtmlSlot();
    }
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
    const kickoffText = kickoff ? cleanHtmlText(kickoff) : "";
    const sourceStartTime = htmlAttribute(openingTag, "starttime")?.match(
      /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/,
    );
    const kickoffDate =
      sourceStartTime?.[1] ?? dateFromLabel(kickoffText, date);
    const kickoffTime =
      kickoffText.match(/\b\d{1,2}:\d{2}\b/)?.[0] ??
      (sourceStartTime?.[2] && sourceStartTime[2] !== "00:00"
        ? sourceStartTime[2]
        : null);
    const marker = card.match(
      /<div\b(?=[^>]*\bdates\b)[^>]*>([\s\S]*?)<\/div>/i,
    )?.[1];
    const scoreMarker = card.match(
      /<div\b(?=[^>]*\bmarker\b)[^>]*>([\s\S]*?)<\/div>/i,
    )?.[1];
    const score = scoreMarker
      ? cleanHtmlText(scoreMarker).match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/)
      : null;
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
      kickoff: kickoffTime ? `${kickoffDate} ${kickoffTime}` : kickoffDate,
      status,
      homeScore: score ? Number(score[1]) : null,
      awayScore: score ? Number(score[2]) : null,
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

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[+º°]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
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

function normalizeSourceAssetUrl(value: string | undefined): string | null {
  if (!value) return null;
  let candidate = decodeEntities(value)
    .replace(/%22/gi, "")
    .replace(/\\/g, "")
    .trim();
  candidate = candidate.replace(
    /^https?:\/\/www\.besoccer\.com\/+/i,
    "",
  );
  const protocol = candidate.match(/^(https?):\/+/i);
  if (!protocol) {
    const embeddedProtocol = candidate.search(/https?:\/+/i);
    if (embeddedProtocol < 0) return null;
    candidate = candidate.slice(embeddedProtocol);
  }

  candidate = candidate.replace(
    /^(https?):\/+([^/]+)([\s\S]*)$/i,
    (_match, scheme: string, host: string, rest: string) =>
      `${scheme}://${host}${rest.replace(/\/{2,}/g, "/")}`,
  );
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function parseStandings(markdown: string): StandingRow[] {
  const rows: StandingRow[] = [];
  const normalized = markdown
    .replace(/\\n/g, " ")
    .replace(/\\\//g, "/")
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    );

  for (const line of normalized.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 11) continue;

    const position = parseNumber(cleanHtmlText(cells[0] ?? ""));
    if (position === null) continue;
    const teamLink = cells[2]?.match(/\[([\s\S]+?)\]\(([^)]+)\)/);
    const teamSpan = cells[2]?.match(/\[\s*([\s\S]*?)<\/span>/i);
    const team = cleanMarkdown(teamSpan?.[1] ?? teamLink?.[1] ?? cells[2] ?? "");
    const teamSlug =
      cells[2]?.match(
        /\/team\/+([a-z0-9-]+)/i,
      )?.[1] ?? null;
    if (!team) continue;

    const formMatch = cells[2]?.match(/\]\([^)]+\)\s*(.*)$/);
    const badgeUrl = normalizeSourceAssetUrl(
      cells[1]?.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1],
    );
    rows.push({
      position,
      team,
      teamSlug,
      badgeUrl,
      form: formMatch?.[1] ? cleanMarkdown(formMatch[1]) : null,
      points: parseNumber(cleanHtmlText(cells[3])),
      matchesPlayed: parseNumber(cleanHtmlText(cells[4])),
      wins: parseNumber(cleanHtmlText(cells[5])),
      draws: parseNumber(cleanHtmlText(cells[6])),
      losses: parseNumber(cleanHtmlText(cells[7])),
      goalsFor: parseNumber(cleanHtmlText(cells[8])),
      goalsAgainst: parseNumber(cleanHtmlText(cells[9])),
      goalDifference: parseNumber(cleanHtmlText(cells[10])),
    });
    if (rows.length >= 64) break;
  }
  return rows;
}

function parseStandingsPage(
  html: string,
): {
  currentRound: number | null;
  options: Array<{ round: number; label: string }>;
  sourceParams: {
    type: string;
    itemId: string;
    competitionId: string;
    year: string;
    group: string;
  } | null;
} {
  const tableTag = html.match(
    /<div\b(?=[^>]*\bid=["']classificationTables["'])[^>]*>/i,
  )?.[0];
  const tableAttributes = tableTag ? parseHtmlAttributes(tableTag) : {};
  const select = html.match(
    /<select\b(?=[^>]*\bdata-cy=["']roundSelect["'])[^>]*>([\s\S]*?)<\/select>/i,
  )?.[1] ?? "";
  const options = Array.from(
    select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi),
    (match) => {
      const optionTag = `<option ${match[1] ?? ""}>`;
      const round = parseNumber(htmlAttribute(optionTag, "value") ?? undefined);
      const sourceLabel = cleanHtmlText(match[2] ?? "");
      if (round === null) return null;
      const label = sourceLabel.replace(/^Matchday\s+/i, "Round ");
      return { round, label: label || `Round ${round}` };
    },
  ).filter(
    (option): option is { round: number; label: string } => option !== null,
  );

  const type = tableAttributes["data-type"];
  const itemId = tableAttributes["data-item"];
  const competitionId = tableAttributes["data-competition"];
  const year = tableAttributes["data-year"];
  const group = tableAttributes["data-group"];
  const sourceParams =
    type && itemId && competitionId && year && group
      ? { type, itemId, competitionId, year, group }
      : null;

  return {
    currentRound: parseNumber(tableAttributes["data-round"]),
    options,
    sourceParams,
  };
}

function parseStandingRowsFromHtml(
  html: string,
  tabId: "tab_total0" | "tab_local0" | "tab_visitor0",
): StandingRow[] {
  const startMatch = html.match(
    new RegExp(`<div\\b(?=[^>]*\\bid=["']${tabId}["'])[^>]*>`, "i"),
  );
  if (!startMatch || startMatch.index === undefined) return [];

  const nextTab = html
    .slice(startMatch.index + startMatch[0].length)
    .match(/<div\b(?=[^>]*\bid=["']tab_[^"']+["'])[^>]*>/i);
  const end = nextTab?.index === undefined
    ? html.length
    : startMatch.index + startMatch[0].length + nextTab.index;
  const section = html.slice(startMatch.index, end);
  const rows: StandingRow[] = [];

  for (const rowMatch of section.matchAll(/<tr\b[^>]*class=["'][^"']*row-body[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1] ?? "";
    const cells = Array.from(
      row.matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi),
      (cell) => cell[2] ?? "",
    );
    if (cells.length < 11) continue;

    const position = parseNumber(cleanHtmlText(cells[0] ?? ""));
    const teamName = cells[2]?.match(
      /<span\b[^>]*class=["'][^"']*team-name[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    )?.[1];
    const team = cleanHtmlText(
      teamName ??
        cells[2]?.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] ??
        "",
    );
    if (position === null || !team) continue;
    const teamAnchor = cells[2]?.match(/<a\b[^>]*>/i)?.[0] ?? "";
    const teamHref = htmlAttribute(teamAnchor, "href");
    const teamSlug = teamHref?.match(/\/team\/([a-z0-9-]+)/i)?.[1] ?? null;

    const form = Array.from(
      (cells[2] ?? "").matchAll(
        /<span\b[^>]*class=["'][^"']*bg-match-res\s+(win|draw|lose)[^"']*["'][^>]*>/gi,
      ),
      (result) =>
        result[1]?.toLowerCase() === "win"
          ? "W"
          : result[1]?.toLowerCase() === "draw"
            ? "D"
            : "L",
    ).join("");

    rows.push({
      position,
      team,
      teamSlug,
      badgeUrl: cells[1]?.match(/<img\b[^>]*>/i)?.[0]
        ? htmlAttribute(cells[1]?.match(/<img\b[^>]*>/i)?.[0] ?? "", "src")
        : null,
      form: form || null,
      points: parseNumber(cleanHtmlText(cells[3] ?? "")),
      matchesPlayed: parseNumber(cleanHtmlText(cells[4] ?? "")),
      wins: parseNumber(cleanHtmlText(cells[5] ?? "")),
      draws: parseNumber(cleanHtmlText(cells[6] ?? "")),
      losses: parseNumber(cleanHtmlText(cells[7] ?? "")),
      goalsFor: parseNumber(cleanHtmlText(cells[8] ?? "")),
      goalsAgainst: parseNumber(cleanHtmlText(cells[9] ?? "")),
      goalDifference: parseNumber(cleanHtmlText(cells[10] ?? "")),
    });
    if (rows.length >= 64) break;
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

function parseMatchStatistics(markdown: string): MatchStat[] {
  const firstPeriod = markdown.match(
    /\*\*General stats\*\*([\s\S]*?)(?=\*\*General stats\*\*|$)/i,
  )?.[1];
  if (!firstPeriod) return [];

  const text = cleanMarkdown(firstPeriod);
  const pairPatterns: Array<{ label: string; expression: RegExp }> = [
    {
      label: "Possession",
      expression: /Ball possession\s+([\d.]+%)\s+([\d.]+%)/i,
    },
    { label: "Offsides", expression: /(\d+)\s+Offsides\s+(\d+)/i },
    { label: "Corners", expression: /(\d+)\s+Corner kicks\s+(\d+)/i },
    { label: "Total shots", expression: /(\d+)\s+Total shots\s+(\d+)/i },
    { label: "Shots blocked", expression: /(\d+)\s+Shots blocked\s+(\d+)/i },
    {
      label: "Goalkeeper saves",
      expression: /(\d+)\s+Goalkeeper saves\s+(\d+)/i,
    },
    { label: "Tackles", expression: /(\d+)\s+Tackles\s+(\d+)/i },
    { label: "Passes", expression: /(\d+)\s+Passes\s+(\d+)/i },
    {
      label: "Completed passes",
      expression: /(\d+\s*\(\d+%\))\s+Completed passes\s+(\d+\s*\(\d+%\))/i,
    },
    { label: "Fouls", expression: /(\d+)\s+Fouls\s+(\d+)/i },
    { label: "Yellow cards", expression: /(\d+)\s+Yellow cards\s+(\d+)/i },
    { label: "Red cards", expression: /(\d+)\s+Red cards\s+(\d+)/i },
  ];

  return pairPatterns.flatMap(({ label, expression }) => {
    const match = text.match(expression);
    return match
      ? [{ label, homeValue: match[1] ?? "—", awayValue: match[2] ?? "—" }]
      : [];
  });
}

function parsePreview(
  markdown: string,
  homeTeam: string,
  awayTeam: string,
): PreviewFact[] {
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

  const recentForm = markdown.match(
    /## Recent form([\s\S]*?)(?=## H2H last matches|$)/i,
  )?.[1];
  const formResults = Array.from(
    recentForm?.matchAll(/^\s*([WDL])\s*$/gm) ?? [],
    (match) => match[1],
  );
  if (formResults.length >= 10) {
    facts.push({
      label: `${homeTeam} recent form`,
      value: formResults.slice(0, 5).join(" · "),
    });
    facts.push({
      label: `${awayTeam} recent form`,
      value: formResults.slice(5, 10).join(" · "),
    });
  }

  const headToHead = markdown.match(
    /## H2H last matches([\s\S]*?)(?=## Last eleven|$)/i,
  )?.[1];
  const headToHeadScores = Array.from(
    headToHead?.matchAll(
      /\[(\d{1,2}\s*-\s*\d{1,2})\]\(https?:\/\/www\.besoccer\.com\/match\/[^)]+\)/gi,
    ) ?? [],
    (match) => (match[1] ?? "").replace(/\s+/g, " "),
  );
  if (headToHeadScores.length) {
    facts.push({
      label: "Recent head-to-head scores",
      value: headToHeadScores.join(" · "),
    });
  }

  return facts;
}

function parseLineups(
  markdown: string,
  homeTeam: string,
  awayTeam: string,
): TeamLineup[] {
  const teamNames = [homeTeam, awayTeam];
  const substitutesAt = markdown.search(/^## Substitutes\b/im);
  const startersEnd = substitutesAt >= 0 ? substitutesAt : markdown.length;
  const homeHeadingMatch = Array.from(
    markdown.slice(0, startersEnd).matchAll(/^\*\*(.+?)\*\*\s*$/gm),
  ).find(
    (match) =>
      cleanMarkdown(match[1] ?? "").toLowerCase() === homeTeam.toLowerCase(),
  );
  const startersStart = homeHeadingMatch
    ? (homeHeadingMatch.index ?? 0) + homeHeadingMatch[0].length
    : 0;
  const starterSection = markdown.slice(startersStart, startersEnd);
  const playerExpression =
    /^\s*[*-]\s+\[!\[Image \d+:\s*([^\]]+)\]\(([^)]+)\)(.*?)\]\((https?:\/\/www\.besoccer\.com\/player\/[^)]+)\)/gm;
  const starterMatches = Array.from(starterSection.matchAll(playerExpression));
  const formations = Array.from(
    starterSection.matchAll(/\b\d{1,2}-\d{1,2}(?:-\d{1,2}){1,2}\b/g),
    (match) => match[0],
  );
  const coachMatches = Array.from(
    markdown.matchAll(
      /\[\*\*([^\]]+)\*\*\]\((https?:\/\/www\.besoccer\.com\/coach\/[^)]+)\)/gi,
    ),
  );

  const parseStarter = (playerMatch: RegExpMatchArray): LineupPlayer | null => {
    const description = cleanMarkdown(playerMatch[3] ?? "");
    const numberMatch = description.match(/(?:^|\s)c?\s*(\d{1,2})\s+/);
    const name = description
      .replace(/^\s*c?\s*\d{1,2}\s+/, "")
      .replace(/\s+\d{1,3}['’].*$/, "")
      .replace(/\s+\d+(?:\.\d+)?\s*$/, "")
      .trim();
    if (!name) return null;
    const rating = description.match(/(?:^|\s)(\d{1,2}\.\d)(?=\s|$)/)?.[1];
    return {
      name,
      number: parseNumber(numberMatch?.[1]),
      position: null,
      photoUrl: playerMatch[2] ?? null,
      rating: rating ? Number(rating) : null,
      isSubstitute: false,
      playerSlug: playerSlugFromSourceUrl(playerMatch[4] ?? ""),
    };
  };

  const substitutesByTeam: LineupPlayer[][] = teamNames.map(() => []);
  if (substitutesAt >= 0) {
    const substitutesSection =
      markdown.slice(substitutesAt).split(/^## (?:Legend|Referees)\b/im)[0] ?? "";
    const playerGroups = substitutesSection
      .split(/\n\s*\n/)
      .filter((group) => group.includes("besoccer.com/player/"));
    const groups = playerGroups.length
      ? playerGroups
      : [substitutesSection];

    groups.forEach((group, groupIndex) => {
      const teamIndex = Math.min(groupIndex, teamNames.length - 1);
      for (const playerLink of group.matchAll(
        /\]\((https?:\/\/www\.besoccer\.com\/player\/[^)]+)\)/g,
      )) {
        if (playerLink.index === undefined) continue;
        const rawLabel = anchorLabel(group, playerLink.index);
        const name = cleanMarkdown(rawLabel.match(/^\s*([^\[]+)/)?.[1] ?? "");
        if (
          !name ||
          substitutesByTeam[teamIndex]?.some(
            (player) => player.name.toLowerCase() === name.toLowerCase(),
          )
        ) {
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
        const rating = playerInfo.match(/\b(\d{1,2}\.\d)\b/)?.[1];
        substitutesByTeam[teamIndex]?.push({
          name,
          number: parseNumber(playerNumber?.[1]),
          position,
          photoUrl: playerPhoto?.[1] ?? null,
          rating: rating ? Number(rating) : null,
          isSubstitute: true,
          playerSlug: playerSlugFromSourceUrl(playerLink[1] ?? ""),
        });
      }
    });
  }

  return teamNames.map((team, teamIndex) => {
    const starterPlayers = starterMatches
      .slice(teamIndex * 11, teamIndex * 11 + 11)
      .map(parseStarter)
      .filter((player): player is LineupPlayer => player !== null);
    return {
      team,
      formation: formations[teamIndex] ?? null,
      coach: coachMatches[teamIndex]
        ? cleanMarkdown(coachMatches[teamIndex]?.[1] ?? "")
        : null,
      coachSlug: coachSlugFromSourceUrl(coachMatches[teamIndex]?.[2] ?? ""),
      players: [...starterPlayers, ...(substitutesByTeam[teamIndex] ?? [])],
    };
  });
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

  const uniqueEvents = Array.from(
    new Map(
      events.map((event) => [
        `${event.minute}:${event.eventType}:${event.player ?? ""}`,
        event,
      ]),
    ).values(),
  );
  const minuteOrder = (minute: string | null) => {
    const parsed = minute?.match(/(\d+)(?:\+(\d+))?/);
    return parsed ? Number(parsed[1]) * 100 + Number(parsed[2] ?? 0) : Number.MAX_SAFE_INTEGER;
  };
  return uniqueEvents.sort(
    (left, right) => minuteOrder(left.minute) - minuteOrder(right.minute),
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

function isPageChrome(line: string): boolean {
  const text = cleanMarkdown(line).toLowerCase();
  return (
    /^more$/.test(text) ||
    /^play video$/.test(text) ||
    /^video$/.test(text) ||
    /^url source:/.test(text) ||
    /^published time:/.test(text) ||
    /^copyright/.test(text) ||
    /^play responsibly/.test(text) ||
    /^legal notices and privacy/.test(text) ||
    /^sign in with google/.test(text) ||
    /^log in$/.test(text) ||
    /^continuar con facebook/.test(text) ||
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
    /^\[x\]\s*i am over 14 years old$/.test(text) ||
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
    || /^follow the match live$/.test(text)
    || /^content access$/.test(text)
    || /^watch an ad to listen to the match broadcast$/.test(text)
    || /^listen live$/.test(text)
    || /^x$/.test(text)
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
  const knownPath = knownMatchPaths.get(matchId);
  if (knownPath) return knownPath;
  if (path && canonicalMatch?.[1] === matchId) return path;
  return `/match/${matchId}`;
}

export async function listFixturesForDate(date: string): Promise<FixtureList> {
  const cached = fromCache<FixtureList>(`fixtures:${date}`);
  if (cached) return cached;

  const path = `/livescore/${date}`;
  const competitionKeys = new Map<string, string | null>();
  const htmlResult = await Promise.allSettled([getRawHtml(path)]).then(
    ([result]) => result,
  );
  let htmlFixtures: Fixture[] = [];
  let scrolledFixtures: Fixture[] = [];
  if (htmlResult.status === "fulfilled") {
    htmlFixtures = parseFixtureCards(htmlResult.value, date, competitionKeys);
    scrolledFixtures = await getScrolledFixtures(
      htmlResult.value,
      date,
      competitionKeys,
    );
  }

  const sourceFixtures = Array.from(
    new Map(
      [...htmlFixtures, ...scrolledFixtures].map((fixture) => [
        fixture.id,
        fixture,
      ]),
    ).values(),
  );
  let markdownFixtures: Fixture[] = [];
  if (htmlResult.status === "rejected" || sourceFixtures.length === 0) {
    const markdownResult = await Promise.allSettled([getMarkdown(path)]).then(
      ([result]) => result,
    );
    if (htmlResult.status === "rejected" && markdownResult.status === "rejected") {
      throw markdownResult.reason;
    }
    if (markdownResult.status === "fulfilled") {
      markdownFixtures = parseFixtureLinks(
        markdownResult.value,
        date,
        "Football",
        null,
        competitionKeys,
      );
    }
  }

  const markdownById = new Map(markdownFixtures.map((fixture) => [fixture.id, fixture]));
  const htmlIds = new Set(sourceFixtures.map((fixture) => fixture.id));
  const fixtures = [
    ...sourceFixtures.map((fixture) => {
      const textFixture = markdownById.get(fixture.id);
      return textFixture
        ? {
            ...fixture,
            round: textFixture.round,
            status: textFixture.status,
            homeScore: textFixture.homeScore ?? fixture.homeScore,
            awayScore: textFixture.awayScore ?? fixture.awayScore,
          }
        : fixture;
    }),
    ...markdownFixtures.filter((fixture) => !htmlIds.has(fixture.id)),
  ];
  for (const fixture of fixtures) {
    knownFixtures.set(fixture.id, fixture);
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
  const currentDate = new Date().toISOString().slice(0, 10);
  saveCache(`fixtures:${date}`, result, date === currentDate ? 15_000 : 60_000);
  return result;
}

export async function getMatchById(
  matchId: string,
  requestedPath?: string,
  requestedSection:
    | "rounds"
    | "standings"
    | "analysis"
    | "preview"
    | "lineups"
    | "events" = "rounds",
): Promise<MatchDetails> {
  const matchPath = sourcePathForMatch(matchId, requestedPath);
  const section = requestedSection;
  const sourceTab = section === "standings" ? "table" : section;
  const matchCacheKey = `match:${matchPath}:${section}`;
  const cached = fromCache<MatchDetails>(matchCacheKey);
  if (cached) return cached;

  const [mainMarkdown, selectedSource, previewHtml] = await Promise.all([
    getMarkdown(matchPath),
    section === "standings"
      ? getRawHtml(`${matchPath}/table`)
      : getMarkdown(`${matchPath}/${sourceTab}`),
    section === "preview"
      ? getRawHtml(`${matchPath}/preview`).catch((error: unknown) => {
          logger.warn(
            { err: error, matchPath },
            "Match preview HTML unavailable; using parsed text content",
          );
          return "";
        })
      : Promise.resolve(""),
  ]);
  const tableHtml = section === "standings" ? selectedSource : "";
  const selectedMarkdown = section === "standings" ? "" : selectedSource;
  const roundMarkdown = section === "rounds" ? selectedMarkdown : "";
  const analysisMarkdown = section === "analysis" ? selectedMarkdown : "";
  const previewMarkdown = section === "preview" ? selectedMarkdown : "";
  const lineupMarkdown = section === "lineups" ? selectedMarkdown : "";
  const eventMarkdown = section === "events" ? selectedMarkdown : "";
  const knownFixture = knownFixtures.get(matchId);
  const matchDate =
    knownFixture?.kickoff.slice(0, 10) ??
    inferMatchDate(mainMarkdown) ??
    new Date().toISOString().slice(0, 10);
  const roundInfo = parseRound(roundMarkdown ?? "");
  let roundMatches =
    section === "rounds"
      ? parseFixtureLinks(
          roundMarkdown,
          matchDate,
          roundInfo.competition,
          roundInfo.round,
        )
      : [];
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

  if (section === "rounds") {
    const roundFixturesById = new Map(
      roundMatches.map((item) => [item.id, { ...item, competition: fixture.competition, round: fixture.round }]),
    );
    roundFixturesById.set(fixture.id, fixture);
    roundMatches = Array.from(roundFixturesById.values()).sort((a, b) =>
      a.kickoff.localeCompare(b.kickoff),
    );
  }

  const parsedHtmlStandings = parseStandingRowsFromHtml(
    tableHtml,
    "tab_total0",
  );
  const standingsPage =
    section === "standings" ? parseStandingsPage(tableHtml) : null;
  const previewHtmlSections =
    section === "preview" && previewHtml
      ? parseMatchHtmlSections(previewHtml)
      : [];
  const sourcePages: MatchContentPage[] =
    section === "standings"
      ? []
      : [
          {
            tab: sourceTab,
            sourceUrl: `${besoccerOrigin}${matchPath}/${sourceTab}`,
            sections:
              previewHtmlSections.length > 0
                ? previewHtmlSections
                : parseSourceSections(selectedMarkdown),
          },
        ];
  const result: MatchDetails = {
    fixture,
    sourceUrl: `${besoccerOrigin}${matchPath}`,
    fetchedAt: new Date(),
    roundMatches,
    standings: section === "standings" ? parsedHtmlStandings : [],
    homeStandings:
      section === "standings"
        ? parseStandingRowsFromHtml(tableHtml, "tab_local0")
        : [],
    awayStandings:
      section === "standings"
        ? parseStandingRowsFromHtml(tableHtml, "tab_visitor0")
        : [],
    currentStandingsRound: standingsPage?.currentRound ?? null,
    standingsRoundOptions: standingsPage?.options ?? [],
    analysisStats: analysisMarkdown ? parseAnalysis(analysisMarkdown) : [],
    matchStatistics: eventMarkdown ? parseMatchStatistics(eventMarkdown) : [],
    previewFacts: parsePreview(
      previewMarkdown ?? "",
      fixture.homeTeam,
      fixture.awayTeam,
    ),
    lineups:
      section === "lineups"
        ? parseLineups(lineupMarkdown, fixture.homeTeam, fixture.awayTeam)
        : [],
    events:
      section === "events"
        ? parseEvents(eventMarkdown, fixture.homeTeam, fixture.awayTeam)
        : [],
    odds: [],
    sourcePages,
  };
  saveCache(matchCacheKey, result, 90_000);
  return result;
}

export async function getMatchStandingsByRound(
  matchId: string,
  round: number,
  requestedPath?: string,
): Promise<MatchStandingsRound> {
  const matchPath = sourcePathForMatch(matchId, requestedPath);
  const tableHtml = await getRawHtml(`${matchPath}/table`);
  const standingsPage = parseStandingsPage(tableHtml);
  const sourceParams = standingsPage.sourceParams;
  if (!sourceParams) {
    throw new Error("The match does not expose round-specific standings");
  }
  if (!standingsPage.options.some((option) => option.round === round)) {
    throw new Error("Standings are unavailable for the selected round");
  }

  const query = new URLSearchParams({
    ...sourceParams,
    round: String(round),
  });
  const markdown = await getMarkdown(`/ajax/reloadTable?${query.toString()}`);
  const standings = parseStandings(markdown);
  if (!standings.length) {
    throw new Error("Standings are unavailable for the selected round");
  }

  return { round, standings };
}

const teamPageSources: Array<{
  tab: TeamContentPageTab;
  suffix: string;
}> = [
  { tab: "info", suffix: "" },
  { tab: "matches", suffix: "matches" },
  { tab: "transfers", suffix: "transfers" },
  { tab: "squad", suffix: "squad" },
  { tab: "standings", suffix: "table" },
  { tab: "career", suffix: "career-path" },
  { tab: "competitions", suffix: "competitions" },
  { tab: "injuries-suspensions", suffix: "injuries-suspensions" },
  { tab: "honours", suffix: "honours" },
  { tab: "historical", suffix: "history" },
];

function teamProfilePath(slug: string, suffix: string): string {
  return suffix ? `/team/${suffix}/${slug}` : `/team/${slug}`;
}

function parseTeamProfile(markdown: string, slug: string): TeamProfile {
  if (/<(?:!doctype|html|body)\b/i.test(markdown)) {
    const tree = parseTeamHtml(markdown);
    const nodes: TeamHtmlNode[] = [];
    const collectNodes = (node: TeamHtmlNode) => {
      nodes.push(node);
      for (const child of node.children) {
        if (typeof child !== "string") collectNodes(child);
      }
    };
    collectNodes(tree);

    const profileHeading = nodes.find(
      (node) =>
        /^h[1-4]$/.test(node.tag) &&
        /statistics season/i.test(teamNodeText(node)),
    );
    const name =
      teamNodeText(profileHeading ?? tree)
        .replace(/[’'´]s\s+statistics season\b.*$/i, "")
        .trim() || slug;
    const matchesTeam = (node: TeamHtmlNode): boolean => {
      if (
        node.tag === "img" &&
        /\/img_data\/equipos\//i.test(node.attrs.src ?? "") &&
        (node.attrs.alt ?? "").trim().toLocaleLowerCase() === name.toLocaleLowerCase()
      ) {
        return true;
      }
      return node.children.some(
        (child) => typeof child !== "string" && matchesTeam(child),
      );
    };
    const headerContainer = nodes.find(
      (node) =>
        teamNodeHasClass(node, "img-container") && matchesTeam(node),
    );
    const profileImages: TeamHtmlNode[] = [];
    const collectImages = (node: TeamHtmlNode) => {
      if (node.tag === "img") profileImages.push(node);
      for (const child of node.children) {
        if (typeof child !== "string") collectImages(child);
      }
    };
    if (headerContainer) collectImages(headerContainer);
    const badgeNode =
      profileImages.find(
        (node) =>
          /\/img_data\/equipos\//i.test(node.attrs.src ?? "") &&
          (node.attrs.alt ?? "").trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
      ) ??
      nodes.find(
        (node) =>
          node.tag === "img" &&
          /\/img_data\/equipos\//i.test(node.attrs.src ?? "") &&
          (node.attrs.alt ?? "").trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
    const badgeUrl = badgeNode ? imageUrlFromNode(badgeNode) : null;
    const flagNode = profileImages.find(
      (node) =>
        teamNodeHasClass(node, "flag") ||
        /\/flags\/round\//i.test(node.attrs.src ?? ""),
    );
    const countryFlagUrl = flagNode ? imageUrlFromNode(flagNode) : null;
    let country: string | null = null;
    try {
      const code = new URL(countryFlagUrl ?? "").pathname.match(/\/([a-z]{2})\.png$/i)?.[1];
      country = code
        ? new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code.toUpperCase()
        : null;
    } catch {
      country = null;
    }
    const eloNode = nodes.find(
      (node) => teamNodeHasClass(node, "elo") && /^\d{2,3}$/.test(teamNodeText(node)),
    );

    return {
      slug,
      name,
      badgeUrl,
      country,
      countryFlagUrl,
      elo: eloNode ? teamNodeText(eloNode) : null,
      sourceUrl: `${besoccerOrigin}${teamProfilePath(slug, "")}`,
    };
  }

  const statisticsHeading = markdown.match(
    /^#\s+(.+?)(?:[’'´]s)?\s+statistics season\b/im,
  )?.[1]?.trim();
  const title = markdown.match(/^Title:\s*(.+)$/im)?.[1]?.trim() ?? "";
  const titleName = title
    .replace(/\s+live score\b.*$/i, "")
    .replace(/\s*\|\s*BeSoccer.*$/i, "")
    .trim();
  const name = statisticsHeading || titleName || slug;

  const badgeCandidates = Array.from(
    markdown.matchAll(/!\[[^\]]*:\s*([^\]]+)\]\((https?:\/\/[^)]+)\)/g),
  ).filter(
    (match) =>
      match[1]?.trim().toLocaleLowerCase() === name.toLocaleLowerCase() &&
      /\/img_data\/equipos\//i.test(match[2] ?? ""),
  );
  const infoTabsIndex = markdown.indexOf(
    `[Info](${besoccerOrigin}/team/${slug})`,
  );
  const badge =
    badgeCandidates
      .filter((match) => infoTabsIndex >= 0 && (match.index ?? -1) < infoTabsIndex)
      .at(-1) ??
    badgeCandidates.find((match) => /[?&]size=120x(?:&|$)/i.test(match[2] ?? "")) ??
    badgeCandidates[0];
  const badgeUrl = badge?.[2] ?? null;
  const badgeIndex = badge?.index ?? -1;
  const badgeEnd =
    badgeIndex >= 0 ? badgeIndex + (badge?.[0]?.length ?? 0) : -1;
  const nearbyProfile = badgeIndex >= 0
    ? markdown.slice(Math.max(0, badgeIndex - 500), badgeIndex)
    : markdown;
  const flagMatch = Array.from(
    nearbyProfile.matchAll(
      /!\[[^\]]*\]\((https?:\/\/[^)]*\/media\/img\/flags\/round\/([a-z]{2})\.png[^)]*)\)/gi,
    ),
  ).at(-1);
  const countryCode = flagMatch?.[2]?.toUpperCase();
  const country = countryCode
    ? new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode) ?? countryCode
    : null;
  const infoBlock = badgeEnd >= 0
    ? markdown.slice(
        badgeEnd,
        infoTabsIndex > badgeEnd ? infoTabsIndex : badgeEnd + 100,
      )
    : "";
  const elo =
    infoBlock
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^\d{2,3}$/.test(line)) ?? null;

  return {
    slug,
    name,
    badgeUrl,
    country,
    countryFlagUrl: flagMatch?.[1] ?? null,
    elo,
    sourceUrl: `${besoccerOrigin}${teamProfilePath(slug, "")}`,
  };
}

function parseTeamSections(
  source: string,
  slug: string,
  tab: TeamContentPageTab,
): TeamContentPage["sections"] {
  if (/<(?:!doctype|html|body)\b/i.test(source)) {
    const sections = parseTeamHtmlSections(source);
    if (sections.length > 0) return sections;
  }

  const markdown = source;
  const tabLink = markdown.indexOf(`/team/${slug})`);
  const lineEnd = tabLink >= 0 ? markdown.indexOf("\n", tabLink) : -1;
  let content = lineEnd >= 0 ? markdown.slice(lineEnd + 1) : markdown;
  if (tab === "info") {
    const firstTeamSection = content.search(/^##\s+/m);
    if (firstTeamSection >= 0) content = content.slice(firstTeamSection);
  }
  return parseSourceSections(content);
}

type TeamHtmlNode = {
  tag: string;
  attrs: Record<string, string>;
  children: Array<TeamHtmlNode | string>;
};

type TeamContentBlock = NonNullable<
  MatchContentPage["sections"][number]["blocks"]
>[number];

const voidHtmlTags = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);
const ignoredTeamModules = new Set([
  "mod_bet_age_confirm",
  "mod_seoH1",
  "mod_login_popup",
  "mod_register_popup",
  "mod_popupFavourites",
  "mod_shareGroupPopup",
  "mod_infographyPopup",
  "mod_sticky",
]);
const teamModuleTitles: Record<string, string> = {
  mod_basicInfo: "Club information",
  mod_nextLastMatch: "Recent and upcoming matches",
  mod_streakResume: "Recent form",
  mod_transfers: "Transfers",
  mod_coachStats: "Coach statistics",
  mod_featuredPlayers: "Standout players",
  mod_leaguePerfomance: "League performance",
  mod_injuriesResume: "Injuries and suspensions",
  mod_season: "Season statistics",
  mod_commonEleven: "Most-used lineup",
  mod_lastSeasons: "Recent seasons",
  mod_palmaresResume: "Honours",
  mod_stadium: "Stadium",
  mod_socialMedia: "Club links",
  mod_matches: "Matches",
  mod_squad: "Squad",
  mod_featuredSquad: "Featured players",
  mod_participated_players: "Players",
  mod_loan_playersin: "Players on loan",
  mod_loan_playersout: "Players loaned out",
  mod_tables: "League standings",
  mod_trajectory: "Career",
  mod_competitions: "Competitions",
  mod_competition_info: "Competition information",
  mod_next_match: "Upcoming matches",
  mod_streak: "Competition form",
  mod_injuries_suspensions: "Injuries and suspensions",
  mod_honours: "Honours",
  mod_history: "Historical results",
};
const ignoredPlayerModules = new Set([
  "mod_bet_age_confirm",
  "mod_seoH1",
  "mod_login_popup",
  "mod_register_popup",
  "mod_popupFavourites",
  "mod_sticky",
]);
const playerModuleTitles: Record<string, string> = {
  mod_player_season: "Current season",
  mod_actual_transfers: "Recent transfer",
  mod_player_last_match: "Last match",
  mod_news_scroll: "Latest news",
  mod_player_stats: "Player information",
  mod_last_matches_streak: "Recent matches",
  mod_player_competitions: "Competitions",
  mod_player_team_position: "Team position",
  mod_attributes: "Attributes",
  mod_player_rating: "Rating history",
  mod_player_market: "Market value",
  mod_player_last_transfers: "Transfer history",
  mod_player_performance: "Career performance",
  mod_club_trajectory: "Club career",
  mod_player_teammates: "Teammates",
  mod_player_performance_club: "Club performance",
  mod_player_teams: "Club history",
  mod_player_sel_info: "National team information",
  mod_national_trajectory: "National team career",
  mod_player_performance_national: "National team performance",
  mod_palmares: "Achievements",
  mod_achievements: "Milestones",
  mod_best_matches: "Best matches",
  mod_trajectory: "Career",
  mod_transfers: "Transfers",
  mod_teammates: "Teammates",
  mod_matches: "Matches",
};
const ignoredMatchModules = new Set([
  ...ignoredTeamModules,
  ...ignoredPlayerModules,
  "mod_betBanner",
  "mod_bannerLS",
  "mod_warned",
  "mod_popup_stadium",
]);
const matchModuleTitles: Record<string, string> = {
  mod_match_pre_new: "Match preview",
  mod_match_stats_general: "Match statistics",
  mod_match_info: "Match information",
  mod_match_recent_form: "Recent form",
  mod_match_knockout: "Knockout context",
  mod_match_h2h: "Head-to-head",
  mod_match_lastLineup: "Recent lineups",
  mod_match_injuries: "Availability",
  mod_match_goals_progression: "Goal progression",
  mod_match_offensive_contribution: "Attacking contribution",
  mod_match_featured_players: "Featured players",
  mod_match_attributes: "Team attributes",
};

function parseHtmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attributeText = tag.replace(/^<\/?[^\s>]+/, "").replace(/\/?>$/, "");
  for (const match of attributeText.matchAll(
    /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  )) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (key && value !== undefined) attrs[key] = decodeEntities(value);
  }
  return attrs;
}

function parseTeamHtml(html: string): TeamHtmlNode {
  const root: TeamHtmlNode = { tag: "root", attrs: {}, children: [] };
  const stack = [root];
  const withoutExecutableContent = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");

  for (const tokenMatch of withoutExecutableContent.matchAll(
    /<\/?[a-z][^>]*>|[^<]+/gi,
  )) {
    const token = tokenMatch[0] ?? "";
    if (token.startsWith("<")) {
      if (/^<!|^<\?/.test(token)) continue;
      const closing = /^<\//.test(token);
      const tag = token.match(/^<\/?\s*([a-z][\w:-]*)/i)?.[1]?.toLowerCase();
      if (!tag) continue;
      if (closing) {
        const index = stack.map((node) => node.tag).lastIndexOf(tag);
        if (index > 0) stack.length = index;
        continue;
      }

      const node: TeamHtmlNode = {
        tag,
        attrs: parseHtmlAttributes(token),
        children: [],
      };
      stack[stack.length - 1]?.children.push(node);
      if (!voidHtmlTags.has(tag) && !/\/\s*>$/.test(token)) stack.push(node);
      continue;
    }

    stack[stack.length - 1]?.children.push(token);
  }

  return root;
}

function collapseRepeatedSourceText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const words = normalized.split(" ");
  if (words.length > 1 && words.length % 2 === 0) {
    const midpoint = words.length / 2;
    const firstHalf = words.slice(0, midpoint);
    const secondHalf = words.slice(midpoint);
    if (
      firstHalf.join(" ").toLocaleLowerCase() ===
      secondHalf.join(" ").toLocaleLowerCase()
    ) {
      return firstHalf.join(" ");
    }
  }
  return normalized;
}

function teamNodeText(node: TeamHtmlNode): string {
  return collapseRepeatedSourceText(node.children
    .map((child) => (typeof child === "string" ? child : teamNodeText(child)))
    .join(" ")
  );
}

function teamNodeHasClass(node: TeamHtmlNode, name: string): boolean {
  return (node.attrs.class ?? "").split(/\s+/).includes(name);
}

function teamNodeHidden(node: TeamHtmlNode): boolean {
  const classes = node.attrs.class ?? "";
  const style = (node.attrs.style ?? "").replace(/\s+/g, "").toLowerCase();
  return (
    node.attrs.hidden !== undefined ||
    node.attrs["aria-hidden"] === "true" ||
    /(?:^|;)display:none(?:;|$)/.test(style) ||
    /(?:^|;)visibility:hidden(?:;|$)/.test(style) ||
    /\b(?:hidden|popup|advertisement|adunit|sticky)\b/i.test(classes)
  );
}

const teamContentControlTags = new Set([
  "button",
  "form",
  "input",
  "label",
  "nav",
  "option",
  "select",
  "textarea",
]);

function teamNodeIsControl(node: TeamHtmlNode): boolean {
  if (teamContentControlTags.has(node.tag)) return true;
  if (node.tag === "ul" && teamNodeHasClass(node, "panel-tab")) return true;
  if (teamNodeHasClass(node, "share-media")) return true;
  if (node.tag !== "a") return false;

  const href = (node.attrs.href ?? "").trim();
  return (
    href.startsWith("#") ||
    /^javascript:/i.test(href) ||
    node.attrs["data-cy"] === "tab"
  );
}

function teamNodeVisibleText(node: TeamHtmlNode): string {
  if (teamNodeHidden(node) || teamNodeIsControl(node)) return "";
  return collapseRepeatedSourceText(node.children
    .map((child) =>
      typeof child === "string" ? decodeEntities(child) : teamNodeVisibleText(child),
    )
    .join(" ")
  );
}

function imageUrlFromNode(node: TeamHtmlNode): string | null {
  const candidates = [
    node.attrs["data-src"],
    node.attrs["data-original"],
    node.attrs.src,
  ].filter((value): value is string => Boolean(value && !value.startsWith("data:")));
  for (const raw of candidates) {
    try {
      const url = new URL(raw, besoccerOrigin);
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch {
      // Try the next available lazy-loading source attribute.
    }
  }
  return null;
}

type TeamContentImage = NonNullable<TeamContentBlock["images"]>[number];

function contentImageFromNode(node: TeamHtmlNode): TeamContentImage | null {
  const url = imageUrlFromNode(node);
  const alt = (node.attrs.alt ?? "").trim();
  if (!url || /^(?:logo|team icon|icon|schedule|football pitch)$/i.test(alt)) {
    return null;
  }
  return { url, alt };
}

function contentImagesWithin(node: TeamHtmlNode): TeamContentImage[] {
  const images: TeamContentImage[] = [];
  const seen = new Set<string>();
  const visit = (current: TeamHtmlNode) => {
    if (teamNodeHidden(current) || teamNodeIsControl(current)) return;
    if (current.tag === "img") {
      const image = contentImageFromNode(current);
      if (image && !seen.has(image.url)) {
        seen.add(image.url);
        images.push(image);
      }
      return;
    }
    for (const child of current.children) {
      if (typeof child !== "string") visit(child);
    }
  };
  visit(node);
  return images;
}

function teamTableCellText(node: TeamHtmlNode): string {
  if (teamNodeHasClass(node, "name")) {
    const findTeamName = (current: TeamHtmlNode): TeamHtmlNode | null => {
      if (teamNodeHasClass(current, "team-name")) return current;
      for (const child of current.children) {
        if (typeof child !== "string") {
          const result = findTeamName(child);
          if (result) return result;
        }
      }
      return null;
    };
    const name = findTeamName(node);
    if (name) return teamNodeVisibleText(name);
  }
  return teamNodeText(node);
}

function teamTableHeaderText(node: TeamHtmlNode): string {
  const text = teamNodeVisibleText(node);
  if (text) return text;

  const findDescription = (current: TeamHtmlNode): string | null => {
    for (const key of ["aria-label", "title", "data-title", "data-original-title"]) {
      const value = current.attrs[key]?.trim();
      if (value) return value;
    }
    for (const child of current.children) {
      if (typeof child !== "string") {
        const result = findDescription(child);
        if (result) return result;
      }
    }
    return null;
  };
  const description = findDescription(node);
  if (description) return description;

  const findEventCode = (current: TeamHtmlNode): string | null => {
    const match = (current.attrs.class ?? "").match(/\bevent-([a-z0-9_-]+)\b/i);
    if (match?.[1]) return `Stat ${match[1]}`;
    for (const child of current.children) {
      if (typeof child !== "string") {
        const result = findEventCode(child);
        if (result) return result;
      }
    }
    return null;
  };
  return findEventCode(node) ?? "";
}

type TeamTabPanelContext = {
  inactivePanelIds: Set<string>;
  activeContentTab: string | null;
};

function teamTabPanelContext(module: TeamHtmlNode): TeamTabPanelContext {
  const allTargets = new Set<string>();
  const activeTargets = new Set<string>();
  const visit = (
    node: TeamHtmlNode,
    insideTabList = false,
    insideActiveTab = false,
  ) => {
    const inTabList =
      insideTabList ||
      (node.tag === "ul" && teamNodeHasClass(node, "panel-tab"));
    const active =
      insideActiveTab ||
      (node.tag === "li" && teamNodeHasClass(node, "active"));

    if (inTabList && node.tag === "a") {
      const target = node.attrs.href?.match(/^#([a-z0-9_-]+)$/i)?.[1];
      if (target && node.attrs["data-cy"] === "tab") {
        allTargets.add(target);
        if (active) activeTargets.add(target);
      }
    }

    for (const child of node.children) {
      if (typeof child !== "string") visit(child, inTabList, active);
    }
  };
  visit(module);

  return {
    inactivePanelIds: activeTargets.size
      ? new Set([...allTargets].filter((target) => !activeTargets.has(target)))
      : new Set(),
    activeContentTab: activeTargets.values().next().value ?? null,
  };
}

function playerSlugFromSourceUrl(sourceUrl: string): string | null {
  try {
    const url = new URL(sourceUrl, besoccerOrigin);
    if (
      !["besoccer.com", "www.besoccer.com"].includes(url.hostname.toLowerCase())
    ) {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "player" || segments.includes("compare")) return null;
    const slug = segments.at(-1) ?? "";
    return /^[a-z0-9-]+$/i.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

function coachSlugFromSourceUrl(sourceUrl: string): string | null {
  try {
    const url = new URL(sourceUrl, besoccerOrigin);
    if (
      !["besoccer.com", "www.besoccer.com"].includes(url.hostname.toLowerCase())
    ) {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] !== "coach") return null;
    const slug = segments.at(-1) ?? "";
    return /^[a-z0-9-]+$/i.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

function findLinkedPlayerSlug(node: TeamHtmlNode): string | null {
  if (node.tag === "a") {
    const slug = playerSlugFromSourceUrl(node.attrs.href ?? "");
    if (slug) return slug;
  }
  for (const child of node.children) {
    if (typeof child !== "string") {
      const slug = findLinkedPlayerSlug(child);
      if (slug) return slug;
    }
  }
  return null;
}

function findLinkedCoachSlug(node: TeamHtmlNode): string | null {
  if (node.tag === "a") {
    const slug = coachSlugFromSourceUrl(node.attrs.href ?? "");
    if (slug) return slug;
  }
  for (const child of node.children) {
    if (typeof child !== "string") {
      const slug = findLinkedCoachSlug(child);
      if (slug) return slug;
    }
  }
  return null;
}

function parseTeamTableBlock(
  node: TeamHtmlNode,
  playerSlug: string | null,
  coachSlug: string | null,
  activeContentTab: string | null,
): TeamContentBlock | null {
  const rows: string[][] = [];
  const cellImages: NonNullable<TeamContentBlock["cellImages"]> = [];
  const playerSlugs: Array<Array<string | null>> = [];
  const coachSlugs: Array<Array<string | null>> = [];
  const rowTypes: NonNullable<TeamContentBlock["rowTypes"]> = [];
  type TableHeaderEntry = {
    sourceIndex: number;
    label: string;
    contentTab?: string;
  };
  const headerState: { entries: TableHeaderEntry[] | null } = { entries: null };
  let firstDataCells: TeamHtmlNode[] | null = null;
  let imageColumnTargets = new Map<number, number>();
  const hasActiveColumnTab = (current: TeamHtmlNode): boolean =>
    current.attrs["data-content-tab"] === activeContentTab ||
    current.children.some(
      (child) => typeof child !== "string" && hasActiveColumnTab(child),
    );
  const tableActiveContentTab =
    activeContentTab && hasActiveColumnTab(node) ? activeContentTab : null;
  const selectedCell = (cell: TeamHtmlNode) => {
    const contentTab = cell.attrs["data-content-tab"];
    return !tableActiveContentTab || !contentTab || contentTab === tableActiveContentTab;
  };
  const captureHeader = (
    cells: TeamHtmlNode[],
    hasGroupHeading: boolean,
  ) => {
    const entries: Array<{
      sourceIndex: number;
      label: string;
      contentTab?: string;
    }> = [];
    let sourceIndex = 0;
    for (const cell of cells) {
      const contentTab = cell.attrs["data-content-tab"];
      if (hasGroupHeading && teamNodeHasClass(cell, "main")) {
        const span = Math.max(
          1,
          Number.parseInt(cell.attrs.colspan ?? "1", 10) || 1,
        );
        for (let offset = 0; offset < span; offset += 1) {
          entries.push({
            sourceIndex,
            label: offset === 0 ? "#" : offset === span - 1 ? "Player" : "",
            ...(contentTab ? { contentTab } : {}),
          });
          sourceIndex += 1;
        }
      } else {
        entries.push({
          sourceIndex,
          label: teamTableHeaderText(cell),
          ...(contentTab ? { contentTab } : {}),
        });
        sourceIndex += 1;
      }
    }
    return entries;
  };
  const findImageColumnTargets = (cells: TeamHtmlNode[]) => {
    const targets = new Map<number, number>();
    cells.forEach((cell, imageIndex) => {
      const isPortrait = teamNodeHasClass(cell, "player-img");
      const isClubBadge =
        teamNodeHasClass(cell, "td-shield") ||
        teamNodeHasClass(cell, "team-img");
      if (!isPortrait && !isClubBadge) return;
      const targetIndex = cells.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > imageIndex &&
          (teamNodeHasClass(candidate, "name") ||
            teamNodeHasClass(candidate, "player-name")),
      );
      if (targetIndex >= 0) targets.set(imageIndex, targetIndex);
    });
    return targets;
  };
  const visitRows = (current: TeamHtmlNode) => {
    for (const child of current.children) {
      if (typeof child === "string" || teamNodeHidden(child)) continue;
      if (child.tag !== "tr") {
        visitRows(child);
        continue;
      }

      const cellNodes = child.children.filter(
        (cell): cell is TeamHtmlNode =>
          typeof cell !== "string" && ["th", "td"].includes(cell.tag),
      );
      const isHeader = cellNodes.some((cell) => cell.tag === "th");
      const groupCell = cellNodes.find(
        (cell) => cell.tag === "th" && teamNodeHasClass(cell, "main"),
      );
      if (isHeader) {
        if (!headerState.entries) {
          headerState.entries = captureHeader(cellNodes, Boolean(groupCell));
        }
        if (groupCell) {
          const groupName = teamTableCellText(groupCell);
          if (groupName) {
            rows.push([groupName]);
            cellImages.push([[]]);
            playerSlugs.push([null]);
            coachSlugs.push([null]);
            rowTypes.push("section");
          }
        }
        continue;
      }

      if (!firstDataCells) {
        firstDataCells = cellNodes;
        imageColumnTargets = findImageColumnTargets(cellNodes);
      }
      const visibleCells = cellNodes.filter(selectedCell);
      if (!visibleCells.some((cell) => teamTableCellText(cell) || contentImagesWithin(cell).length)) {
        continue;
      }

      const deferredImages = new Map<number, TeamContentImage[]>();
      for (const [imageIndex, targetIndex] of imageColumnTargets) {
        const imageCell = cellNodes[imageIndex];
        const targetCell = cellNodes[targetIndex];
        if (!imageCell || !targetCell || !selectedCell(imageCell) || !selectedCell(targetCell)) {
          continue;
        }
        deferredImages.set(targetIndex, contentImagesWithin(imageCell));
      }

      const outputCells: string[] = [];
      const outputImages: TeamContentImage[][] = [];
      const outputPlayerSlugs: Array<string | null> = [];
      const outputCoachSlugs: Array<string | null> = [];
      cellNodes.forEach((cell, sourceIndex) => {
        if (!selectedCell(cell) || imageColumnTargets.has(sourceIndex)) return;
        outputCells.push(teamTableCellText(cell));
        outputImages.push([
          ...(deferredImages.get(sourceIndex) ?? []),
          ...contentImagesWithin(cell),
        ]);
        outputPlayerSlugs.push(findLinkedPlayerSlug(cell) ?? playerSlug);
        outputCoachSlugs.push(findLinkedCoachSlug(cell) ?? coachSlug);
      });
      rows.push(outputCells);
      cellImages.push(outputImages);
      playerSlugs.push(outputPlayerSlugs);
      coachSlugs.push(outputCoachSlugs);
      rowTypes.push("data");
    }
  };
  visitRows(node);
  const headerEntries = headerState.entries ?? [];
  if (!headerEntries.length && rows.length === 0) return null;

  const headerCells = (headerEntries ?? [])
    .filter((entry) => !tableActiveContentTab || !entry.contentTab || entry.contentTab === tableActiveContentTab)
    .filter((entry) => !imageColumnTargets.has(entry.sourceIndex));
  const headers = headerCells.map((entry) => {
    const cell = firstDataCells?.[entry.sourceIndex];
    if (cell && teamNodeHasClass(cell, "number-box")) return "#";
    if (cell && teamNodeHasClass(cell, "name")) {
      return findLinkedPlayerSlug(cell) ? "Player" : "Team";
    }
    if (!entry.label && cell) {
      const hasFlag = contentImagesWithin(cell).some((image) => /\/flags\//i.test(image.url));
      if (hasFlag) return "Country";
    }
    return entry.label;
  });
  const normalizedHeaders = headers.map((header, columnIndex) => {
    if (header) return header;
    const containsFlag = cellImages.some((row) =>
      row[columnIndex]?.some((image) => /\/flags\//i.test(image.url)),
    );
    return containsFlag ? "Country" : "";
  });
  const hasPlayerLinks = playerSlugs.some((row) => row.some(Boolean));
  const hasCoachLinks = coachSlugs.some((row) => row.some(Boolean));
  return {
    type: "table",
    headers: normalizedHeaders,
    rows,
    cellImages,
    rowTypes,
    ...(hasPlayerLinks ? { playerSlugs } : {}),
    ...(hasCoachLinks ? { coachSlugs } : {}),
  };
}

function collectTeamBlocks(
  node: TeamHtmlNode,
  blocks: TeamContentBlock[],
  excludedHeading = "",
  playerSlug: string | null = null,
  coachSlug: string | null = null,
  inactiveTabPanels: Set<string> = new Set(),
  activeContentTab: string | null = null,
): void {
  if (
    (node.attrs.id && inactiveTabPanels.has(node.attrs.id)) ||
    teamNodeHidden(node) ||
    teamNodeIsControl(node) ||
    ["script", "style", "svg", "iframe", "noscript"].includes(node.tag)
  ) {
    return;
  }

  if (node.tag === "img") {
    const image = contentImageFromNode(node);
    if (image) {
      blocks.push({
        type: "image",
        imageUrl: image.url,
        imageAlt: image.alt,
        ...(playerSlug ? { playerSlug } : {}),
        ...(coachSlug ? { coachSlug } : {}),
      });
    }
    return;
  }

  if (node.tag === "a") {
    const linkedPlayer = playerSlugFromSourceUrl(node.attrs.href ?? "") ?? playerSlug;
    const linkedCoach = coachSlugFromSourceUrl(node.attrs.href ?? "") ?? coachSlug;
    const text = cleanHtmlText(teamNodeVisibleText(node));
    const images = contentImagesWithin(node);
    if (text && !isPageChrome(text)) {
      blocks.push({
        type: "text",
        text,
        ...(images.length ? { images } : {}),
        ...(linkedPlayer ? { playerSlug: linkedPlayer } : {}),
        ...(linkedCoach ? { coachSlug: linkedCoach } : {}),
      });
    } else {
      for (const image of images) {
        blocks.push({
          type: "image",
          imageUrl: image.url,
          imageAlt: image.alt,
          ...(linkedPlayer ? { playerSlug: linkedPlayer } : {}),
          ...(linkedCoach ? { coachSlug: linkedCoach } : {}),
        });
      }
    }
    return;
  }

  if (node.tag === "table") {
    const tableBlock = parseTeamTableBlock(
      node,
      playerSlug,
      coachSlug,
      activeContentTab,
    );
    if (tableBlock) blocks.push(tableBlock);
    return;
  }

  const semanticText =
    /^h[1-6]$/.test(node.tag) ||
    ["p", "li", "th", "td"].includes(node.tag) ||
    ["panel-title", "table-head", "team-name", "player-name"].some((name) =>
      teamNodeHasClass(node, name),
    );
  if (semanticText) {
    const text = teamNodeText(node);
    const linkedPlayerSlug = playerSlug ?? findLinkedPlayerSlug(node);
    const linkedCoachSlug = coachSlug ?? findLinkedCoachSlug(node);
    if (text && text !== excludedHeading && !isPageChrome(text)) {
      const images = contentImagesWithin(node);
      blocks.push({
        type: "text",
        text,
        ...(images.length ? { images } : {}),
        ...(linkedPlayerSlug ? { playerSlug: linkedPlayerSlug } : {}),
        ...(linkedCoachSlug ? { coachSlug: linkedCoachSlug } : {}),
      });
    }
    return;
  }

  for (const child of node.children) {
    if (typeof child === "string") {
      const text = cleanHtmlText(child);
      if (text && !isPageChrome(text)) {
        blocks.push({
          type: "text",
          text,
          ...(playerSlug ? { playerSlug } : {}),
          ...(coachSlug ? { coachSlug } : {}),
        });
      }
    } else {
      collectTeamBlocks(
        child,
        blocks,
        excludedHeading,
        playerSlug,
        coachSlug,
        inactiveTabPanels,
        activeContentTab,
      );
    }
  }
}

function normalizeImageMatchText(value: string): string {
  return collapseRepeatedSourceText(value)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function associateImageBlocksWithText(
  blocks: TeamContentBlock[],
): TeamContentBlock[] {
  const result = blocks.map((block) => ({
    ...block,
    ...(block.images ? { images: [...block.images] } : {}),
  }));
  const removedImageBlocks = new Set<number>();

  result.forEach((block, imageIndex) => {
    if (block.type !== "image" || !block.imageUrl || !block.imageAlt?.trim()) {
      return;
    }
    const normalizedAlt = normalizeImageMatchText(block.imageAlt);
    if (normalizedAlt.length < 3) return;

    let targetIndex = -1;
    let targetDistance = Number.POSITIVE_INFINITY;
    result.forEach((candidate, candidateIndex) => {
      if (candidate.type !== "text" || !candidate.text) return;
      const normalizedText = normalizeImageMatchText(candidate.text);
      if (!normalizedText.includes(normalizedAlt)) return;
      const distance = Math.abs(candidateIndex - imageIndex);
      if (distance < targetDistance) {
        targetIndex = candidateIndex;
        targetDistance = distance;
      }
    });

    if (targetIndex < 0) return;
    const target = result[targetIndex];
    if (target.type !== "text") return;
    const images = target.images ?? [];
    if (!images.some((image) => image.url === block.imageUrl)) {
      images.push({ url: block.imageUrl, alt: block.imageAlt });
    }
    target.images = images;
    if (!target.playerSlug && block.playerSlug) {
      target.playerSlug = block.playerSlug;
    }
    if (!target.coachSlug && block.coachSlug) {
      target.coachSlug = block.coachSlug;
    }
    removedImageBlocks.add(imageIndex);
  });

  return result.filter((_, index) => !removedImageBlocks.has(index));
}

function parseHtmlModuleSections(
  html: string,
  moduleTitles: Record<string, string>,
  ignoredModules: Set<string>,
  includeModuleId?: (id: string) => boolean,
): TeamContentPage["sections"] {
  const tree = parseTeamHtml(html);
  const modules: TeamHtmlNode[] = [];
  const findModules = (node: TeamHtmlNode) => {
    if (
      node.tag === "div" &&
      node.attrs.id?.startsWith("mod_") &&
      !ignoredModules.has(node.attrs.id) &&
      (!includeModuleId || includeModuleId(node.attrs.id))
    ) {
      modules.push(node);
      return;
    }
    for (const child of node.children) {
      if (typeof child !== "string") findModules(child);
    }
  };
  findModules(tree);

  return modules
    .map((module) => {
      const id = module.attrs.id ?? "";
      const heading = (() => {
        const findHeading = (node: TeamHtmlNode): string | null => {
          if (
            /^h[1-4]$/.test(node.tag) ||
            teamNodeHasClass(node, "panel-title") ||
            teamNodeHasClass(node, "table-head")
          ) {
            const text = teamNodeText(node);
            if (text && !isPageChrome(text)) return text;
          }
          for (const child of node.children) {
            if (typeof child !== "string") {
              const result = findHeading(child);
              if (result) return result;
            }
          }
          return null;
        };
        return findHeading(module);
      })();
      const title = moduleTitles[id] ?? heading ?? id.replace(/^mod_/, "");
      const blocks: TeamContentBlock[] = [];
      const tabContext = teamTabPanelContext(module);
      collectTeamBlocks(
        module,
        blocks,
        heading ?? "",
        null,
        null,
        tabContext.inactivePanelIds,
        tabContext.activeContentTab,
      );
      const associatedBlocks = associateImageBlocksWithText(blocks);
      const seenImageTextBlocks = new Set<string>();
      const compactBlocks = associatedBlocks.filter((block, index) => {
        if (block.type !== "text") return true;
        const text = block.text?.trim() ?? "";
        if (!text || text.length < 2) return false;
        if (block.images?.length) {
          const key = [
            text.toLocaleLowerCase(),
            block.playerSlug ?? "",
            block.coachSlug ?? "",
            block.images.map((image) => image.url).sort().join(","),
          ].join("|");
          if (seenImageTextBlocks.has(key)) return false;
          seenImageTextBlocks.add(key);
        }
        const previous = associatedBlocks[index - 1];
        if (previous?.type === "text" && previous.text === text) return false;
        return true;
      });
      const text = compactBlocks
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text as string);
      const tables = compactBlocks
        .filter((block) => block.type === "table")
        .map((block) => ({
          headers: block.headers ?? [],
          rows: block.rows ?? [],
        }));
      return { title, text, tables, blocks: compactBlocks };
    })
    .filter((section) => section.blocks?.length);
}

function parseTeamHtmlSections(html: string): TeamContentPage["sections"] {
  return parseHtmlModuleSections(html, teamModuleTitles, ignoredTeamModules);
}

function parseMatchHtmlSections(html: string): MatchDetails["sourcePages"][number]["sections"] {
  return parseHtmlModuleSections(
    html,
    matchModuleTitles,
    ignoredMatchModules,
    (id) => id.startsWith("mod_match_"),
  );
}

const playerPageSources: Array<{
  tab: PlayerContentPageTab;
  suffix: string;
}> = [
  { tab: "info", suffix: "" },
  { tab: "matches", suffix: "matches" },
  { tab: "career", suffix: "career-path" },
  { tab: "achievements", suffix: "palmares" },
  { tab: "milestones", suffix: "achievements" },
  { tab: "attributes", suffix: "attributes" },
  { tab: "transfers", suffix: "transfers" },
  { tab: "teammates", suffix: "team-mates" },
];

function playerProfilePath(slug: string, suffix: string): string {
  return suffix ? `/player/${suffix}/${slug}` : `/player/${slug}`;
}

function parsePlayerProfile(html: string, slug: string): PlayerProfile {
  const tree = parseTeamHtml(html);
  const nodes: TeamHtmlNode[] = [];
  const collectNodes = (node: TeamHtmlNode) => {
    nodes.push(node);
    for (const child of node.children) {
      if (typeof child !== "string") collectNodes(child);
    }
  };
  collectNodes(tree);

  let person: Record<string, unknown> = {};
  const personJson = html.match(
    /<script\b(?=[^>]*type=["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/i,
  )?.[1];
  if (personJson) {
    try {
      const parsed = asRecord(JSON.parse(personJson));
      if (parsed) person = parsed;
    } catch {
      person = {};
    }
  }

  const header = nodes.find((node) => teamNodeHasClass(node, "player-head")) ?? tree;
  const headerNodes: TeamHtmlNode[] = [];
  const collectHeaderNodes = (node: TeamHtmlNode) => {
    headerNodes.push(node);
    for (const child of node.children) {
      if (typeof child !== "string") collectHeaderNodes(child);
    }
  };
  collectHeaderNodes(header);

  const photoNode = headerNodes.find(
    (node) => node.tag === "img" && /\/img_data\/players\//i.test(node.attrs.src ?? ""),
  );
  const headerTitle = headerNodes.find((node) => teamNodeHasClass(node, "title"));
  const candidateNames = [
    headerTitle ? teamNodeText(headerTitle) : null,
    photoNode?.attrs.alt,
    textValue(person.name),
  ];
  const name =
    candidateNames
      .map((candidate) => candidate?.trim())
      .find(
        (candidate): candidate is string =>
          typeof candidate === "string" &&
          candidate.length > 0 &&
          candidate.length < 80 &&
          !/^(?:be)?soccer(?:\s|$)/i.test(candidate),
      ) ?? slug;
  const flagNode = headerNodes.find(
    (node) =>
      node.tag === "img" &&
      (teamNodeHasClass(node, "flag") || /\/flags\/round\//i.test(node.attrs.src ?? "")),
  );
  const teamInfo = headerNodes.find((node) => teamNodeHasClass(node, "team-info"));
  const teamInfoNodes: TeamHtmlNode[] = [];
  if (teamInfo) {
    const collectTeamInfo = (node: TeamHtmlNode) => {
      teamInfoNodes.push(node);
      for (const child of node.children) {
        if (typeof child !== "string") collectTeamInfo(child);
      }
    };
    collectTeamInfo(teamInfo);
  }
  const teamAnchor = teamInfoNodes.find(
    (node) => node.tag === "a" && /\/team\/[a-z0-9-]+/i.test(node.attrs.href ?? ""),
  );
  const teamBadgeNode = teamInfoNodes.find(
    (node) =>
      node.tag === "img" && /\/img_data\/equipos\//i.test(node.attrs.src ?? ""),
  );
  const currentTeam =
    textValue(asRecord(person.memberOf)?.name) ??
    teamNodeText(teamInfo ?? { tag: "div", attrs: {}, children: [] })
      .replace(/\b(Ligue 1|Premier League|LaLiga|Serie A|Bundesliga|Ligue 2)\b.*$/i, "")
      .trim() ??
    null;
  const dataBoxes = headerNodes.filter((node) => teamNodeHasClass(node, "data-box"));
  const nodeWithin = (root: TeamHtmlNode, predicate: (node: TeamHtmlNode) => boolean) => {
    const matches: TeamHtmlNode[] = [];
    const visit = (node: TeamHtmlNode) => {
      if (predicate(node)) matches.push(node);
      for (const child of node.children) {
        if (typeof child !== "string") visit(child);
      }
    };
    visit(root);
    return matches;
  };
  const ageBox = dataBoxes.find((box) =>
    nodeWithin(box, (node) => teamNodeHasClass(node, "info")).some(
      (node) => /years?/i.test(teamNodeText(node)),
    ),
  );
  const ageValue = ageBox
    ? nodeWithin(ageBox, (node) => teamNodeHasClass(node, "number"))
        .map((node) => Number.parseInt(teamNodeText(node), 10))
        .find(Number.isFinite)
    : undefined;
  const marketBox = dataBoxes.find((box) => /(?:M\.€|[€£$])/i.test(teamNodeText(box)));
  const marketNumber = marketBox
    ? nodeWithin(marketBox, (node) => teamNodeHasClass(node, "number"))[0]
    : undefined;
  const marketUnit = marketBox
    ? nodeWithin(marketBox, (node) => teamNodeHasClass(node, "info"))[0]
    : undefined;
  const shirtNode = headerNodes.find(
    (node) => node.attrs.class?.split(/\s+/).some((className) => className === "black"),
  );
  const positionNode = headerNodes.find(
    (node) =>
      teamNodeHasClass(node, "bg-role") &&
      !node.attrs.class?.split(/\s+/).includes("black"),
  );
  const ratingNode = headerNodes.find(
    (node) => teamNodeHasClass(node, "elo") && /^\d+$/.test(teamNodeText(node)),
  );
  const birthDate = textValue(person.birthDate);
  const parsedBirthDate = birthDate ? new Date(birthDate) : null;
  const validBirthDate =
    parsedBirthDate && !Number.isNaN(parsedBirthDate.getTime())
      ? parsedBirthDate
      : null;
  const ageFromBirthDate = birthDate
    ? (() => {
        const [year, month, day] = birthDate.split("-").map(Number);
        if (!year || !month || !day) return null;
        const now = new Date();
        return now.getUTCFullYear() - year -
          (now.getUTCMonth() + 1 < month ||
          (now.getUTCMonth() + 1 === month && now.getUTCDate() < day)
            ? 1
            : 0);
      })()
    : null;

  return {
    slug,
    name,
    photoUrl:
      imageUrlFromNode(photoNode ?? { tag: "img", attrs: {}, children: [] }) ??
      imageUrlFromNode({
        tag: "img",
        attrs: { src: textValue(person.image) ?? "" },
        children: [],
      }),
    nationality: textValue(asRecord(person.nationality)?.name),
    nationalityFlagUrl: imageUrlFromNode(flagNode ?? { tag: "img", attrs: {}, children: [] }),
    birthDate: validBirthDate?.toISOString() ?? null,
    age: ageValue ?? ageFromBirthDate,
    heightCm: parseNumber(textValue(asRecord(person.height)?.value) ?? undefined),
    weightKg: parseNumber(textValue(asRecord(person.weight)?.value) ?? undefined),
    currentTeam,
    teamSlug: teamAnchor
      ? teamAnchor.attrs.href?.match(/\/team\/([a-z0-9-]+)/i)?.[1] ?? null
      : null,
    teamBadgeUrl: imageUrlFromNode(teamBadgeNode ?? { tag: "img", attrs: {}, children: [] }),
    position:
      teamNodeText(positionNode ?? { tag: "div", attrs: {}, children: [] }) ||
      textValue(person.jobTitle),
    shirtNumber: shirtNode ? parseNumber(teamNodeText(shirtNode)) : null,
    rating: ratingNode ? parseNumber(teamNodeText(ratingNode)) : null,
    marketValue: marketNumber
      ? `${teamNodeText(marketNumber)} ${teamNodeText(
          marketUnit ?? { tag: "div", attrs: {}, children: [] },
        )}`.trim()
      : null,
    sourceUrl: `${besoccerOrigin}${playerProfilePath(slug, "")}`,
  };
}

export async function getPlayerDetails(
  playerSlug: string,
  selectedTab: PlayerContentPageTab = "info",
): Promise<PlayerDetails> {
  const cacheKey = `player:${playerSlug}:${selectedTab}`;
  const cached = fromCache<PlayerDetails>(cacheKey);
  if (cached) return cached;

  const infoHtml = await getRawHtml(playerProfilePath(playerSlug, ""));
  const source = playerPageSources.find((page) => page.tab === selectedTab);
  if (!source) throw new Error("Player section is not available");
  const pageHtml =
    selectedTab === "info"
      ? infoHtml
      : await getRawHtml(playerProfilePath(playerSlug, source.suffix));
  const pages: PlayerContentPage[] = [
    {
      tab: source.tab,
      sourceUrl: `${besoccerOrigin}${playerProfilePath(playerSlug, source.suffix)}`,
      sections: parseHtmlModuleSections(
        pageHtml,
        playerModuleTitles,
        ignoredPlayerModules,
      ),
    },
  ];
  const result = { player: parsePlayerProfile(infoHtml, playerSlug), pages };
  saveCache(cacheKey, result, 90_000);
  return result;
}

export async function getTeamDetails(
  teamSlug: string,
  selectedTab: TeamContentPageTab | "in-depth" = "info",
): Promise<TeamDetails> {
  const cacheKey = `team:${teamSlug}:${selectedTab}`;
  const cached = fromCache<TeamDetails>(cacheKey);
  if (cached) return cached;

  const infoHtml = await getRawHtml(teamProfilePath(teamSlug, ""));
  const team = parseTeamProfile(infoHtml, teamSlug);
  const source = teamPageSources.find((page) =>
    selectedTab === "in-depth" ? page.tab === "matches" : page.tab === selectedTab,
  );
  if (!source) throw new Error("Team section is not available");
  const pageHtml =
    selectedTab === "info"
      ? infoHtml
      : await getRawHtml(teamProfilePath(teamSlug, source.suffix));
  const page: TeamContentPage = {
    tab: source.tab,
    sourceUrl: `${besoccerOrigin}${teamProfilePath(teamSlug, source.suffix)}`,
    sections: parseTeamSections(pageHtml, teamSlug, source.tab),
  };
  if (selectedTab !== "in-depth") {
    const result: TeamDetails = {
      team,
      pages: [page],
      recentMatches: [],
      nextMatch: null,
      eloAnalysisMatch: null,
      eloAnalysisStats: [],
    };
    saveCache(cacheKey, result, 90_000);
    return result;
  }

  const dossierSources = teamPageSources.filter(
    (candidate) => candidate.tab === "squad" || candidate.tab === "standings",
  );
  const dossierPages = await Promise.all(
    dossierSources.map(async (candidate): Promise<TeamContentPage> => {
      const html = await getRawHtml(
        teamProfilePath(teamSlug, candidate.suffix),
      );
      return {
        tab: candidate.tab,
        sourceUrl: `${besoccerOrigin}${teamProfilePath(teamSlug, candidate.suffix)}`,
        sections: parseTeamSections(html, teamSlug, candidate.tab),
      };
    }),
  );
  const infoPage: TeamContentPage = {
    tab: "info",
    sourceUrl: `${besoccerOrigin}${teamProfilePath(teamSlug, "")}`,
    sections: parseTeamSections(infoHtml, teamSlug, "info"),
  };

  const today = new Date().toISOString().slice(0, 10);
  const matchFixtures = parseFixtureCards(pageHtml, today);
  const uniqueMatchFixtures = Array.from(
    new Map(matchFixtures.map((fixture) => [fixture.id, fixture])).values(),
  );
  const recentMatches = uniqueMatchFixtures
    .filter(
      (fixture) =>
        fixture.status === "Finished" &&
        fixture.homeScore !== null &&
        fixture.awayScore !== null &&
        fixture.kickoff.slice(0, 10) <= today,
    )
    .sort((left, right) => right.kickoff.localeCompare(left.kickoff))
    .slice(0, 10);
  const nextMatch = uniqueMatchFixtures
    .filter(
      (fixture) =>
        fixture.status === "Scheduled" &&
        fixture.homeScore === null &&
        fixture.awayScore === null &&
        fixture.kickoff.slice(0, 10) >= today,
    )
    .sort((left, right) => left.kickoff.localeCompare(right.kickoff))[0] ?? null;
  const eloCandidates = [recentMatches[0], nextMatch].filter(
    (fixture): fixture is Fixture => fixture !== undefined && fixture !== null,
  );
  const eloResults = await Promise.allSettled(
    eloCandidates.map(async (fixture) => {
      const matchPath = new URL(fixture.sourceUrl).pathname;
      const analysis = await getMarkdown(`${matchPath}/analysis`);
      return { fixture, stats: parseAnalysis(analysis) };
    }),
  );
  const eloResult = eloResults.find(
    (result) =>
      result.status === "fulfilled" &&
      result.value.stats.some((stat) =>
        ["ELO", "Tilt", "General ELO ranking", "Country ELO ranking"].includes(
          stat.label,
        ),
      ),
  );
  const eloAnalysisMatch =
    eloResult?.status === "fulfilled" ? eloResult.value.fixture : null;
  const eloAnalysisStats =
    eloResult?.status === "fulfilled" ? eloResult.value.stats : [];
  const result = {
    team,
    pages: [infoPage, ...dossierPages, page],
    recentMatches,
    nextMatch,
    eloAnalysisMatch,
    eloAnalysisStats,
  };
  saveCache(cacheKey, result, 90_000);
  return result;
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date;
}
