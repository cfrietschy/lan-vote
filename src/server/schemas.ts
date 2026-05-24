import { z } from "zod";

const tagsSchema = z
  .array(z.string().trim().min(1).transform((tag) => tag.slice(0, 28)))
  .max(12)
  .optional()
  .default([]);
const optionalPlayerCount = z.coerce.number().int().min(1).max(256).nullable().optional().default(null);

const gameInput = z.union([
  z.string().trim().min(1).max(120).transform((line) => {
    const [name, ...noteParts] = line.split("|").map((part) => part.trim());
    return { name: name || line, note: noteParts.join(" | "), minPlayers: null, maxPlayers: null, tags: [] };
  }),
  z.object({
    name: z.string().trim().min(1).max(80),
    note: z.string().trim().max(120).optional().default(""),
    steamAppId: z.coerce.number().int().positive().nullable().optional().default(null),
    coverUrl: z.string().trim().url().or(z.literal("")).optional().default(""),
    storeUrl: z.string().trim().url().or(z.literal("")).optional().default(""),
    releaseDate: z.string().trim().max(80).optional().default(""),
    minPlayers: optionalPlayerCount,
    maxPlayers: optionalPlayerCount,
    tags: tagsSchema
  })
]);

export const createPollSchema = z.object({
  title: z.string().trim().min(1).max(80).default("Was spielen wir als Nächstes?"),
  games: z.array(gameInput).min(2, "Bitte mindestens zwei Spiele angeben."),
  durationMinutes: z.coerce.number().int().min(0).max(720).default(15)
});

export const participantPollSchema = z.object({
  title: z.string().trim().min(1).max(80).default("Was spielen wir als Nächstes?"),
  gameIds: z.array(z.string().trim().min(1).max(80)).min(2, "Bitte mindestens zwei Spiele angeben.").max(12, "Bitte maximal zwölf Spiele auswählen."),
  durationMinutes: z.coerce.number().int().min(1).max(120).default(15)
});

export const voteSchema = z.object({
  voterId: z.string().trim().max(80).default(""),
  name: z.string().trim().max(40).default("Spieler"),
  choiceId: z.string().trim().min(1).optional(),
  rankings: z.array(z.string().trim().min(1)).min(1).max(3).optional(),
  installedOptionIds: z.array(z.string().trim().min(1).max(80)).max(80).optional().default([]),
  isReady: z.boolean().default(false)
});

export const steamSearchSchema = z.object({
  q: z.string().trim().min(2).max(80),
  limit: z.coerce.number().int().min(1).max(25).default(12)
});

export const steamTopGamesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(20)
});

export const poolGameSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(80),
  note: z.string().trim().max(120).optional().default(""),
  steamAppId: z.coerce.number().int().positive().nullable().optional().default(null),
  coverUrl: z.string().trim().url().or(z.literal("")).optional().default(""),
  storeUrl: z.string().trim().url().or(z.literal("")).optional().default(""),
  releaseDate: z.string().trim().max(80).optional().default(""),
  minPlayers: optionalPlayerCount,
  maxPlayers: optionalPlayerCount,
  tags: tagsSchema
});

export const onboardingSchema = z.object({
  enabled: z.boolean().default(false),
  title: z.string().trim().min(1).max(80).default("LAN-Startseite"),
  wlanInfo: z.string().trim().max(1000).default(""),
  voiceInfo: z.string().trim().max(1000).default(""),
  foodInfo: z.string().trim().max(1000).default(""),
  scheduleInfo: z.string().trim().max(1000).default(""),
  helpInfo: z.string().trim().max(1000).default("")
});

export const appSettingsSchema = z.object({
  participantPollsEnabled: z.boolean().default(false)
});

export const pollTemplateSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(60),
  title: z.string().trim().min(1).max(80).default("Was spielen wir als Nächstes?"),
  durationMinutes: z.coerce.number().int().min(0).max(720).default(15),
  games: z.array(gameInput).min(2, "Bitte mindestens zwei Spiele angeben.")
});
