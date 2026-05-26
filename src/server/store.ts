import crypto from "node:crypto";
import type {
  ActivePoll,
  AppSettings,
  GameDraftSnapshot,
  GameOption,
  HistoryEntry,
  OnboardingSection,
  OnboardingSettings,
  PollResults,
  PollTemplate,
  PoolGame,
  PublicState,
  Vote
} from "../shared/types.js";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db.js";

type PollRow = {
  id: string;
  title: string;
  status: "active" | "closed";
  created_at: string;
  ends_at: string | null;
  closed_at: string | null;
};

type OptionRow = {
  id: string;
  poll_id: string;
  name: string;
  note: string;
  steam_appid: number | null;
  cover_url: string;
  store_url: string;
  release_date: string;
  min_players: number | null;
  max_players: number | null;
  tags: string;
  position: number;
};

type VoteRow = {
  poll_id: string;
  voter_id: string;
  voter_name: string;
  option_id: string;
  ranking_json: string;
  installed_option_ids: string;
  is_ready: number;
  updated_at: string;
};

type PoolGameRow = {
  id: string;
  name: string;
  note: string;
  steam_appid: number | null;
  cover_url: string;
  store_url: string;
  release_date: string;
  min_players: number | null;
  max_players: number | null;
  tags: string;
  created_at: string;
};

type TemplateRow = {
  id: string;
  name: string;
  title: string;
  duration_minutes: number;
  games_json: string;
  created_at: string;
  updated_at: string;
};

type OnboardingRow = {
  enabled: number;
  title: string;
  wlan_info: string;
  voice_info: string;
  food_info: string;
  schedule_info: string;
  help_info: string;
  sections_json: string;
  category_order_json: string;
};

type AppSettingsRow = {
  participant_polls_enabled: number;
};

type ResultStats = {
  votes: number;
  firstPlaceVotes: number;
  readyVotes: number;
  voters: Array<{ name: string; isReady: boolean; isInstalled: boolean; rank: number }>;
};

export type GameInput = {
  id?: string;
  name: string;
  note?: string;
  steamAppId?: number | null;
  coverUrl?: string;
  storeUrl?: string;
  releaseDate?: string;
  minPlayers?: number | null;
  maxPlayers?: number | null;
  tags?: string[];
};

export type TemplateInput = {
  id?: string;
  name: string;
  title: string;
  durationMinutes: number;
  games: GameInput[];
};

const rankWeights = [3, 2, 1];

export class Store {
  constructor(
    private readonly db: Db,
    private readonly config: ServerConfig
  ) {}

  getPublicState(): PublicState {
    this.closeExpiredPolls();
    const onboarding = this.getOnboardingSettings();
    const activePoll = this.getActivePoll();
    const onboardingUrl = `${this.config.publicBaseUrl}/start`;
    const voteUrl = `${this.config.publicBaseUrl}/vote`;
    return {
      activePoll,
      activeResults: activePoll ? this.getResults(activePoll.id) : null,
      history: this.getHistory(),
      onboarding,
      settings: this.getAppSettings(),
      server: {
        lanAddress: this.config.lanAddress,
        port: this.config.port,
        publicUrl: this.config.publicBaseUrl,
        monitorUrl: `${this.config.publicBaseUrl}/`,
        onboardingUrl,
        qrUrl: onboarding.enabled ? onboardingUrl : voteUrl,
        voteUrl,
        adminUrl: `${this.config.publicBaseUrl}/admin`,
        tvUrl: `${this.config.publicBaseUrl}/tv`
      }
    };
  }

  createPoll(title: string, games: GameInput[], durationMinutes: number): PublicState {
    const normalizedGames = games.map(normalizeGame).filter((game) => game.name.length > 0);
    if (normalizedGames.length < 2) throw new ApiError(400, "Bitte mindestens zwei Spiele angeben.");

    const tx = this.db.transaction(() => {
      this.closeActivePollInternal();
      const pollId = shortId();
      const createdAt = now();
      const endsAt = durationMinutes > 0 ? new Date(Date.now() + durationMinutes * 60_000).toISOString() : null;
      this.db
        .prepare("INSERT INTO polls (id, title, status, created_at, ends_at) VALUES (?, ?, 'active', ?, ?)")
        .run(pollId, title.trim().slice(0, 80), createdAt, endsAt);

      const insertOption = this.db.prepare(
        `INSERT INTO poll_options
           (id, poll_id, name, note, steam_appid, cover_url, store_url, release_date, min_players, max_players, tags, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      normalizedGames.forEach((game, index) => {
        insertOption.run(
          shortId(),
          pollId,
          game.name,
          game.note,
          game.steamAppId,
          game.coverUrl,
          game.storeUrl,
          game.releaseDate,
          game.minPlayers,
          game.maxPlayers,
          JSON.stringify(game.tags),
          index
        );
      });
    });
    tx();
    return this.getPublicState();
  }

  vote(voterId: string, name: string, rankingsOrChoiceId: string[] | string, isReady: boolean, installedOptionIds: string[] = []): { voterId: string; state: PublicState } {
    this.closeExpiredPolls();
    const activePoll = this.getActivePoll();
    if (!activePoll) throw new ApiError(400, "Aktuell läuft keine Abstimmung.");

    const rankings = normalizeRankings(Array.isArray(rankingsOrChoiceId) ? rankingsOrChoiceId : [rankingsOrChoiceId]);
    if (!rankings.length) throw new ApiError(400, "Bitte mindestens ein Spiel auswählen.");
    const validOptionIds = new Set(activePoll.options.map((option) => option.id));
    if (rankings.some((id) => !validOptionIds.has(id))) throw new ApiError(400, "Ungültige Auswahl.");
    const installed = normalizeOptionIds(installedOptionIds).filter((id) => validOptionIds.has(id));
    const ready = isReady || (rankings.length > 0 && rankings.every((id) => installed.includes(id)));

    const normalizedVoterId = voterId.trim().length >= 8 ? voterId.trim().slice(0, 80) : shortId();
    this.db
      .prepare(
        `INSERT INTO votes (poll_id, voter_id, voter_name, option_id, ranking_json, installed_option_ids, is_ready, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(poll_id, voter_id)
         DO UPDATE SET
           voter_name = excluded.voter_name,
           option_id = excluded.option_id,
           ranking_json = excluded.ranking_json,
           installed_option_ids = excluded.installed_option_ids,
           is_ready = excluded.is_ready,
           updated_at = excluded.updated_at`
      )
      .run(activePoll.id, normalizedVoterId, name.trim().slice(0, 40) || "Spieler", rankings[0], JSON.stringify(rankings), JSON.stringify(installed), ready ? 1 : 0, now());

    return {
      voterId: normalizedVoterId,
      state: this.getPublicState()
    };
  }

  startTieBreaker(durationMinutes = 5): PublicState {
    this.closeExpiredPolls();
    const active = this.getActivePoll();
    if (!active) throw new ApiError(400, "Aktuell läuft keine Abstimmung.");
    const results = this.getResults(active.id);
    const maxVotes = Math.max(0, ...results.options.map((option) => option.votes));
    const tiedGames = results.options
      .filter((option) => maxVotes > 0 && option.votes === maxVotes)
      .sort((a, b) => a.name.localeCompare(b.name, "de-DE"));
    if (tiedGames.length < 2) throw new ApiError(400, "Für eine Stichwahl müssen mindestens zwei führende Spiele gleichauf sein.");
    const title = `Stichwahl: ${active.title}`.slice(0, 80);
    return this.createPoll(title, tiedGames, Math.max(1, Math.min(60, durationMinutes)));
  }

  closeActivePoll(): { closed: HistoryEntry | null; state: PublicState } {
    let closedId: string | null = null;
    const tx = this.db.transaction(() => {
      const active = this.getActivePollRow();
      if (!active) return;
      closedId = active.id;
      this.db.prepare("UPDATE polls SET status = 'closed', closed_at = ? WHERE id = ?").run(now(), active.id);
    });
    tx();
    return {
      closed: closedId ? this.getHistoryEntry(closedId) : null,
      state: this.getPublicState()
    };
  }

  closeExpiredPolls(): boolean {
    const active = this.getActivePollRow();
    if (!active?.ends_at) return false;
    if (Date.parse(active.ends_at) > Date.now()) return false;
    this.db.prepare("UPDATE polls SET status = 'closed', closed_at = ? WHERE id = ?").run(now(), active.id);
    return true;
  }

  clearHistory(): PublicState {
    this.db.prepare("DELETE FROM polls WHERE status = 'closed'").run();
    return this.getPublicState();
  }

  deleteHistoryEntry(pollId: string): PublicState {
    const result = this.db.prepare("DELETE FROM polls WHERE id = ? AND status = 'closed'").run(pollId);
    if (result.changes === 0) throw new ApiError(404, "Abstimmung nicht in der Historie gefunden.");
    return this.getPublicState();
  }

  listPoolGames(): PoolGame[] {
    const rows = this.db.prepare("SELECT * FROM game_pool ORDER BY name COLLATE NOCASE ASC").all() as PoolGameRow[];
    return rows.map(mapPoolGame);
  }

  seedPoolGames(games: GameInput[]): number {
    const findBySteamAppId = this.db.prepare("SELECT id FROM game_pool WHERE steam_appid = ?");
    const findByName = this.db.prepare("SELECT id FROM game_pool WHERE name = ? COLLATE NOCASE LIMIT 1");
    const insert = this.db.prepare(
      `INSERT INTO game_pool
         (id, name, note, steam_appid, cover_url, store_url, release_date, min_players, max_players, tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updateMissing = this.db.prepare(
      `UPDATE game_pool
         SET note = CASE WHEN note = '' THEN ? ELSE note END,
             cover_url = CASE WHEN cover_url = '' THEN ? ELSE cover_url END,
             store_url = CASE WHEN store_url = '' THEN ? ELSE store_url END,
             release_date = CASE WHEN release_date = '' THEN ? ELSE release_date END,
             min_players = COALESCE(min_players, ?),
             max_players = COALESCE(max_players, ?),
             tags = CASE WHEN tags = '[]' THEN ? ELSE tags END
       WHERE id = ?`
    );

    const tx = this.db.transaction(() => {
      let inserted = 0;
      for (const game of games) {
        const normalized = normalizeGame(game);
        if (!normalized.name) continue;
        const existing = normalized.steamAppId ?
          findBySteamAppId.get(normalized.steamAppId) :
          findByName.get(normalized.name);
        if (existing) {
          updateMissing.run(
            normalized.note,
            normalized.coverUrl,
            normalized.storeUrl,
            normalized.releaseDate,
            normalized.minPlayers,
            normalized.maxPlayers,
            JSON.stringify(normalized.tags),
            (existing as { id: string }).id
          );
          continue;
        }

        insert.run(
          shortId(),
          normalized.name,
          normalized.note,
          normalized.steamAppId,
          normalized.coverUrl,
          normalized.storeUrl,
          normalized.releaseDate,
          normalized.minPlayers,
          normalized.maxPlayers,
          JSON.stringify(normalized.tags),
          now()
        );
        inserted += 1;
      }
      return inserted;
    });

    return tx() as number;
  }

  savePoolGame(game: GameInput): PoolGame {
    const normalized = normalizeGame(game);
    const existing =
      game.id?.trim() ?
        (this.db.prepare("SELECT * FROM game_pool WHERE id = ?").get(game.id.trim()) as PoolGameRow | undefined) :
      normalized.steamAppId ?
        (this.db.prepare("SELECT * FROM game_pool WHERE steam_appid = ?").get(normalized.steamAppId) as PoolGameRow | undefined) :
        (this.db.prepare("SELECT * FROM game_pool WHERE name = ? COLLATE NOCASE LIMIT 1").get(normalized.name) as PoolGameRow | undefined);
    const id = existing?.id || shortId();
    this.db
      .prepare(
        `INSERT INTO game_pool
           (id, name, note, steam_appid, cover_url, store_url, release_date, min_players, max_players, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           note = excluded.note,
           steam_appid = excluded.steam_appid,
           cover_url = excluded.cover_url,
           store_url = excluded.store_url,
           release_date = excluded.release_date,
           min_players = excluded.min_players,
           max_players = excluded.max_players,
           tags = excluded.tags`
      )
      .run(
        id,
        normalized.name,
        normalized.note,
        normalized.steamAppId,
        normalized.coverUrl,
        normalized.storeUrl,
        normalized.releaseDate,
        normalized.minPlayers,
        normalized.maxPlayers,
        JSON.stringify(normalized.tags),
        existing?.created_at || now()
      );
    return mapPoolGame(this.db.prepare("SELECT * FROM game_pool WHERE id = ?").get(id) as PoolGameRow);
  }

  deletePoolGame(id: string): void {
    this.db.prepare("DELETE FROM game_pool WHERE id = ?").run(id);
  }

  listTemplates(): PollTemplate[] {
    const rows = this.db.prepare("SELECT * FROM poll_templates ORDER BY name COLLATE NOCASE ASC").all() as TemplateRow[];
    return rows.map(mapTemplate);
  }

  saveTemplate(template: TemplateInput): PollTemplate {
    const id = template.id?.trim() || shortId();
    const existing = this.db.prepare("SELECT * FROM poll_templates WHERE id = ?").get(id) as TemplateRow | undefined;
    const games = template.games.map(normalizeGame).filter((game) => game.name.length > 0);
    if (games.length < 2) throw new ApiError(400, "Eine Vorlage braucht mindestens zwei Spiele.");
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO poll_templates (id, name, title, duration_minutes, games_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           title = excluded.title,
           duration_minutes = excluded.duration_minutes,
           games_json = excluded.games_json,
           updated_at = excluded.updated_at`
      )
      .run(
        id,
        template.name.trim().slice(0, 60),
        template.title.trim().slice(0, 80),
        Math.max(0, Math.min(720, template.durationMinutes)),
        JSON.stringify(games),
        existing?.created_at || timestamp,
        timestamp
      );
    return mapTemplate(this.db.prepare("SELECT * FROM poll_templates WHERE id = ?").get(id) as TemplateRow);
  }

  deleteTemplate(id: string): void {
    this.db.prepare("DELETE FROM poll_templates WHERE id = ?").run(id);
  }

  getOnboardingSettings(): OnboardingSettings {
    const row = this.db.prepare("SELECT * FROM onboarding_settings WHERE id = 1").get() as OnboardingRow | undefined;
    return mapOnboarding(row);
  }

  saveOnboardingSettings(settings: OnboardingSettings): OnboardingSettings {
    const sections = normalizeOnboardingSections(settings.sections || []);
    const normalized = {
      enabled: Boolean(settings.enabled),
      title: settings.title.trim().slice(0, 80) || "LAN-Startseite",
      wlanInfo: settings.wlanInfo.trim().slice(0, 4000),
      voiceInfo: settings.voiceInfo.trim().slice(0, 4000),
      foodInfo: settings.foodInfo.trim().slice(0, 4000),
      scheduleInfo: settings.scheduleInfo.trim().slice(0, 4000),
      helpInfo: settings.helpInfo.trim().slice(0, 4000),
      sections,
      categoryOrder: normalizeOnboardingCategoryOrder(settings.categoryOrder || [], sections)
    };
    this.db
      .prepare(
        `INSERT INTO onboarding_settings
           (id, enabled, title, wlan_info, voice_info, food_info, schedule_info, help_info, sections_json, category_order_json, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           title = excluded.title,
           wlan_info = excluded.wlan_info,
           voice_info = excluded.voice_info,
           food_info = excluded.food_info,
           schedule_info = excluded.schedule_info,
           help_info = excluded.help_info,
           sections_json = excluded.sections_json,
           category_order_json = excluded.category_order_json,
           updated_at = excluded.updated_at`
      )
      .run(
        normalized.enabled ? 1 : 0,
        normalized.title,
        normalized.wlanInfo,
        normalized.voiceInfo,
        normalized.foodInfo,
        normalized.scheduleInfo,
        normalized.helpInfo,
        JSON.stringify(normalized.sections),
        JSON.stringify(normalized.categoryOrder),
        now()
      );
    return this.getOnboardingSettings();
  }

  getAppSettings(): AppSettings {
    const row = this.db.prepare("SELECT participant_polls_enabled FROM app_settings WHERE id = 1").get() as AppSettingsRow | undefined;
    return { participantPollsEnabled: Boolean(row?.participant_polls_enabled) };
  }

  saveAppSettings(settings: AppSettings): AppSettings {
    this.db
      .prepare(
        `INSERT INTO app_settings
           (id, participant_polls_enabled, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           participant_polls_enabled = excluded.participant_polls_enabled,
           updated_at = excluded.updated_at`
      )
      .run(settings.participantPollsEnabled ? 1 : 0, now());
    return this.getAppSettings();
  }

  private closeActivePollInternal(): void {
    const active = this.getActivePollRow();
    if (active) {
      this.db.prepare("UPDATE polls SET status = 'closed', closed_at = ? WHERE id = ?").run(now(), active.id);
    }
  }

  private getActivePoll(): ActivePoll | null {
    const poll = this.getActivePollRow();
    return poll ? this.mapPoll(poll) : null;
  }

  private getActivePollRow(): PollRow | undefined {
    return this.db
      .prepare("SELECT id, title, status, created_at, ends_at, closed_at FROM polls WHERE status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get() as PollRow | undefined;
  }

  private mapPoll(poll: PollRow): ActivePoll {
    const options = this.db
      .prepare(
        `SELECT id, poll_id, name, note, steam_appid, cover_url, store_url, release_date, min_players, max_players, tags, position
         FROM poll_options
         WHERE poll_id = ?
         ORDER BY position ASC`
      )
      .all(poll.id) as OptionRow[];
    const votes = this.db
      .prepare("SELECT poll_id, voter_id, voter_name, option_id, ranking_json, installed_option_ids, is_ready, updated_at FROM votes WHERE poll_id = ?")
      .all(poll.id) as VoteRow[];

    return {
      id: poll.id,
      title: poll.title,
      createdAt: poll.created_at,
      endsAt: poll.ends_at,
      options: options.map(mapOption),
      votes: Object.fromEntries(votes.map((vote) => [vote.voter_id, mapVote(vote)]))
    };
  }

  private getResults(pollId: string): PollResults {
    const poll = this.db.prepare("SELECT id, title, status, created_at, ends_at, closed_at FROM polls WHERE id = ?").get(pollId) as PollRow;
    const options = this.db
      .prepare(
        `SELECT id, poll_id, name, note, steam_appid, cover_url, store_url, release_date, min_players, max_players, tags, position
         FROM poll_options
         WHERE poll_id = ?
         ORDER BY position ASC`
      )
      .all(pollId) as OptionRow[];
    const rows = this.db
      .prepare("SELECT poll_id, voter_id, voter_name, option_id, ranking_json, installed_option_ids, is_ready, updated_at FROM votes WHERE poll_id = ?")
      .all(pollId) as VoteRow[];

    const optionIds = new Set(options.map((option) => option.id));
    const statsByOption = new Map<string, ResultStats>();
    options.forEach((option) => statsByOption.set(option.id, { votes: 0, firstPlaceVotes: 0, readyVotes: 0, voters: [] }));

    let totalVotes = 0;
    for (const row of rows) {
      const rankings = parseRanking(row).filter((optionId) => optionIds.has(optionId));
      if (!rankings.length) continue;
      const installed = parseInstalledOptionIds(row, rankings).filter((optionId) => optionIds.has(optionId));
      totalVotes += 1;
      rankings.forEach((optionId, index) => {
        const stats = statsByOption.get(optionId);
        if (!stats) return;
        const isInstalled = installed.includes(optionId);
        stats.votes += rankWeights[index] || 0;
        if (index === 0) stats.firstPlaceVotes += 1;
        if (isInstalled) stats.readyVotes += 1;
        stats.voters.push({ name: row.voter_name, isReady: Boolean(row.is_ready), isInstalled, rank: index + 1 });
      });
    }

    const totalPoints = [...statsByOption.values()].reduce((sum, stats) => sum + stats.votes, 0);
    return {
      pollId,
      title: poll.title,
      createdAt: poll.created_at,
      totalVotes,
      options: options.map((option) => {
        const stats = statsByOption.get(option.id)!;
        stats.voters.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, "de-DE"));
        return {
          ...mapOption(option),
          votes: stats.votes,
          firstPlaceVotes: stats.firstPlaceVotes,
          readyVotes: stats.readyVotes,
          percent: totalPoints > 0 ? Math.round((stats.votes / totalPoints) * 1000) / 10 : 0,
          readyPercent: stats.voters.length > 0 ? Math.round((stats.readyVotes / stats.voters.length) * 1000) / 10 : 0,
          voters: stats.voters
        };
      })
    };
  }

  private getHistory(): HistoryEntry[] {
    const rows = this.db
      .prepare("SELECT id, title, status, created_at, ends_at, closed_at FROM polls WHERE status = 'closed' ORDER BY closed_at DESC, rowid DESC LIMIT 20")
      .all() as PollRow[];
    return rows.map((row) => this.historyFromPoll(row));
  }

  private getHistoryEntry(pollId: string): HistoryEntry | null {
    const row = this.db.prepare("SELECT id, title, status, created_at, ends_at, closed_at FROM polls WHERE id = ?").get(pollId) as PollRow | undefined;
    return row ? this.historyFromPoll(row) : null;
  }

  private historyFromPoll(poll: PollRow): HistoryEntry {
    const results = this.getResults(poll.id);
    const maxVotes = Math.max(0, ...results.options.map((option) => option.votes));
    const winners = results.options
      .filter((option) => maxVotes > 0 && option.votes === maxVotes)
      .map((option) => ({ id: option.id, name: option.name, votes: option.votes }));

    return {
      pollId: poll.id,
      title: poll.title,
      createdAt: poll.created_at,
      closedAt: poll.closed_at || poll.created_at,
      totalVotes: results.totalVotes,
      winners,
      results: results.options
    };
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function mapOption(row: OptionRow): GameOption {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    steamAppId: row.steam_appid,
    coverUrl: row.cover_url,
    storeUrl: row.store_url,
    releaseDate: row.release_date,
    minPlayers: row.min_players,
    maxPlayers: row.max_players,
    tags: parseStringArray(row.tags)
  };
}

function mapVote(row: VoteRow): Vote {
  const rankedChoiceIds = parseRanking(row);
  const installedOptionIds = parseInstalledOptionIds(row, rankedChoiceIds);
  return {
    voterId: row.voter_id,
    name: row.voter_name,
    choiceId: rankedChoiceIds[0] || row.option_id,
    rankedChoiceIds,
    installedOptionIds,
    isReady: Boolean(row.is_ready),
    updatedAt: row.updated_at
  };
}

function mapPoolGame(row: PoolGameRow): PoolGame {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    steamAppId: row.steam_appid,
    coverUrl: row.cover_url,
    storeUrl: row.store_url,
    releaseDate: row.release_date,
    minPlayers: row.min_players,
    maxPlayers: row.max_players,
    tags: parseStringArray(row.tags),
    createdAt: row.created_at
  };
}

function mapTemplate(row: TemplateRow): PollTemplate {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    durationMinutes: row.duration_minutes,
    games: parseGames(row.games_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapOnboarding(row: OnboardingRow | undefined): OnboardingSettings {
  const sections = parseOnboardingSections(row?.sections_json || "[]");
  return {
    enabled: Boolean(row?.enabled),
    title: row?.title || "LAN-Startseite",
    wlanInfo: row?.wlan_info || "",
    voiceInfo: row?.voice_info || "",
    foodInfo: row?.food_info || "",
    scheduleInfo: row?.schedule_info || "",
    helpInfo: row?.help_info || "",
    sections,
    categoryOrder: parseOnboardingCategoryOrder(row?.category_order_json || "[]", sections)
  };
}

function parseOnboardingSections(value: string): OnboardingSection[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return normalizeOnboardingSections(parsed);
  } catch {
    return [];
  }
}

function normalizeOnboardingSections(sections: OnboardingSection[]): OnboardingSection[] {
  return sections
    .map((section) => ({
      id: section.id?.trim().slice(0, 80) || shortId(),
      title: section.title.trim().slice(0, 60),
      content: section.content.trim().slice(0, 4000)
    }))
    .filter((section) => section.title.length > 0 || section.content.length > 0)
    .slice(0, 20);
}

const defaultOnboardingCategoryIds = ["wlan", "voice", "food", "schedule", "help"];

function parseOnboardingCategoryOrder(value: string, sections: OnboardingSection[]): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return normalizeOnboardingCategoryOrder([], sections);
    return normalizeOnboardingCategoryOrder(parsed, sections);
  } catch {
    return normalizeOnboardingCategoryOrder([], sections);
  }
}

function normalizeOnboardingCategoryOrder(order: string[], sections: OnboardingSection[]): string[] {
  const customIds = sections.map((section) => section.id);
  const allowed = new Set([...defaultOnboardingCategoryIds, ...customIds]);
  const normalized = [...new Set(order.map((item) => item.trim()).filter((item) => allowed.has(item)))];
  for (const id of [...defaultOnboardingCategoryIds, ...customIds]) {
    if (!normalized.includes(id)) normalized.push(id);
  }
  return normalized.slice(0, 25);
}

function normalizeGame(game: GameInput): GameDraftSnapshot {
  const minPlayers = normalizePlayerCount(game.minPlayers);
  const maxPlayers = normalizePlayerCount(game.maxPlayers);
  return {
    name: game.name.trim().slice(0, 80),
    note: (game.note || "").trim().slice(0, 120),
    steamAppId: game.steamAppId || null,
    coverUrl: (game.coverUrl || "").trim(),
    storeUrl: (game.storeUrl || "").trim(),
    releaseDate: (game.releaseDate || "").trim().slice(0, 80),
    minPlayers: minPlayers && maxPlayers && minPlayers > maxPlayers ? maxPlayers : minPlayers,
    maxPlayers: minPlayers && maxPlayers && minPlayers > maxPlayers ? minPlayers : maxPlayers,
    tags: normalizeTags(game.tags || [])
  };
}

function normalizePlayerCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, 256) : null;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.slice(0, 28)))].slice(0, 12);
}

function normalizeRankings(values: string[]): string[] {
  return normalizeOptionIds(values).slice(0, 3);
}

function normalizeOptionIds(values: string[]): string[] {
  const rankings: string[] = [];
  for (const value of values) {
    const optionId = value.trim();
    if (optionId && !rankings.includes(optionId)) rankings.push(optionId);
  }
  return rankings;
}

function parseRanking(row: VoteRow): string[] {
  const parsed = parseStringArray(row.ranking_json);
  return parsed.length ? normalizeRankings(parsed) : [row.option_id].filter(Boolean);
}

function parseInstalledOptionIds(row: VoteRow, rankedChoiceIds = parseRanking(row)): string[] {
  const parsed = normalizeOptionIds(parseStringArray(row.installed_option_ids));
  return parsed.length ? parsed : Boolean(row.is_ready) ? rankedChoiceIds : [];
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseGames(value: string): GameDraftSnapshot[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is GameInput => typeof item === "object" && item !== null && typeof item.name === "string")
      .map(normalizeGame);
  } catch {
    return [];
  }
}

function now(): string {
  return new Date().toISOString();
}

function shortId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}
