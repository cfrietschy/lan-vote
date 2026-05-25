import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server as SocketServer } from "socket.io";
import { ZodError } from "zod";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { defaultPoolGames } from "./lan-classics.js";
import { GameMetadataCache } from "./metadata-cache.js";
import { appSettingsSchema, createPollSchema, onboardingSchema, participantPollSchema, pollTemplateSchema, poolGameSchema, steamSearchSchema, steamTopGamesSchema, uploadImageSchema, voteSchema } from "./schemas.js";
import { SteamApiError, SteamService } from "./steam.js";
import { ApiError, Store, type GameInput } from "./store.js";

const config = loadConfig();
const db = openDatabase(config);
const store = new Store(db, config);
const seededPoolGames = store.seedPoolGames(defaultPoolGames);
const metadataCache = new GameMetadataCache(db, config.steamDetailsCacheTtlMs);
const steam = new SteamService(config.steamWebApiKey, config.steamAppListTtlMs, metadataCache);
const app = express();
const server = http.createServer(app);
const uploadsRoot = path.join(path.dirname(config.databasePath), "uploads");
const io = new SocketServer(server, {
  cors: {
    origin: true
  }
});

app.use(express.json({ limit: "6mb" }));

app.get("/api/state", (_req, res) => {
  res.json(store.getPublicState());
});

app.get("/api/steam/search", requireAdmin, async (req, res, next) => {
  try {
    const payload = steamSearchSchema.parse(req.query);
    res.json({ results: await steam.search(payload.q, payload.limit) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/steam/apps/:appid", requireAdmin, async (req, res, next) => {
  try {
    const appid = Number(req.params.appid);
    if (!Number.isInteger(appid) || appid <= 0) throw new ApiError(400, "Ungültige Steam AppID.");
    res.json(await steam.getDetails(appid));
  } catch (error) {
    next(error);
  }
});

app.get("/api/steam/top-multiplayer", requireAdmin, async (req, res, next) => {
  try {
    const payload = steamTopGamesSchema.parse(req.query);
    res.json({ results: await steam.getTopMultiplayerGames(payload.limit) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/games", requireAdmin, (_req, res) => {
  res.json({ games: store.listPoolGames() });
});

app.get("/api/public/games", (_req, res, next) => {
  try {
    if (!store.getAppSettings().participantPollsEnabled) throw new ApiError(403, "Teilnehmer dürfen aktuell keine Abstimmungen starten.");
    res.json({ games: store.listPoolGames() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/games", requireAdmin, async (req, res, next) => {
  try {
    const payload = poolGameSchema.parse(req.body);
    res.status(201).json(store.savePoolGame(await enrichGameInput(payload)));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/games/:id", requireAdmin, (req, res, next) => {
  try {
    store.deletePoolGame(String(req.params.id));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/templates", requireAdmin, (_req, res) => {
  res.json({ templates: store.listTemplates() });
});

app.post("/api/templates", requireAdmin, (req, res, next) => {
  try {
    const payload = pollTemplateSchema.parse(req.body);
    res.status(201).json(store.saveTemplate(payload));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/templates/:id", requireAdmin, (req, res, next) => {
  try {
    store.deleteTemplate(String(req.params.id));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/onboarding", requireAdmin, (_req, res) => {
  res.json(store.getOnboardingSettings());
});

app.put("/api/onboarding", requireAdmin, (req, res, next) => {
  try {
    const payload = onboardingSchema.parse(req.body);
    const onboarding = store.saveOnboardingSettings(payload);
    emitState();
    res.json(onboarding);
  } catch (error) {
    next(error);
  }
});

app.post("/api/uploads/images", requireAdmin, async (req, res, next) => {
  try {
    const payload = uploadImageSchema.parse(req.body);
    const buffer = Buffer.from(payload.data, "base64");
    if (buffer.length === 0 || buffer.length > 4 * 1024 * 1024) throw new ApiError(400, "Bild darf maximal 4 MB groß sein.");

    const extension = extensionForMimeType(payload.mimeType);
    const baseName = path
      .basename(payload.filename, path.extname(payload.filename))
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "bild";
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${baseName}.${extension}`;
    await fs.mkdir(uploadsRoot, { recursive: true });
    await fs.writeFile(path.join(uploadsRoot, filename), buffer, { flag: "wx" });

    res.status(201).json({ url: `/uploads/${filename}`, filename });
  } catch (error) {
    next(error);
  }
});

app.get("/api/uploads/images", requireAdmin, async (_req, res, next) => {
  try {
    const images = await listUploadedImages();
    const referencedFilenames = referencedUploadFilenames();
    res.json({
      images: images.map((image) => ({ ...image, referenced: referencedFilenames.has(image.filename) })),
      orphanCount: images.filter((image) => !referencedFilenames.has(image.filename)).length
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/uploads/images/orphans", requireAdmin, async (_req, res, next) => {
  try {
    const images = await listUploadedImages();
    const referencedFilenames = referencedUploadFilenames();
    const deleted: string[] = [];

    for (const image of images) {
      if (referencedFilenames.has(image.filename)) continue;
      await fs.unlink(uploadPathForFilename(image.filename));
      deleted.push(image.filename);
    }

    res.json({ deleted });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/uploads/images/:filename", requireAdmin, async (req, res, next) => {
  try {
    const filename = safeUploadFilename(String(req.params.filename));
    await fs.unlink(uploadPathForFilename(filename)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new ApiError(404, "Bild nicht gefunden.");
      throw error;
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", requireAdmin, (req, res, next) => {
  try {
    const payload = appSettingsSchema.parse(req.body);
    const settings = store.saveAppSettings(payload);
    emitState();
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

app.post("/api/polls", requireAdmin, (req, res, next) => {
  try {
    const payload = createPollSchema.parse(req.body);
    const state = store.createPoll(payload.title, payload.games, payload.durationMinutes);
    emitState();
    emitPollStarted(state);
    res.status(201).json(state);
  } catch (error) {
    next(error);
  }
});

app.post("/api/participant/polls", (req, res, next) => {
  try {
    if (!store.getAppSettings().participantPollsEnabled) throw new ApiError(403, "Teilnehmer dürfen aktuell keine Abstimmungen starten.");
    if (store.getPublicState().activePoll) throw new ApiError(409, "Es läuft bereits eine Abstimmung.");
    const payload = participantPollSchema.parse(req.body);
    const poolById = new Map(store.listPoolGames().map((game) => [game.id, game]));
    const games: GameInput[] = [];
    for (const id of payload.gameIds) {
      const game = poolById.get(id);
      if (!game) throw new ApiError(400, "Mindestens ein Spiel ist nicht mehr im Pool vorhanden.");
      games.push(game);
    }
    const state = store.createPoll(payload.title, games, payload.durationMinutes);
    emitState();
    emitPollStarted(state);
    res.status(201).json(state);
  } catch (error) {
    next(error);
  }
});

app.post("/api/vote", (req, res, next) => {
  try {
    const payload = voteSchema.parse(req.body);
    const result = store.vote(payload.voterId, payload.name, payload.rankings || payload.choiceId || "", payload.isReady, payload.installedOptionIds);
    emitState();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/polls/tiebreaker", requireAdmin, (_req, res, next) => {
  try {
    const state = store.startTieBreaker(5);
    emitState();
    emitPollStarted(state);
    res.status(201).json(state);
  } catch (error) {
    next(error);
  }
});

app.post("/api/polls/close", requireAdmin, (_req, res, next) => {
  try {
    const result = store.closeActivePoll();
    emitState();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/history/clear", requireAdmin, (_req, res, next) => {
  try {
    const state = store.clearHistory();
    emitState();
    res.json(state);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/history/:pollId", requireAdmin, (req, res, next) => {
  try {
    const state = store.deleteHistoryEntry(String(req.params.pollId));
    emitState();
    res.json(state);
  } catch (error) {
    next(error);
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(__dirname, "../public");
app.use("/uploads", express.static(uploadsRoot, { etag: false, immutable: true, maxAge: "30d" }));
app.use(express.static(publicRoot, { etag: false, maxAge: 0 }));
app.get(["/", "/start", "/vote"], (_req, res) => {
  res.sendFile(path.join(publicRoot, "index.html"));
});
app.get("/admin", requireAdmin, (_req, res) => {
  res.sendFile(path.join(publicRoot, "index.html"));
});
app.get("/tv", (_req, res) => {
  res.sendFile(path.join(publicRoot, "index.html"));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof SteamApiError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ error: error.issues[0]?.message || "Ungültige Anfrage." });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Interner Serverfehler." });
});

io.on("connection", (socket) => {
  socket.emit("state", store.getPublicState());
});

server.listen(config.port, config.host, () => {
  console.log("LAN Vote ist gestartet.");
  console.log(`Monitor: ${config.publicBaseUrl}/`);
  console.log(`Abstimmen: ${config.publicBaseUrl}/vote`);
  console.log(`Admin: ${config.publicBaseUrl}/admin`);
  if (seededPoolGames > 0) console.log(`${seededPoolGames} LAN-Klassiker wurden dem Spiel-Pool hinzugefügt.`);
  steam.getTopMultiplayerGames(20).catch((error: unknown) => {
    console.warn("Steam-Topliste konnte nicht vorgeladen werden.", error);
  });
  refreshPoolMetadata().catch((error: unknown) => {
    console.warn("Spiel-Pool konnte nicht automatisch mit Steam-Daten ergänzt werden.", error);
  });
});

setInterval(() => {
  if (store.closeExpiredPolls()) emitState();
}, 5000);

function emitState(): void {
  io.emit("state", store.getPublicState());
}

function emitPollStarted(state: ReturnType<Store["getPublicState"]>): void {
  if (!state.activePoll) return;
  io.emit("poll-started", {
    pollId: state.activePoll.id,
    title: state.activePoll.title,
    voteUrl: state.server.voteUrl,
    qrUrl: state.server.qrUrl
  });
}

async function refreshPoolMetadata(): Promise<void> {
  for (const game of store.listPoolGames()) {
    if (!game.steamAppId || !needsSteamMetadata(game)) continue;
    store.savePoolGame(await enrichGameInput(game));
  }
}

async function enrichGameInput(game: GameInput): Promise<GameInput> {
  if (!game.steamAppId || !needsSteamMetadata(game)) return game;

  const details = await steam.getDetails(game.steamAppId);
  const note = details.genres.slice(0, 3).join(", ") || details.categories.slice(0, 2).join(", ");
  return {
    ...game,
    name: game.name.trim() || details.name,
    note: game.note?.trim() ? game.note : note,
    coverUrl: game.coverUrl || details.coverUrl,
    storeUrl: game.storeUrl || details.storeUrl,
    releaseDate: game.releaseDate?.trim() ? game.releaseDate : details.releaseDate,
    minPlayers: game.minPlayers ?? details.minPlayers,
    maxPlayers: game.maxPlayers ?? details.maxPlayers,
    tags: game.tags?.length ? game.tags : details.tags
  };
}

function needsSteamMetadata(game: GameInput): boolean {
  return Boolean(
    game.steamAppId &&
      (!game.note?.trim() ||
        !game.coverUrl ||
        !game.storeUrl ||
        !game.releaseDate?.trim() ||
        !game.tags?.length ||
        (game.minPlayers == null && game.maxPlayers == null))
  );
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!config.adminPassword) {
    res.status(503).json({ error: "Admin-Zugang ist nicht konfiguriert. LAN_VOTE_ADMIN_PASSWORD setzen." });
    return;
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    requestBasicAuth(res);
    return;
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const username = separator >= 0 ? decoded.slice(0, separator) : "";
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";

  if (timingSafeEqual(username, config.adminUser) && timingSafeEqual(password, config.adminPassword)) {
    next();
    return;
  }

  requestBasicAuth(res);
}

function extensionForMimeType(mimeType: string): "png" | "jpg" | "webp" | "gif" {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "gif";
}

async function listUploadedImages(): Promise<Array<{ filename: string; url: string; size: number; modifiedAt: string }>> {
  const entries = await fs.readdir(uploadsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });

  const images = await Promise.all(entries
    .filter((entry) => entry.isFile() && isUploadFilename(entry.name))
    .map(async (entry) => {
      const filename = safeUploadFilename(entry.name);
      const stats = await fs.stat(uploadPathForFilename(filename));
      return { filename, url: `/uploads/${filename}`, size: stats.size, modifiedAt: stats.mtime.toISOString() };
    }));

  return images.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function referencedUploadFilenames(): Set<string> {
  const onboarding = store.getOnboardingSettings();
  const text = [onboarding.wlanInfo, onboarding.voiceInfo, onboarding.foodInfo, onboarding.scheduleInfo, onboarding.helpInfo].join("\n");
  const filenames = new Set<string>();
  const pattern = /\/uploads\/([A-Za-z0-9._-]+\.(?:png|jpg|webp|gif))/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    try {
      filenames.add(safeUploadFilename(match[1] || ""));
    } catch {
      // Ignore stale or hand-edited invalid references.
    }
  }
  return filenames;
}

function safeUploadFilename(filename: string): string {
  if (!isUploadFilename(filename)) throw new ApiError(400, "Ungültiger Bildname.");
  return filename;
}

function isUploadFilename(filename: string): boolean {
  return /^[A-Za-z0-9._-]+\.(?:png|jpg|webp|gif)$/i.test(filename);
}

function uploadPathForFilename(filename: string): string {
  return path.join(uploadsRoot, safeUploadFilename(filename));
}

function requestBasicAuth(res: express.Response): void {
  res.setHeader("WWW-Authenticate", 'Basic realm="LAN Vote Admin", charset="UTF-8"');
  res.status(401).send("Admin-Zugang erforderlich.");
}

function timingSafeEqual(value: string, expected: string): boolean {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  if (valueBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(valueBuffer, expectedBuffer);
}
