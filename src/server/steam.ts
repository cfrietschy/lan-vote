import { z } from "zod";
import type { SteamGameDetails } from "../shared/types.js";
import type { GameMetadataCache } from "./metadata-cache.js";

export type SteamSearchResult = {
  appid: number;
  name: string;
  coverUrl: string;
  storeUrl: string;
};

export type SteamTopGame = SteamSearchResult & {
  rank: number;
  peakPlayers: number;
};

type SteamApp = {
  appid: number;
  name: string;
};

type MemoryDetails = {
  details: SteamGameDetails;
  loadedAt: number;
};

const steamAppListSchema = z.object({
  applist: z.object({
    apps: z.array(
      z.object({
        appid: z.coerce.number(),
        name: z.string()
      })
    )
  })
});

const storeAppListSchema = z.object({
  response: z.object({
    apps: z.array(
      z.object({
        appid: z.coerce.number(),
        name: z.string().optional(),
        app_name: z.string().optional()
      })
    ),
    have_more_results: z.boolean().optional(),
    last_appid: z.coerce.number().optional()
  })
});

const topGamesSchema = z.object({
  response: z.object({
    ranks: z.array(
      z.object({
        rank: z.coerce.number(),
        appid: z.coerce.number(),
        peak_in_game: z.coerce.number().optional().default(0),
        item: z
          .object({
            name: z.string().optional(),
            store_url_path: z.string().optional(),
            assets: z
              .object({
                asset_url_format: z.string().optional(),
                header: z.string().optional(),
                main_capsule: z.string().optional(),
                small_capsule: z.string().optional()
              })
              .optional(),
            categories: z
              .object({
                supported_player_categoryids: z.array(z.coerce.number()).optional()
              })
              .optional()
          })
          .optional()
      })
    )
  })
});

export class SteamService {
  private apps: SteamApp[] = [];
  private loadedAt = 0;
  private loading: Promise<SteamApp[]> | null = null;
  private details = new Map<number, MemoryDetails>();
  private topMultiplayerGames: SteamTopGame[] | null = null;
  private topMultiplayerLoading: Promise<SteamTopGame[]> | null = null;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly ttlMs: number,
    private readonly metadataCache: GameMetadataCache
  ) {}

  async search(query: string, limit: number): Promise<SteamSearchResult[]> {
    const normalizedQuery = normalize(query);
    if (normalizedQuery.length < 2) return [];

    const storeResults = await this.searchPublicStore(query, limit);
    if (storeResults.length) return storeResults;

    const apps = await this.getApps();
    return apps
      .map((app) => ({ app, score: scoreApp(app.name, normalizedQuery) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name))
      .slice(0, limit)
      .map(({ app }) => ({
        appid: app.appid,
        name: app.name,
        coverUrl: steamCoverUrl(app.appid),
        storeUrl: steamStoreUrl(app.appid)
      }));
  }

  async getTopMultiplayerGames(limit: number): Promise<SteamTopGame[]> {
    if (this.topMultiplayerGames) return this.topMultiplayerGames.slice(0, limit);
    if (!this.topMultiplayerLoading) this.topMultiplayerLoading = this.fetchTopMultiplayerGames();
    this.topMultiplayerGames = await this.topMultiplayerLoading;
    return this.topMultiplayerGames.slice(0, limit);
  }

  private async searchPublicStore(query: string, limit: number): Promise<SteamSearchResult[]> {
    const url = new URL("https://store.steampowered.com/search/suggest");
    url.searchParams.set("term", query.trim());
    url.searchParams.set("f", "games");
    url.searchParams.set("cc", "DE");
    url.searchParams.set("l", "german");

    try {
      return parseSteamStoreSearchSuggestions(await this.fetchText(url)).slice(0, limit);
    } catch {
      return [];
    }
  }

  async getDetails(appid: number): Promise<SteamGameDetails> {
    const cached = this.details.get(appid);
    if (cached && Date.now() - cached.loadedAt < this.ttlMs) return cached.details;

    const cachedDetails = this.metadataCache.getSteamDetails(appid);
    if (cachedDetails && hasEnrichedSteamDetails(cachedDetails)) {
      this.rememberDetails(cachedDetails);
      return cachedDetails;
    }

    const fallback: SteamGameDetails = {
      appid,
      name: `Steam App ${appid}`,
      coverUrl: steamCoverUrl(appid),
      storeUrl: steamStoreUrl(appid),
      shortDescription: "",
      genres: [],
      categories: [],
      tags: [],
      minPlayers: null,
      maxPlayers: null,
      releaseDate: ""
    };

    const url = new URL("https://store.steampowered.com/api/appdetails");
    url.searchParams.set("appids", String(appid));
    url.searchParams.set("filters", "basic,categories,genres,release_date");
    url.searchParams.set("l", "german");

    let payload: z.infer<typeof appDetailsSchema>;
    try {
      payload = appDetailsSchema.parse(await this.fetchJson(url));
    } catch (error) {
      const staleDetails = this.metadataCache.getSteamDetails(appid, { allowStale: true });
      if (staleDetails) {
        this.rememberDetails(staleDetails);
        return staleDetails;
      }
      throw error;
    }

    const item = payload[String(appid)];
    if (!item?.success || !item.data) {
      this.rememberDetails(fallback);
      this.metadataCache.setSteamDetails(fallback);
      return fallback;
    }

    const genres = item.data.genres?.map((genre) => genre.description).filter(Boolean) || [];
    const categories = item.data.categories?.map((category) => category.description).filter(Boolean) || [];
    const playerRange = inferPlayerRange(item.data.categories || []);
    const details: SteamGameDetails = {
      appid,
      name: item.data.name || fallback.name,
      coverUrl: item.data.header_image || fallback.coverUrl,
      storeUrl: steamStoreUrl(appid),
      shortDescription: item.data.short_description || "",
      genres,
      categories,
      tags: buildSteamTags(genres, categories),
      minPlayers: playerRange.minPlayers,
      maxPlayers: playerRange.maxPlayers,
      releaseDate: item.data.release_date?.date || ""
    };
    this.rememberDetails(details);
    this.metadataCache.setSteamDetails(details);
    return details;
  }

  private rememberDetails(details: SteamGameDetails): void {
    this.details.set(details.appid, { details, loadedAt: Date.now() });
  }

  private async getApps(): Promise<SteamApp[]> {
    const now = Date.now();
    if (this.apps.length > 0 && now - this.loadedAt < this.ttlMs) return this.apps;
    if (this.loading) return this.loading;

    this.loading = this.fetchApps();
    try {
      this.apps = await this.loading;
      this.loadedAt = Date.now();
      return this.apps;
    } finally {
      this.loading = null;
    }
  }

  private async fetchApps(): Promise<SteamApp[]> {
    if (this.apiKey) {
      try {
        return await this.fetchStoreApps();
      } catch {
        return this.fetchPublicApps();
      }
    }
    return this.fetchPublicApps();
  }

  private async fetchStoreApps(): Promise<SteamApp[]> {
    const apps: SteamApp[] = [];
    let lastAppId = 0;

    for (let page = 0; page < 20; page += 1) {
      const url = new URL("https://partner.steam-api.com/IStoreService/GetAppList/v1/");
      url.searchParams.set("key", this.apiKey!);
      url.searchParams.set(
        "input_json",
        JSON.stringify({
          include_games: true,
          include_dlc: false,
          include_software: false,
          include_videos: false,
          include_hardware: false,
          max_results: 50000,
          ...(lastAppId ? { last_appid: lastAppId } : {})
        })
      );

      const payload = storeAppListSchema.parse(await this.fetchJson(url));
      apps.push(
        ...payload.response.apps
          .map((app) => ({ appid: app.appid, name: (app.name || app.app_name || "").trim() }))
          .filter((app) => app.name.length > 0)
      );

      if (!payload.response.have_more_results || !payload.response.last_appid || payload.response.last_appid === lastAppId) {
        break;
      }
      lastAppId = payload.response.last_appid;
    }

    return apps;
  }

  private async fetchPublicApps(): Promise<SteamApp[]> {
    const url = new URL("https://api.steampowered.com/ISteamApps/GetAppList/v2/");
    const payload = steamAppListSchema.parse(await this.fetchJson(url));
    return payload.applist.apps
      .filter((app) => app.name.trim().length > 0)
      .map((app) => ({ appid: app.appid, name: app.name.trim() }));
  }

  private async fetchTopMultiplayerGames(): Promise<SteamTopGame[]> {
    const url = new URL("https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/");
    url.searchParams.set(
      "input_json",
      JSON.stringify({
        context: {
          language: "german",
          country_code: "DE"
        },
        data_request: {
          include_assets: true,
          include_basic_info: true,
          include_tag_count: 5
        }
      })
    );

    const payload = topGamesSchema.parse(await this.fetchJson(url));
    return payload.response.ranks
      .filter((entry) => isMultiplayerTopGame(entry.item?.categories?.supported_player_categoryids || []))
      .map((entry) => {
        const name = entry.item?.name?.trim() || `Steam App ${entry.appid}`;
        return {
          appid: entry.appid,
          name,
          rank: entry.rank,
          peakPlayers: entry.peak_in_game,
          coverUrl: steamAssetUrl(entry.item?.assets, entry.appid),
          storeUrl: entry.item?.store_url_path ? `https://store.steampowered.com/${entry.item.store_url_path}/` : steamStoreUrl(entry.appid)
        };
      });
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "lan-vote/0.1"
      }
    });
    if (!response.ok) {
      throw new SteamApiError(`Steam API Fehler: HTTP ${response.status}`);
    }
    return response.json();
  }

  private async fetchText(url: URL): Promise<string> {
    const response = await fetch(url, {
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "lan-vote/0.1"
      }
    });
    if (!response.ok) {
      throw new SteamApiError(`Steam Store Suche fehlgeschlagen: HTTP ${response.status}`);
    }
    return response.text();
  }
}

export class SteamApiError extends Error {
  readonly status = 502;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("de-DE");
}

function scoreApp(name: string, normalizedQuery: string): number {
  const normalizedName = normalize(name);
  if (normalizedName === normalizedQuery) return 1000;
  if (normalizedName.startsWith(normalizedQuery)) return 800 - Math.min(name.length, 200);
  if (normalizedName.includes(` ${normalizedQuery}`)) return 600 - Math.min(name.length, 200);
  if (normalizedName.includes(normalizedQuery)) return 300 - Math.min(name.length, 200);
  return 0;
}

export function parseSteamStoreSearchSuggestions(html: string): SteamSearchResult[] {
  const results = new Map<number, SteamSearchResult>();
  const itemPattern = /<a\b[^>]*href="([^"]*\/app\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemPattern.exec(html))) {
    const appid = Number(match[2]);
    if (!Number.isInteger(appid) || results.has(appid)) continue;

    const body = match[3] || "";
    const name = decodeHtml(extractFirst(body, /class="[^"]*\bmatch_name\b[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i)).trim();
    if (!name) continue;

    const image = extractFirst(body, /<img\b[^>]*src="([^"]+)"/i).trim();
    results.set(appid, {
      appid,
      name,
      coverUrl: image || steamCoverUrl(appid),
      storeUrl: steamStoreUrl(appid)
    });
  }

  return [...results.values()];
}

function extractFirst(value: string, pattern: RegExp): string {
  return value.match(pattern)?.[1]?.replace(/<[^>]+>/g, "") || "";
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&#(x?[0-9a-f]+);/gi, (_match, code: string) => {
      const value = code.startsWith("x") || code.startsWith("X") ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : "";
    });
}

function isMultiplayerTopGame(categoryIds: number[]): boolean {
  const multiplayerCategoryIds = new Set([1, 9, 20, 27, 36, 37, 38, 39, 44, 47, 48, 49]);
  return categoryIds.some((categoryId) => multiplayerCategoryIds.has(categoryId));
}

function steamAssetUrl(assets: { asset_url_format?: string; header?: string; main_capsule?: string; small_capsule?: string } | undefined, appid: number): string {
  const filename = assets?.header || assets?.main_capsule || assets?.small_capsule;
  if (!assets?.asset_url_format || !filename) return steamCoverUrl(appid);
  const path = assets.asset_url_format.replace("${FILENAME}", filename);
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `https://shared.cloudflare.steamstatic.com/store_item_assets/${path}`;
}

const appDetailsSchema = z.record(
  z.string(),
  z.object({
    success: z.boolean(),
    data: z
      .object({
        name: z.string().optional(),
        header_image: z.string().optional(),
        short_description: z.string().optional(),
        genres: z.array(z.object({ description: z.string() })).optional(),
        categories: z.array(z.object({ id: z.coerce.number(), description: z.string() })).optional(),
        release_date: z.object({ date: z.string().optional() }).optional()
      })
      .optional()
  })
);

function buildSteamTags(genres: string[], categories: string[]): string[] {
  const relevantCategories = categories.filter((category) =>
    /(mehrspieler|multiplayer|koop|co-op|pvp|lan|split|plattformübergreifend|online)/i.test(category)
  );
  return unique([...genres, ...relevantCategories]).slice(0, 8);
}

function inferPlayerRange(categories: Array<{ id: number; description: string }>): { minPlayers: number | null; maxPlayers: number | null } {
  const ids = new Set(categories.map((category) => category.id));
  const hasMultiplayer = [1, 9, 20, 27, 36, 37, 38, 39, 44, 47, 48, 49].some((id) => ids.has(id));
  if (hasMultiplayer) return { minPlayers: 2, maxPlayers: null };
  if (ids.has(2)) return { minPlayers: 1, maxPlayers: 1 };
  return { minPlayers: null, maxPlayers: null };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function hasEnrichedSteamDetails(details: SteamGameDetails): boolean {
  return Boolean(details.releaseDate) && (details.categories.length > 0 || details.tags.length > 0 || details.minPlayers !== null || details.maxPlayers !== null);
}

function steamStoreUrl(appid: number): string {
  return `https://store.steampowered.com/app/${appid}/`;
}

function steamCoverUrl(appid: number): string {
  return `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`;
}
