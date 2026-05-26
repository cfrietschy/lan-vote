import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { Store } from "./store.js";

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

function createStore(): Store {
  db = openDatabase(config);
  return new Store(db, config);
}

describe("Store", () => {
  it("creates an active poll and exposes public state", () => {
    const store = createStore();

    const state = store.createPoll("Naechstes Spiel", [{ name: "Counter-Strike 2" }, { name: "Trackmania" }], 15);

    expect(state.activePoll?.title).toBe("Naechstes Spiel");
    expect(state.activePoll?.endsAt).toBeTruthy();
    expect(state.activePoll?.options).toHaveLength(2);
    expect(state.activeResults?.totalVotes).toBe(0);
    expect(state.server.voteUrl).toBe("http://127.0.0.1:8080/vote");
    expect(state.server.qrUrl).toBe("http://127.0.0.1:8080/vote");
  });

  it("updates ranked votes per voter and calculates winners when closing", () => {
    const store = createStore();
    const state = store.createPoll("Finale", [{ name: "A" }, { name: "B" }, { name: "C" }], 0);
    const firstOption = state.activePoll!.options[0]!.id;
    const secondOption = state.activePoll!.options[1]!.id;
    const thirdOption = state.activePoll!.options[2]!.id;

    store.vote("player-1", "Alex", [secondOption, firstOption, thirdOption], true);
    store.vote("player-2", "Bea", [secondOption, thirdOption], false);
    const closed = store.closeActivePoll();

    expect(closed.state.activePoll).toBeNull();
    expect(closed.state.history).toHaveLength(1);
    expect(closed.state.history[0]!.winners).toEqual([{ id: secondOption, name: "B", votes: 6 }]);
    expect(closed.state.history[0]!.totalVotes).toBe(2);
    expect(closed.state.history[0]!.results.find((item) => item.id === secondOption)?.firstPlaceVotes).toBe(2);
    expect(closed.state.history[0]!.results.find((item) => item.id === secondOption)?.readyVotes).toBe(1);
    expect(closed.state.history[0]!.results.find((item) => item.id === secondOption)?.voters).toEqual([
      { name: "Alex", isReady: true, isInstalled: true, rank: 1 },
      { name: "Bea", isReady: false, isInstalled: false, rank: 1 }
    ]);
  });

  it("tracks installed status per ranked game", () => {
    const store = createStore();
    const state = store.createPoll("Installiert?", [{ name: "A" }, { name: "B" }, { name: "C" }], 0);
    const firstOption = state.activePoll!.options[0]!.id;
    const secondOption = state.activePoll!.options[1]!.id;
    const thirdOption = state.activePoll!.options[2]!.id;

    const voted = store.vote("player-1", "Alex", [firstOption, secondOption, thirdOption], false, [firstOption, thirdOption]);
    const results = voted.state.activeResults!;

    expect(voted.state.activePoll!.votes["player-1"]!.installedOptionIds).toEqual([firstOption, thirdOption]);
    expect(results.options.find((item) => item.id === firstOption)?.readyVotes).toBe(1);
    expect(results.options.find((item) => item.id === secondOption)?.readyVotes).toBe(0);
    expect(results.options.find((item) => item.id === thirdOption)?.readyVotes).toBe(1);
  });

  it("starts a tie-breaker poll with the tied leading games", () => {
    const store = createStore();
    const state = store.createPoll("Finale", [{ name: "A" }, { name: "B" }, { name: "C" }], 0);
    const firstOption = state.activePoll!.options[0]!.id;
    const secondOption = state.activePoll!.options[1]!.id;

    store.vote("player-1", "Alex", [firstOption], false);
    store.vote("player-2", "Bea", [secondOption], false);
    const tieBreaker = store.startTieBreaker();

    expect(tieBreaker.activePoll?.title).toBe("Stichwahl: Finale");
    expect(tieBreaker.activePoll?.options.map((option) => option.name)).toEqual(["A", "B"]);
    expect(tieBreaker.history).toHaveLength(1);
  });

  it("deletes individual closed polls from history", () => {
    const store = createStore();

    store.createPoll("Runde 1", [{ name: "A" }, { name: "B" }], 0);
    const firstClosed = store.closeActivePoll().closed!;
    store.createPoll("Runde 2", [{ name: "C" }, { name: "D" }], 0);
    const secondClosed = store.closeActivePoll().closed!;

    expect(store.getPublicState().history.map((item) => item.pollId)).toEqual([secondClosed.pollId, firstClosed.pollId]);

    const state = store.deleteHistoryEntry(firstClosed.pollId);

    expect(state.history.map((item) => item.pollId)).toEqual([secondClosed.pollId]);
    expect(() => store.deleteHistoryEntry(firstClosed.pollId)).toThrow("Abstimmung nicht in der Historie gefunden.");
  });

  it("manages a reusable game pool", () => {
    const store = createStore();

    const game = store.savePoolGame({
      name: "Trackmania",
      note: "Arcade Racing",
      steamAppId: 2225070,
      coverUrl: "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/2225070/header.jpg",
      storeUrl: "https://store.steampowered.com/app/2225070/",
      minPlayers: 2,
      maxPlayers: 16,
      tags: ["Racing", "Kurz"]
    });

    expect(store.listPoolGames()).toEqual([game]);
    store.deletePoolGame(game.id);
    expect(store.listPoolGames()).toEqual([]);
  });

  it("seeds missing LAN classics without overwriting existing pool entries", () => {
    const store = createStore();

    expect(store.seedPoolGames([
      { name: "Warcraft III: The Frozen Throne", note: "RTS", tags: ["Klassiker"], minPlayers: 2, maxPlayers: 12 },
      { name: "Counter-Strike 1.6", steamAppId: 10, tags: ["Shooter"], minPlayers: 2, maxPlayers: 32 }
    ])).toBe(2);

    const warcraft = store.listPoolGames().find((game) => game.name === "Warcraft III: The Frozen Throne")!;
    store.savePoolGame({ ...warcraft, note: "Eigene Notiz" });

    expect(store.seedPoolGames([
      { name: "warcraft iii: the frozen throne", note: "Soll nicht überschreiben", tags: ["RTS"], minPlayers: 2, maxPlayers: 12 },
      { name: "Counter-Strike 1.6", steamAppId: 10, tags: ["Shooter"], minPlayers: 2, maxPlayers: 32 }
    ])).toBe(0);

    const games = store.listPoolGames();
    expect(games).toHaveLength(2);
    expect(games.find((game) => game.id === warcraft.id)?.note).toBe("Eigene Notiz");
  });

  it("manages onboarding settings and templates", () => {
    const store = createStore();

    const onboarding = store.saveOnboardingSettings({
      enabled: true,
      title: "LAN-Infos",
      wlanInfo: "SSID: LAN",
      voiceInfo: "Discord",
      foodInfo: "Pizza um 19:00",
      scheduleInfo: "Warmup, Turnier, Freispiel",
      helpInfo: "Orga fragen",
      sections: [{ id: "rules", title: "Turnierregeln", content: "Best of 3" }],
      categoryOrder: ["rules", "wlan", "voice", "food", "schedule", "help"],
      tvLayout: { left: ["rules", "wlan"], right: ["voice", "food"], hidden: ["schedule", "help"] }
    });
    const state = store.getPublicState();

    expect(onboarding.enabled).toBe(true);
    expect(onboarding.sections).toEqual([{ id: "rules", title: "Turnierregeln", content: "Best of 3" }]);
    expect(onboarding.categoryOrder[0]).toBe("rules");
    expect(onboarding.tvLayout.left).toEqual(["rules", "wlan"]);
    expect(onboarding.tvLayout.hidden).toContain("schedule");
    expect(state.server.qrUrl).toBe("http://127.0.0.1:8080/start");
    expect(state.onboarding.title).toBe("LAN-Infos");
    expect(state.onboarding.sections).toHaveLength(1);

    const template = store.saveTemplate({
      name: "Warmup",
      title: "Warmup-Runde",
      durationMinutes: 10,
      games: [{ name: "Trackmania" }, { name: "Rocket League" }]
    });

    expect(store.listTemplates()).toEqual([template]);
    store.deleteTemplate(template.id);
    expect(store.listTemplates()).toEqual([]);
  });

  it("manages app settings", () => {
    const store = createStore();

    expect(store.getAppSettings()).toEqual({ participantPollsEnabled: false });
    expect(store.saveAppSettings({ participantPollsEnabled: true })).toEqual({ participantPollsEnabled: true });
    expect(store.getPublicState().settings.participantPollsEnabled).toBe(true);
  });
});
