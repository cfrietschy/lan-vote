import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { GameMetadataCache } from "./metadata-cache.js";

const config: ServerConfig = {
  host: "127.0.0.1",
  port: 8080,
  lanAddress: "127.0.0.1",
  publicBaseUrl: "http://127.0.0.1:8080",
  databasePath: ":memory:",
  steamAppListTtlMs: 86_400_000,
  steamDetailsCacheTtlMs: 31_536_000_000,
  adminUser: "admin",
  adminPassword: "test"
};

let db: Db | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function createCache(): GameMetadataCache {
  db = openDatabase(config);
  return new GameMetadataCache(db, config.steamDetailsCacheTtlMs);
}

describe("GameMetadataCache", () => {
  it("stores and returns Steam details from SQLite", () => {
    const cache = createCache();
    const details = {
      appid: 730,
      name: "Counter-Strike 2",
      coverUrl: "https://example.test/cs2.jpg",
      storeUrl: "https://store.steampowered.com/app/730/",
      shortDescription: "Taktischer Shooter",
      genres: ["Action"],
      categories: ["Mehrspieler"],
      tags: ["Action", "Mehrspieler"],
      minPlayers: 2,
      maxPlayers: null,
      releaseDate: "21. Aug. 2012"
    };

    cache.setSteamDetails(details);

    expect(cache.getSteamDetails(730)).toEqual(details);
  });

  it("hides expired entries unless stale cache is explicitly allowed", () => {
    const cache = createCache();
    const details = {
      appid: 440,
      name: "Team Fortress 2",
      coverUrl: "https://example.test/tf2.jpg",
      storeUrl: "https://store.steampowered.com/app/440/",
      shortDescription: "Klassischer Team-Shooter",
      genres: ["Action"],
      categories: ["Mehrspieler"],
      tags: ["Action", "Mehrspieler"],
      minPlayers: 2,
      maxPlayers: null,
      releaseDate: "10. Okt. 2007"
    };
    cache.setSteamDetails(details);
    db!.prepare("UPDATE game_metadata_cache SET updated_at = ? WHERE source = ? AND external_id = ?").run(
      "2000-01-01T00:00:00.000Z",
      "steam",
      "440"
    );

    expect(cache.getSteamDetails(440)).toBeNull();
    expect(cache.getSteamDetails(440, { allowStale: true })).toEqual(details);
  });
});
