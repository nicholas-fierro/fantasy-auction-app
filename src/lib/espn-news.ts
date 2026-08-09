export interface PlayerNewsItem {
  headline: string;
  description: string | null;
  publishedAt: string | null;
  premium: boolean;
  url: string | null;
  scope: 'player' | 'team';
}

interface EspnNewsLink {
  href?: string;
}

interface EspnNewsLinks {
  web?: EspnNewsLink;
}

interface EspnNewsArticle {
  headline?: string;
  description?: string;
  published?: string;
  lastModified?: string;
  premium?: boolean;
  links?: EspnNewsLinks;
}

interface EspnAthleteNewsResponse {
  news?: EspnNewsArticle[];
}

interface EspnTeamNewsResponse {
  articles?: EspnNewsArticle[];
}

export const ESPN_TEAM_IDS: Record<string, number> = {
  ATL: 1,
  BUF: 2,
  CHI: 3,
  CIN: 4,
  CLE: 5,
  DAL: 6,
  DEN: 7,
  DET: 8,
  GB: 9,
  TEN: 10,
  IND: 11,
  KC: 12,
  LV: 13,
  LAR: 14,
  LA: 14,
  MIA: 15,
  MIN: 16,
  NE: 17,
  NO: 18,
  NYG: 19,
  NYJ: 20,
  PHI: 21,
  ARI: 22,
  PIT: 23,
  LAC: 24,
  SF: 25,
  SEA: 26,
  TB: 27,
  WSH: 28,
  WAS: 28,
  CAR: 29,
  JAX: 30,
  JAC: 30,
  BAL: 33,
  HOU: 34,
};

export function getEspnTeamId(team: string | null | undefined): number | null {
  if (!team) return null;
  return ESPN_TEAM_IDS[team.toUpperCase()] ?? null;
}

function normalizeArticles(
  articles: EspnNewsArticle[] | undefined,
  scope: PlayerNewsItem['scope']
): PlayerNewsItem[] {
  return (articles ?? [])
    .filter((article): article is EspnNewsArticle & { headline: string } =>
      typeof article.headline === 'string' && article.headline.trim().length > 0
    )
    .map(article => ({
      headline: article.headline,
      description: article.description ?? null,
      publishedAt: article.published ?? article.lastModified ?? null,
      premium: article.premium ?? false,
      url: article.links?.web?.href ?? null,
      scope,
    }))
    .sort((a, b) => {
      if (a.publishedAt == null) return b.publishedAt == null ? 0 : 1;
      if (b.publishedAt == null) return -1;
      return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    })
    .slice(0, 10);
}

export async function fetchAthleteNews(espnId: string): Promise<PlayerNewsItem[]> {
  const response = await fetch(
    `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${encodeURIComponent(espnId)}/overview`
  );
  if (!response.ok) throw new Error(`ESPN athlete news request failed (${response.status})`);

  const data = await response.json() as EspnAthleteNewsResponse;
  return normalizeArticles(data.news, 'player');
}

export async function fetchTeamNews(
  teamId: number,
  limit = 10
): Promise<PlayerNewsItem[]> {
  const params = new URLSearchParams({ team: String(teamId), limit: String(limit) });
  const response = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?${params}`
  );
  if (!response.ok) throw new Error(`ESPN team news request failed (${response.status})`);

  const data = await response.json() as EspnTeamNewsResponse;
  return normalizeArticles(data.articles, 'team');
}
