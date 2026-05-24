import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSteamStoreSearchSuggestions, SteamService } from "./steam.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Steam store search parser", () => {
  it("extracts app ids, names and covers from Steam Store suggestions", () => {
    const html = `
      <a href="https://store.steampowered.com/app/730/CounterStrike_2/?snr=1_7_15__13">
        <div class="match">
          <img src="https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/730/header.jpg">
          <div class="match_name">Counter-Strike 2</div>
        </div>
      </a>
      <a href="https://store.steampowered.com/app/550/Left_4_Dead_2/">
        <div class="match_name">Left 4 Dead 2 &amp; Friends</div>
      </a>
    `;

    expect(parseSteamStoreSearchSuggestions(html)).toEqual([
      {
        appid: 730,
        name: "Counter-Strike 2",
        coverUrl: "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/730/header.jpg",
        storeUrl: "https://store.steampowered.com/app/730/"
      },
      {
        appid: 550,
        name: "Left 4 Dead 2 & Friends",
        coverUrl: "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/550/header.jpg",
        storeUrl: "https://store.steampowered.com/app/550/"
      }
    ]);
  });
});

describe("Steam top multiplayer games", () => {
  it("loads the Steam chart once and filters non-multiplayer games", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        response: {
          ranks: [
            {
              rank: 1,
              appid: 100,
              peak_in_game: 12345,
              item: {
                name: "Solo Game",
                categories: { supported_player_categoryids: [2] },
                assets: { asset_url_format: "steam/apps/100/${FILENAME}", header: "header.jpg" }
              }
            },
            {
              rank: 2,
              appid: 200,
              peak_in_game: 9876,
              item: {
                name: "LAN Game",
                store_url_path: "app/200/LAN_Game",
                categories: { supported_player_categoryids: [1, 27] },
                assets: { asset_url_format: "steam/apps/200/${FILENAME}?t=1", header: "header.jpg" }
              }
            }
          ]
        }
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new SteamService(undefined, 1000, {} as never);
    await expect(service.getTopMultiplayerGames(20)).resolves.toEqual([
      {
        appid: 200,
        name: "LAN Game",
        rank: 2,
        peakPlayers: 9876,
        coverUrl: "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/200/header.jpg?t=1",
        storeUrl: "https://store.steampowered.com/app/200/LAN_Game/"
      }
    ]);
    await service.getTopMultiplayerGames(20);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Steam app details", () => {
  it("maps genres, multiplayer categories and inferred player counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          730: {
            success: true,
            data: {
              name: "Counter-Strike 2",
              header_image: "https://example.test/header.jpg",
              short_description: "Taktischer Shooter",
              genres: [{ description: "Action" }, { description: "Kostenlos spielbar" }],
              categories: [
                { id: 1, description: "Mehrspieler" },
                { id: 27, description: "Plattformübergreifender Mehrspieler" },
                { id: 29, description: "Steam-Sammelkarten" }
              ],
              release_date: { date: "21. Aug. 2012" }
            }
          }
        })
      }))
    );

    const cache = {
      getSteamDetails: vi.fn(() => null),
      setSteamDetails: vi.fn()
    };
    const service = new SteamService(undefined, 1000, cache as never);

    await expect(service.getDetails(730)).resolves.toMatchObject({
      appid: 730,
      name: "Counter-Strike 2",
      genres: ["Action", "Kostenlos spielbar"],
      categories: ["Mehrspieler", "Plattformübergreifender Mehrspieler", "Steam-Sammelkarten"],
      tags: ["Action", "Kostenlos spielbar", "Mehrspieler", "Plattformübergreifender Mehrspieler"],
      minPlayers: 2,
      maxPlayers: null,
      releaseDate: "21. Aug. 2012"
    });
    expect(cache.setSteamDetails).toHaveBeenCalledTimes(1);
  });
});
