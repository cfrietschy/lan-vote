import { z } from "zod";
import type { SteamGameDetails } from "../shared/types.js";
import type { Db } from "./db.js";

type CacheRow = {
  payload: string;
  updated_at: string;
};

const steamGameDetailsSchema = z.object({
  appid: z.number(),
  name: z.string(),
  coverUrl: z.string(),
  storeUrl: z.string(),
  shortDescription: z.string(),
  genres: z.array(z.string()),
  categories: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  minPlayers: z.number().nullable().optional().default(null),
  maxPlayers: z.number().nullable().optional().default(null),
  releaseDate: z.string()
});

export class GameMetadataCache {
  constructor(
    private readonly db: Db,
    private readonly ttlMs: number
  ) {}

  getSteamDetails(appid: number, options: { allowStale?: boolean } = {}): SteamGameDetails | null {
    const row = this.db
      .prepare("SELECT payload, updated_at FROM game_metadata_cache WHERE source = ? AND external_id = ?")
      .get("steam", String(appid)) as CacheRow | undefined;
    if (!row) return null;
    if (!options.allowStale && !this.isFresh(row.updated_at)) return null;

    try {
      return steamGameDetailsSchema.parse(JSON.parse(row.payload));
    } catch {
      return null;
    }
  }

  setSteamDetails(details: SteamGameDetails): void {
    this.db
      .prepare(
        `INSERT INTO game_metadata_cache (source, external_id, payload, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source, external_id)
         DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .run("steam", String(details.appid), JSON.stringify(details), new Date().toISOString());
  }

  private isFresh(updatedAt: string): boolean {
    return Date.now() - Date.parse(updatedAt) <= this.ttlMs;
  }
}
