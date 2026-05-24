import os from "node:os";

export type ServerConfig = {
  host: string;
  port: number;
  lanAddress: string;
  publicBaseUrl: string;
  databasePath: string;
  steamWebApiKey?: string;
  steamAppListTtlMs: number;
  steamDetailsCacheTtlMs: number;
  adminUser: string;
  adminPassword?: string;
};

export function loadConfig(): ServerConfig {
  const port = numberFromEnv("LAN_VOTE_PORT", 8080);
  const host = process.env.LAN_VOTE_HOST || "0.0.0.0";
  const lanAddress = findLanAddress();
  const publicBaseUrl = (process.env.LAN_VOTE_PUBLIC_URL || `http://${lanAddress}:${port}`).replace(/\/+$/, "");
  const databasePath = process.env.LAN_VOTE_DB_PATH || "/app/data/lan-vote.sqlite";
  const steamWebApiKey = process.env.STEAM_WEB_API_KEY?.trim() || undefined;
  const steamAppListTtlMs = numberFromEnv("STEAM_APP_LIST_TTL_HOURS", 24) * 60 * 60 * 1000;
  const steamDetailsCacheTtlMs = numberFromEnv("STEAM_DETAILS_CACHE_TTL_DAYS", 365) * 24 * 60 * 60 * 1000;
  const adminUser = process.env.LAN_VOTE_ADMIN_USER?.trim() || "admin";
  const adminPassword = process.env.LAN_VOTE_ADMIN_PASSWORD?.trim() || undefined;

  return {
    host,
    port,
    lanAddress,
    publicBaseUrl,
    databasePath,
    steamWebApiKey,
    steamAppListTtlMs,
    steamDetailsCacheTtlMs,
    adminUser,
    adminPassword
  };
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function findLanAddress(): string {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal && !item.address.startsWith("169.254.")) {
        return item.address;
      }
    }
  }
  return "localhost";
}
