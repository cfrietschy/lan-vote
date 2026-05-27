import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import { io } from "socket.io-client";
import { defaultNoticeExpiry, formatGermanDateTimeInput, parseGermanDateTimeInput } from "../shared/datetime";
import type { AdminNotice, AppSettings, GameDraftSnapshot, OnboardingSection, OnboardingSettings, OnboardingTvLayout, PollTemplate, PoolGame, PublicState, ResultOption, SteamGameDetails } from "../shared/types";
import "./styles.css";

type GameDraft = {
  id?: string;
  name: string;
  note: string;
  steamAppId?: number | null;
  coverUrl?: string;
  storeUrl?: string;
  releaseDate?: string;
  minPlayers?: number | null;
  maxPlayers?: number | null;
  tags?: string[];
};

const presets: GameDraft[] = [
  steamPreset(730, "Counter-Strike 2", "Action, Kostenlos spielbar", ["Action", "Shooter", "Competitive", "Mehrspieler"], 2, 10),
  steamPreset(550, "Left 4 Dead 2", "Action", ["Action", "Koop", "Survival", "Einsteigerfreundlich"], 2, 4),
  steamPreset(252950, "Rocket League", "Sport, Racing", ["Sport", "Racing", "Kurz", "Competitive"], 2, 8),
  steamPreset(813780, "Age of Empires II: Definitive Edition", "Strategie", ["Strategie", "RTS", "Competitive", "Klassiker"], 2, 8),
  steamPreset(2225070, "Trackmania", "Racing", ["Racing", "Kurz", "Arcade", "Einsteigerfreundlich"], 2, 32),
  steamPreset(327030, "Worms W.M.D", "Strategie, Party", ["Party", "Rundenbasiert", "Einsteigerfreundlich"], 2, 6),
  steamPreset(440, "Team Fortress 2", "Action, Kostenlos spielbar", ["Action", "Shooter", "Teams", "Mehrspieler"], 4, 24),
  steamPreset(570, "Dota 2", "MOBA, Kostenlos spielbar", ["MOBA", "Competitive", "Teams", "Lang"], 10, 10),
  steamPreset(289070, "Civilization VI", "Strategie", ["Strategie", "Rundenbasiert", "Lang"], 2, 12),
  steamPreset(892970, "Valheim", "Koop Survival", ["Koop", "Survival", "Crafting", "Open World"], 2, 10),
  steamPreset(945360, "Among Us", "Party", ["Party", "Social Deduction", "Kurz", "Einsteigerfreundlich"], 4, 15),
  steamPreset(331670, "Jackbox Party Pack", "Party", ["Party", "Quiz", "Einsteigerfreundlich"], 3, 8)
];

function steamPreset(appid: number, name: string, note: string, tags: string[], minPlayers: number, maxPlayers: number): GameDraft {
  return {
    name,
    note,
    steamAppId: appid,
    coverUrl: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
    storeUrl: `https://store.steampowered.com/app/${appid}/`,
    minPlayers,
    maxPlayers,
    tags: normalizeTags(tags)
  };
}

const socket = io();

type Route = "monitor" | "start" | "vote" | "admin" | "tv";
type ThemeMode = "dark" | "light";

type SteamSearchResult = {
  appid: number;
  name: string;
  coverUrl: string;
  storeUrl: string;
};

type SteamTopGame = SteamSearchResult & {
  rank: number;
  peakPlayers: number;
};

type UploadedImage = {
  filename: string;
  url: string;
  size: number;
  modifiedAt: string;
  referenced: boolean;
};

type UploadedImagesResponse = {
  images: UploadedImage[];
  orphanCount: number;
};

type AdminTab = "poll" | "templates" | "add-games" | "pool" | "active" | "onboarding" | "notice" | "history" | "settings";
type PoolPlayerFilter = "all" | "2-4" | "5-8" | "9-16" | "17+";
type PoolSourceFilter = "all" | "steam" | "manual";
type DefaultOnboardingKey = "wlanInfo" | "voiceInfo" | "foodInfo" | "scheduleInfo" | "helpInfo";
type TvLayoutColumn = keyof OnboardingTvLayout;

const defaultOnboardingCategories: Array<{ id: string; title: string; key: DefaultOnboardingKey; placeholder: string }> = [
  { id: "wlan", title: "WLAN / LAN", key: "wlanInfo", placeholder: "- SSID: LAN\n- Passwort: ...\n![](/uploads/...)" },
  { id: "voice", title: "Discord / Voice", key: "voiceInfo", placeholder: "[Discord öffnen](https://discord.gg/...)" },
  { id: "food", title: "Essen", key: "foodInfo", placeholder: "## Essen\n- Pizza 19:00\n- Getränke im Kühlschrank" },
  { id: "schedule", title: "Ablauf", key: "scheduleInfo", placeholder: "## Ablauf\n- 18:00 Warmup\n- 20:00 Turnier" },
  { id: "help", title: "Hilfe", key: "helpInfo", placeholder: "Bei Problemen: **Orga fragen**" }
];

const adminTabs: Array<{ id: AdminTab; label: string }> = [
  { id: "add-games", label: "Spiele hinzufügen" },
  { id: "pool", label: "Spiel-Pool" },
  { id: "templates", label: "Vorlagen" },
  { id: "poll", label: "Abstimmung" },
  { id: "active", label: "Laufend" },
  { id: "history", label: "Historie" },
  { id: "onboarding", label: "Onboarding" },
  { id: "notice", label: "Meldung" },
  { id: "settings", label: "Einstellungen" }
];

type PollStartedNotice = {
  pollId: string;
  title: string;
  voteUrl: string;
  qrUrl: string;
  receivedAt: number;
};

type VisitorNotice =
  | { kind: "poll"; title: string; voteUrl: string; qrUrl: string; receivedAt: number }
  | { kind: "admin"; id: string; title: string; message: string; expiresAt: string; receivedAt: number };

function App() {
  const [state, setState] = useState<PublicState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<VisitorNotice | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(() => isNotificationSoundEnabled());
  const [theme, setTheme] = useState<ThemeMode>(() => getSavedTheme());

  useEffect(() => {
    fetchState().then(setState).catch((err: Error) => setError(err.message));
    socket.on("state", setState);
    socket.on("poll-started", handlePollStarted);
    socket.on("admin-notice", handleAdminNotice);
    socket.on("admin-notice-cleared", handleAdminNoticeCleared);
    return () => {
      socket.off("state", setState);
      socket.off("poll-started", handlePollStarted);
      socket.off("admin-notice", handleAdminNotice);
      socket.off("admin-notice-cleared", handleAdminNoticeCleared);
    };
  }, [soundEnabled]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 12_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("lanVoteTheme", theme);
  }, [theme]);

  useEffect(() => {
    if (!state?.adminNotice || hasSeenAdminNotice(state.adminNotice.id)) return;
    showAdminNotice(state.adminNotice);
  }, [state?.adminNotice?.id]);

  function handlePollStarted(payload: Omit<PollStartedNotice, "receivedAt">) {
    const nextNotice: VisitorNotice = { kind: "poll", ...payload, receivedAt: Date.now() };
    setNotice(nextNotice);
    notifyDevice();
    if (soundEnabled) playNewPollSound();
  }

  function handleAdminNotice(payload: AdminNotice) {
    if (hasSeenAdminNotice(payload.id)) return;
    showAdminNotice(payload);
  }

  function handleAdminNoticeCleared() {
    setNotice((current) => current?.kind === "admin" ? null : current);
  }

  function showAdminNotice(payload: AdminNotice) {
    markAdminNoticeSeen(payload.id);
    setNotice({ kind: "admin", ...payload, receivedAt: Date.now() });
    notifyDevice();
    if (soundEnabled) playNewPollSound();
  }

  async function enableSound() {
    await enableNotificationSound();
    setSoundEnabled(true);
  }

  if (error) return <Shell state={state} theme={theme} onThemeChange={setTheme}><div className="empty">Server nicht erreichbar: {error}</div></Shell>;
  if (!state) return <Shell state={state} theme={theme} onThemeChange={setTheme}><div className="empty">Lade LAN Vote...</div></Shell>;

  const route = currentRoute();
  if (route === "tv") return <TvView state={state} notice={notice} soundEnabled={soundEnabled} onEnableSound={enableSound} theme={theme} onThemeChange={setTheme} />;

  return (
    <Shell state={state} notice={notice} soundEnabled={soundEnabled} onEnableSound={enableSound} theme={theme} onThemeChange={setTheme}>
      {route === "start" ? <OnboardingView state={state} /> :
        route === "vote" ? <VoteView state={state} /> :
        route === "admin" ? <AdminView state={state} onState={setState} /> :
        <MonitorView state={state} />}
    </Shell>
  );
}

function Shell({
  state,
  notice,
  soundEnabled,
  onEnableSound,
  theme,
  onThemeChange,
  children
}: {
  state: PublicState | null;
  notice?: VisitorNotice | null;
  soundEnabled?: boolean;
  onEnableSound?: () => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  children: React.ReactNode;
}) {
  const route = currentRoute();
  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <strong>LAN Vote</strong>
          <span>{state?.server.publicUrl || "lokal"}</span>
        </div>
        <div className="topbar-actions">
          <nav className="nav" aria-label="Hauptnavigation">
            <a className={route === "monitor" ? "active" : ""} href="/">Monitor</a>
            <a className={route === "start" ? "active" : ""} href="/start">Start</a>
            <a className={route === "vote" ? "active" : ""} href="/vote">Abstimmen</a>
            <a className={route === "admin" ? "active" : ""} href="/admin">Admin</a>
            <a className={route === "tv" ? "active" : ""} href="/tv">TV</a>
          </nav>
          <ThemeToggle value={theme} onChange={onThemeChange} />
          <SoundToggle enabled={Boolean(soundEnabled)} onEnable={onEnableSound} />
        </div>
      </header>
      <NotificationToast notice={notice} />
      {children}
    </main>
  );
}

function ThemeToggle({ value, onChange }: { value: ThemeMode; onChange: (theme: ThemeMode) => void }) {
  const options: Array<{ value: ThemeMode; label: string; icon: string }> = [
    { value: "dark", label: "Dunkel", icon: "◐" },
    { value: "light", label: "Hell", icon: "☼" }
  ];
  function choose(theme: ThemeMode) {
    onChange(theme);
  }
  return (
    <div className="theme-toggle" aria-label="Darstellung wählen">
      {options.map((option) => (
        <button
          type="button"
          className={value === option.value ? "active" : ""}
          key={option.value}
          onClick={() => choose(option.value)}
          aria-label={`${option.label}-Modus`}
          title={`${option.label}-Modus`}
        >
          <span aria-hidden="true">{option.icon}</span>
        </button>
      ))}
    </div>
  );
}

function NotificationToast({ notice }: { notice?: VisitorNotice | null }) {
  if (!notice) return null;
  if (notice.kind === "admin") {
    return (
      <aside className="notification-toast admin-notice-toast" role="status" aria-live="polite">
        <strong>{notice.title}</strong>
        <span>{notice.message}</span>
        <small>Bis {formatDateTime(notice.expiresAt)}</small>
      </aside>
    );
  }
  return (
    <aside className="notification-toast" role="status" aria-live="polite">
      <strong>Neue Abstimmung</strong>
      <span>{notice.title}</span>
      <a href="/vote">Jetzt abstimmen</a>
    </aside>
  );
}

function SoundToggle({ enabled, onEnable }: { enabled: boolean; onEnable?: () => void }) {
  if (enabled || !onEnable) return null;
  return (
    <button type="button" className="sound-toggle" onClick={onEnable}>
      Ton aktivieren
    </button>
  );
}

function MonitorView({ state }: { state: PublicState }) {
  return (
    <section className="monitor-grid">
      <aside className="panel qr-wrap">
        <h2>{state.onboarding.enabled ? "LAN-Start" : "Abstimmen"}</h2>
        <QrCode value={state.server.qrUrl} />
        <div className="url-box">{state.server.qrUrl}</div>
        <a className="link-button" href={state.server.tvUrl}>TV-Modus öffnen</a>
      </aside>
      <div className="field-grid">
        <section className="panel">
          <ActivePollBlock state={state} />
        </section>
        <section className="panel">
          <h2>Vorherige Gewinner</h2>
          <History state={state} />
        </section>
      </div>
    </section>
  );
}

function OnboardingView({ state }: { state: PublicState }) {
  const items = getOnboardingItems(state.onboarding);
  const [lightboxImage, setLightboxImage] = useState<MarkdownLightboxImage | null>(null);

  useEffect(() => {
    if (!lightboxImage) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setLightboxImage(null);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [lightboxImage]);

  return (
    <section className="onboarding-layout">
      <div className="panel">
        <p className="muted">LAN-Startseite</p>
        <h1>{state.onboarding.title}</h1>
        <div className="actions">
          <a className="link-button primary-link" href="/vote">Zur Abstimmung</a>
          <a className="link-button" href="/">Monitor</a>
        </div>
      </div>
      {items.length ? (
        <div className="info-grid">
          {items.map(({ id, title, value }) => (
            <section className="panel info-panel" key={id}>
              <h2>{title}</h2>
              <MarkdownContent value={value} onOpenImage={setLightboxImage} />
            </section>
          ))}
        </div>
      ) : (
        <div className="empty">Noch keine LAN-Infos hinterlegt. Der Adminbereich kann diese Startseite befüllen.</div>
      )}
      {lightboxImage ? <ImageLightbox image={lightboxImage} onClose={() => setLightboxImage(null)} /> : null}
    </section>
  );
}

function ImageLightbox({ image, onClose }: { image: MarkdownLightboxImage; onClose: () => void }) {
  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Bild in Originalgröße" onClick={onClose}>
      <div className="image-lightbox-content" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="image-lightbox-close" onClick={onClose} aria-label="Bild schließen">Schließen</button>
        <img src={image.url} alt={image.alt} />
        {image.alt ? <p>{image.alt}</p> : null}
      </div>
    </div>
  );
}

function TvView({
  state,
  notice,
  soundEnabled,
  onEnableSound,
  theme,
  onThemeChange
}: {
  state: PublicState;
  notice: VisitorNotice | null;
  soundEnabled: boolean;
  onEnableSound: () => void;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
}) {
  const hasActivePoll = Boolean(state.activePoll && state.activeResults);
  const tvClassName = `tv ${notice ? "tv-flash" : ""} ${hasActivePoll ? "tv-active" : "tv-idle"}`;
  const pollNotice = notice?.kind === "poll" ? notice : null;

  return (
    <main className={tvClassName}>
      <SoundToggle enabled={soundEnabled} onEnable={onEnableSound} />
      <ThemeToggle value={theme} onChange={onThemeChange} />
      {pollNotice ? (
        <aside className="tv-alert" role="status" aria-live="assertive">
          <span>Neue Abstimmung</span>
          <strong>{pollNotice.title}</strong>
          <div className="tv-alert-grid">
            <QrCode value={pollNotice.qrUrl} />
            <div>
              <p>Jetzt abstimmen</p>
              <div className="url-box">{pollNotice.qrUrl}</div>
            </div>
          </div>
        </aside>
      ) : null}
      {state.adminNotice ? <AdminNoticeBanner notice={state.adminNotice} tv /> : null}
      {hasActivePoll ? (
        <section className="tv-main tv-main-active">
          <div className="tv-poll-panel">
            <div className="tv-brand">LAN Vote</div>
            <ActivePollBlock state={state} tv />
          </div>
          <aside className="tv-side tv-side-active">
            <section className="tv-qr-card" aria-label="Abstimmungs-QR-Code">
              <p className="muted">Jetzt abstimmen</p>
              <QrCode value={state.server.qrUrl} />
              <div className="url-box">{state.server.qrUrl}</div>
            </section>
            <TvOnboardingInfo onboarding={state.onboarding} compact />
            <section className="tv-history-compact">
              <h2>Gewinner</h2>
              <History state={state} />
            </section>
          </aside>
        </section>
      ) : (
        <section className="tv-main tv-main-idle">
          <div className="tv-info-wide">
            <div className="tv-brand">LAN Vote</div>
            <TvOnboardingInfo onboarding={state.onboarding} />
          </div>
          <aside className="tv-side tv-side-idle">
            <div className="empty">Aktuell läuft keine Abstimmung.</div>
            <section className="tv-qr-card" aria-label="LAN-QR-Code">
              <p className="muted">LAN-Seite</p>
              <QrCode value={state.server.qrUrl} />
              <div className="url-box">{state.server.qrUrl}</div>
            </section>
            <h2>Gewinner</h2>
            <History state={state} />
          </aside>
        </section>
      )}
    </main>
  );
}

function AdminNoticeBanner({ notice, tv = false }: { notice: AdminNotice; tv?: boolean }) {
  return (
    <aside className={tv ? "admin-notice-banner tv-admin-notice" : "admin-notice-banner"} role="status" aria-live="polite">
      <strong>{notice.title}</strong>
      <span>{notice.message}</span>
      <small>Bis {formatDateTime(notice.expiresAt)}</small>
    </aside>
  );
}

function TvOnboardingInfo({ onboarding, compact = false }: { onboarding: OnboardingSettings; compact?: boolean }) {
  const columns = getTvOnboardingColumns(onboarding);
  const hasItems = columns.left.length > 0 || columns.right.length > 0;

  return (
    <section className={`tv-onboarding ${compact ? "compact" : ""}`} aria-label="LAN-Infos">
      <p className="muted">LAN-Infos</p>
      <h2>{onboarding.title}</h2>
      {hasItems ? (
        <div className="tv-info-box-grid">
          {(["left", "right"] as const).map((column) => (
            <div className="tv-info-column" key={column}>
              {columns[column].map(({ id, title, value }) => (
                <article className="tv-info-item" key={id}>
                  <h3>{title}</h3>
                  <MarkdownContent value={value} />
                </article>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">Keine Onboarding-Infos hinterlegt.</div>
      )}
    </section>
  );
}

function ActivePollBlock({ state, tv = false }: { state: PublicState; tv?: boolean }) {
  if (!state.activePoll || !state.activeResults) {
    return (
      <>
        <h1>Bereit für die nächste Runde</h1>
        <div className="empty">Im Admin-Bereich kann jederzeit eine neue Abstimmung gestartet werden.</div>
      </>
    );
  }

  return (
    <>
      <p className="muted">Aktuelle Abstimmung</p>
      <h1>{state.activePoll.title}</h1>
      <div className="headline-meta">
        <span>{state.activeResults.totalVotes} Teilnehmer</span>
        <Countdown endsAt={state.activePoll.endsAt} />
      </div>
      <Results results={state.activeResults.options} tv={tv} />
    </>
  );
}

function VoteView({ state }: { state: PublicState }) {
  const [status, setStatus] = useState("");
  const [name, setName] = useState(localStorage.getItem("lanVoteName") || "");
  const [rankings, setRankings] = useState<string[]>([]);
  const [installedOptionIds, setInstalledOptionIds] = useState<string[]>([]);
  const voterId = useMemo(getVoterId, []);
  const myVote = state.activePoll?.votes[voterId];

  useEffect(() => {
    if (!myVote) return;
    if (myVote.rankedChoiceIds.length) setRankings(myVote.rankedChoiceIds.slice(0, 3));
    setInstalledOptionIds(myVote.installedOptionIds || []);
  }, [myVote?.updatedAt]);

  if (!state.activePoll) {
    return (
      <section className="vote-layout">
        <div className="panel">
          <h1>Keine aktive Abstimmung</h1>
          <div className="empty">Sobald eine Runde gestartet wurde, erscheinen hier die Spiele.</div>
          {state.settings.participantPollsEnabled ? <ParticipantPollStarter groupSize={8} /> : null}
        </div>
        <section className="panel"><h2>Letzte Gewinner</h2><History state={state} /></section>
      </section>
    );
  }

  function toggleRanking(optionId: string) {
    setStatus("");
    setRankings((current) => {
      if (current.includes(optionId)) return current.filter((id) => id !== optionId);
      if (current.length >= 3) {
        setStatus("Maximal drei Spiele auswählen.");
        return current;
      }
      return [...current, optionId];
    });
  }

  function toggleInstalled(optionId: string) {
    setInstalledOptionIds((current) => (
      current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId]
    ));
  }

  return (
    <section className="vote-layout">
      <div className="panel">
        <p className="muted">Aktuelle Abstimmung</p>
        <h1>{state.activePoll.title}</h1>
        <div className="headline-meta">
          <Countdown endsAt={state.activePoll.endsAt} />
          <span>Top 3 wählen: Rang 1 zählt am stärksten.</span>
        </div>
        <div className="field-grid">
          <label>
            Dein Name
            <input maxLength={40} value={name} onChange={(event) => setName(event.target.value)} placeholder="z.B. Alex" />
          </label>
          <div className="choice-grid">
            {state.activePoll.options.map((option) => {
              const rank = rankings.indexOf(option.id) + 1;
              const installed = installedOptionIds.includes(option.id);
              const rankingLimitReached = rankings.length >= 3;
              const canAddToRanking = Boolean(rank) || !rankingLimitReached;
              return (
                <article className={`choice-card ${rank ? "selected" : ""}`} key={option.id}>
                  {rank ? <span className="rank-badge">Rang {rank}</span> : null}
                  {option.coverUrl ? <img src={option.coverUrl} alt="" loading="lazy" /> : null}
                  <strong>{option.name}</strong>
                  <span className="muted">{state.activeResults?.options.find((item) => item.id === option.id)?.votes || 0} Punkte bisher</span>
                  <GameMeta game={option} />
                  <label className="checkbox-row install-check">
                    <input type="checkbox" checked={installed} onChange={() => toggleInstalled(option.id)} />
                    <span>Installiert</span>
                  </label>
                  <div className="actions">
                    {option.storeUrl ? <SteamStoreLink href={option.storeUrl} label="Steam Store" /> : null}
                    <button type="button" disabled={!canAddToRanking} onClick={() => toggleRanking(option.id)}>
                      {rank ? "Aus Ranking entfernen" : rankingLimitReached ? "Max. 3 gewählt" : `Als Rang ${rankings.length + 1} wählen`}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="actions">
            <button disabled={!rankings.length} onClick={() => submitVote(rankings, installedOptionIds, voterId, name, setStatus, state.server.monitorUrl)}>Ranking speichern</button>
            {rankings.length ? <span className="muted">{rankings.length} von 3 Rängen ausgewählt.</span> : null}
          </div>
          {status ? <div className="status">{status}</div> : null}
        </div>
      </div>
    </section>
  );
}

function ParticipantPollStarter({ groupSize: initialGroupSize }: { groupSize: number }) {
  const [pool, setPool] = useState<PoolGame[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [title, setTitle] = useState("Was spielen wir als Nächstes?");
  const [durationMinutes, setDurationMinutes] = useState(15);
  const [groupSize, setGroupSize] = useState(initialGroupSize);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Spiel-Pool wird geladen...");

  useEffect(() => {
    let cancelled = false;
    getJson<{ games: PoolGame[] }>("/api/public/games")
      .then((payload) => {
        if (cancelled) return;
        setPool(payload.games);
        setStatus("");
      })
      .catch((error: Error) => {
        if (!cancelled) setStatus(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visiblePool = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("de-DE");
    return pool
      .filter((game) => matchesGroupSize(game, groupSize))
      .filter((game) => {
        if (!normalizedQuery) return true;
        return [game.name, game.note, ...game.tags].join(" ").toLocaleLowerCase("de-DE").includes(normalizedQuery);
      })
      .slice(0, 30);
  }, [groupSize, pool, query]);

  function toggleGame(id: string) {
    setStatus("");
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 12) {
        setStatus("Maximal zwölf Spiele auswählen.");
        return current;
      }
      return [...current, id];
    });
  }

  async function startPoll() {
    try {
      await postJson<PublicState>("/api/participant/polls", { title, gameIds: selectedIds, durationMinutes });
      setStatus("Abstimmung gestartet.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  return (
    <section className="participant-starter">
      <div className="section-title">
        <h2>Neue Abstimmung starten</h2>
        <span className="muted">Für Teilnehmer freigeschaltet</span>
      </div>
      <div className="compact-grid three">
        <label>Titel<input maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Dauer in Minuten<input type="number" min={1} max={120} value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))} /></label>
        <label>Spieleranzahl<input type="number" min={1} max={256} value={groupSize} onChange={(event) => setGroupSize(Number(event.target.value))} /></label>
      </div>
      <label>Suchen<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Spiel im Pool suchen" /></label>
      <div className="participant-game-list">
        {visiblePool.map((game) => (
          <button type="button" className={`participant-game ${selectedIds.includes(game.id) ? "selected" : ""}`} key={game.id} onClick={() => toggleGame(game.id)}>
            <span>
              <strong>{game.name}</strong>
              <small>{formatPlayerRange(game) || "Spielerzahl offen"}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="actions">
        <button type="button" disabled={selectedIds.length < 2} onClick={startPoll}>Abstimmung starten</button>
        <span className="muted">{selectedIds.length} Spiele ausgewählt. Mindestens 2 nötig.</span>
      </div>
      {status ? <div className="status">{status}</div> : null}
    </section>
  );
}

function AdminView({ state, onState }: { state: PublicState; onState: (state: PublicState) => void }) {
  const [title, setTitle] = useState("Was spielen wir als Nächstes?");
  const [games, setGames] = useState<GameDraft[]>(presets.slice(0, 6));
  const [manualGame, setManualGame] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(15);
  const [groupSize, setGroupSize] = useState(8);
  const [templateName, setTemplateName] = useState("Warmup");
  const [adminStatus, setAdminStatus] = useState("");
  const [activeTab, setActiveTab] = useState<AdminTab>("poll");

  async function createPoll() {
    try {
      onState(await postJson<PublicState>("/api/polls", { title, games: games.map(normalizeDraft), durationMinutes }));
      setAdminStatus("Abstimmung gestartet.");
    } catch (error) {
      setAdminStatus((error as Error).message);
    }
  }

  async function saveTemplate() {
    try {
      await postJson<PollTemplate>("/api/templates", { name: templateName, title, durationMinutes, games });
      window.dispatchEvent(new Event("lan-vote-templates-updated"));
      setAdminStatus("Vorlage gespeichert.");
    } catch (error) {
      setAdminStatus((error as Error).message);
    }
  }

  function applyTemplate(template: PollTemplate) {
    setTitle(template.title);
    setDurationMinutes(template.durationMinutes);
    setTemplateName(template.name);
    setGames(template.games.map(snapshotToDraft));
    setAdminStatus(`Vorlage "${template.name}" geladen.`);
    setActiveTab("poll");
  }

  function addPreset(preset: GameDraft) {
    addGameToDraft(preset, preset.name);
  }

  async function addPresetToPool(preset: GameDraft) {
    try {
      await postJson<PoolGame>("/api/games", normalizeDraft(preset));
      window.dispatchEvent(new Event("lan-vote-pool-updated"));
      setAdminStatus(`${preset.name} im Pool gespeichert.`);
    } catch (error) {
      setAdminStatus((error as Error).message);
    }
  }

  function addGameToDraft(game: GameDraft, label = game.name) {
    const nextGames = addDraft(games, game);
    setGames(nextGames);
    setAdminStatus(nextGames === games ? `${label} ist bereits ausgewählt.` : `${label} hinzugefügt.`);
  }

  function togglePoolGame(game: PoolGame) {
    const draft = poolToDraft(game);
    if (isDraftSelected(games, draft)) {
      setGames(removeDraft(games, draft));
      setAdminStatus(`${game.name} aus Abstimmung entfernt.`);
      return;
    }
    addGameToDraft(draft, game.name);
  }

  return (
    <section className="admin-layout">
      <nav className="admin-tabs" aria-label="Adminbereiche">
        {adminTabs.map((tab) => (
          <button type="button" className={activeTab === tab.id ? "active" : ""} key={tab.id} onClick={() => setActiveTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </nav>

      <section className="panel admin-tab-panel">
        {activeTab === "poll" ? (
          <>
            <h1>Abstimmung planen</h1>
            <div className="field-grid">
              <div className="compact-grid three">
                <label>Titel<input maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
                <label>Dauer in Minuten<input type="number" min={0} max={720} value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))} /></label>
                <label>Spieleranzahl<input type="number" min={1} max={256} value={groupSize} onChange={(event) => setGroupSize(Number(event.target.value))} /></label>
              </div>
              {adminStatus ? <div className="status">{adminStatus}</div> : null}
              <GameDraftList games={games} onRemove={(index) => setGames(games.filter((_, itemIndex) => itemIndex !== index))} />
              <div className="actions">
                <button onClick={createPoll}>Abstimmung starten</button>
                <span className="muted">Eine laufende Abstimmung wird dabei abgeschlossen.</span>
              </div>
            </div>
          </>
        ) : null}

        {activeTab === "templates" ? (
          <>
            <TemplateManager onApply={applyTemplate} />
            <div className="template-save">
              <label>Vorlagenname<input maxLength={60} value={templateName} onChange={(event) => setTemplateName(event.target.value)} /></label>
              <button type="button" className="secondary" onClick={saveTemplate}>Aktuelle Auswahl als Vorlage speichern</button>
            </div>
          </>
        ) : null}

        {activeTab === "add-games" ? (
          <>
            <h1>Spiele hinzufügen</h1>
            <div className="field-grid">
              <ManualGameInput value={manualGame} onChange={setManualGame} onAdd={() => {
                const name = manualGame.trim();
                if (name) addGameToDraft({ name, note: "", minPlayers: null, maxPlayers: null, tags: [] }, name);
                setManualGame("");
              }} />
              <SteamSearch onAddToPoll={(game) => addGameToDraft(game)} />
              <SteamTopMultiplayer onAddToPoll={(game) => addGameToDraft(game)} />
              <div>
                <h2>LAN-Klassiker</h2>
                <div className="preset-grid">
                  {presets.map((preset) => (
                    <article className="preset-card" key={preset.name}>
                      {preset.coverUrl ? <img src={preset.coverUrl} alt="" loading="lazy" /> : null}
                      <strong>{preset.name}</strong>
                      <div className="actions">
                        <button type="button" onClick={() => addPreset(preset)}>Zur Abstimmung</button>
                        <button type="button" className="secondary" onClick={() => addPresetToPool(preset)}>In Pool</button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </>
        ) : null}

        {activeTab === "pool" ? <PoolManager groupSize={groupSize} selectedGames={games} onTogglePoll={togglePoolGame} /> : null}

        {activeTab === "active" ? (
          <>
            <h1>Laufende Abstimmung</h1>
            {state.activePoll && state.activeResults ? (
              <>
                <strong>{state.activePoll.title}</strong>
                <div className="headline-meta">
                  <span>{state.activeResults.totalVotes} Teilnehmer</span>
                  <Countdown endsAt={state.activePoll.endsAt} />
                </div>
                <Results results={state.activeResults.options} />
                <div className="actions">
                  {getTieBreakerOptions(state.activeResults.options).length > 1 ? (
                    <button type="button" onClick={() => startTieBreaker(onState)}>Stichwahl starten</button>
                  ) : null}
                  <button className="secondary" onClick={() => closePoll(onState)}>Abstimmung abschließen</button>
                </div>
              </>
            ) : <div className="empty">Aktuell ist keine Abstimmung aktiv.</div>}
          </>
        ) : null}

        {activeTab === "onboarding" ? (
          <>
            <h1>Onboarding</h1>
            <OnboardingAdmin initial={state.onboarding} />
          </>
        ) : null}

        {activeTab === "notice" ? (
          <>
            <h1>Meldung</h1>
            <AdminNoticeManager current={state.adminNotice} onState={onState} />
          </>
        ) : null}

        {activeTab === "history" ? (
          <>
            <h1>Historie</h1>
            <History state={state} onDelete={(entry) => deleteHistoryEntry(entry.pollId, entry.title, onState)} />
            <div className="actions"><button className="danger" onClick={() => clearHistory(onState)}>Historie leeren</button></div>
          </>
        ) : null}

        {activeTab === "settings" ? (
          <>
            <h1>Einstellungen</h1>
            <SettingsAdmin initial={state.settings} />
          </>
        ) : null}
      </section>
    </section>
  );
}

function ManualGameInput({ value, onChange, onAdd }: { value: string; onChange: (value: string) => void; onAdd: () => void }) {
  return (
    <label>
      Spiel manuell hinzufügen
      <div className="inline-search">
        <input value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onAdd();
          }
        }} placeholder="Spielname" />
        <button type="button" className="secondary" onClick={onAdd}>Hinzufügen</button>
      </div>
    </label>
  );
}

function TemplateManager({ onApply }: { onApply: (template: PollTemplate) => void }) {
  const [templates, setTemplates] = useState<PollTemplate[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    loadTemplates();
    window.addEventListener("lan-vote-templates-updated", loadTemplates);
    return () => window.removeEventListener("lan-vote-templates-updated", loadTemplates);
  }, []);

  async function loadTemplates() {
    try {
      const payload = await getJson<{ templates: PollTemplate[] }>("/api/templates");
      setTemplates(payload.templates);
      setStatus("");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function remove(template: PollTemplate) {
    if (!confirm(`Vorlage "${template.name}" wirklich löschen?`)) return;
    try {
      await deleteJson(`/api/templates/${encodeURIComponent(template.id)}`);
      setStatus(`Vorlage "${template.name}" gelöscht.`);
      await loadTemplates();
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  return (
    <section className="template-manager">
      <div className="section-title">
        <h2>Abstimmungsvorlagen</h2>
        <button type="button" className="secondary" onClick={loadTemplates}>Aktualisieren</button>
      </div>
      {status ? <div className="muted">{status}</div> : null}
      {!templates.length ? <div className="empty">Noch keine Vorlagen gespeichert.</div> : (
        <div className="template-list">
          {templates.map((template) => (
            <article className="template-row" key={template.id}>
              <div>
                <strong>{template.name}</strong>
                <span className="muted">{template.title} | {template.durationMinutes} Min. | {template.games.length} Spiele</span>
              </div>
              <button type="button" onClick={() => onApply(template)}>Laden</button>
              <button type="button" className="danger" onClick={() => remove(template)}>Vorlage löschen</button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function GameDraftList({ games, onRemove }: { games: GameDraft[]; onRemove: (index: number) => void }) {
  if (!games.length) return <div className="empty">Noch keine Spiele für die Abstimmung ausgewählt.</div>;
  return (
    <div className="draft-list">
      {games.map((game, index) => (
        <article className={`draft-row ${game.coverUrl ? "" : "no-cover"}`} key={`${game.name}-${index}`}>
          {game.coverUrl ? <img src={game.coverUrl} alt="" loading="lazy" /> : null}
          <div>
            <strong>{game.name}</strong>
            <span className="muted">{game.steamAppId ? `Steam AppID ${game.steamAppId}` : "Manuell"}</span>
            <GameMeta game={game} />
            <div className="actions">
              <button type="button" className="secondary compact-button" onClick={() => onRemove(index)}>Entfernen</button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

function SteamSearch({ onAddToPoll }: { onAddToPoll: (game: GameDraft) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SteamSearchResult[]>([]);
  const [status, setStatus] = useState("");

  async function search() {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setStatus("Mindestens zwei Zeichen eingeben.");
      return;
    }

    setStatus("Suche läuft...");
    try {
      const payload = await getJson<{ results: SteamSearchResult[] }>(`/api/steam/search?q=${encodeURIComponent(trimmed)}&limit=12`);
      setResults(payload.results);
      setStatus(payload.results.length ? "" : "Keine Treffer.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function addToPool(game: SteamSearchResult) {
    try {
      const details = await getSteamDetails(game.appid);
      await postJson<PoolGame>("/api/games", detailsToDraft(details));
      window.dispatchEvent(new Event("lan-vote-pool-updated"));
      setStatus("Spiel im Pool gespeichert.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  return (
    <section className="steam-search">
      <label>
        Steam-Suche
        <div className="inline-search">
          <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              search();
            }
          }} placeholder="Spielname suchen" />
          <button type="button" className="secondary" onClick={search}>Suchen</button>
        </div>
      </label>
      {status ? <div className="muted">{status}</div> : null}
      {results.length ? (
        <div className="steam-results">
          {results.map((game) => (
            <article className="steam-result-card" key={game.appid}>
              <img src={game.coverUrl} alt="" loading="lazy" />
              <strong>{game.name}</strong>
              <span className="muted">AppID {game.appid}</span>
              <div className="actions">
                <button type="button" onClick={async () => onAddToPoll(detailsToDraft(await getSteamDetails(game.appid)))}>Zur Abstimmung</button>
                <button type="button" className="secondary" onClick={() => addToPool(game)}>In Pool</button>
                <SteamStoreLink href={game.storeUrl} label="Store" />
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SteamTopMultiplayer({ onAddToPoll }: { onAddToPoll: (game: GameDraft) => void }) {
  const [games, setGames] = useState<SteamTopGame[]>([]);
  const [status, setStatus] = useState("Steam-Topliste wird geladen...");

  useEffect(() => {
    let cancelled = false;
    getJson<{ results: SteamTopGame[] }>("/api/steam/top-multiplayer?limit=20")
      .then((payload) => {
        if (cancelled) return;
        setGames(payload.results);
        setStatus(payload.results.length ? "Einmal pro Containerstart von Steam geladen." : "Keine Top-Multiplayer-Spiele gefunden.");
      })
      .catch((error: Error) => {
        if (!cancelled) setStatus(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function addToPoll(game: SteamTopGame) {
    setStatus(`${game.name} wird geladen...`);
    try {
      onAddToPoll(detailsToDraft(await getSteamDetails(game.appid)));
      setStatus(`${game.name} hinzugefügt.`);
    } catch (error) {
      onAddToPoll(topGameToDraft(game));
      setStatus(`${game.name} ohne Steam-Details hinzugefügt: ${(error as Error).message}`);
    }
  }

  async function addToPool(game: SteamTopGame) {
    setStatus(`${game.name} wird gespeichert...`);
    try {
      const draft = detailsToDraft(await getSteamDetails(game.appid));
      await postJson<PoolGame>("/api/games", draft);
      window.dispatchEvent(new Event("lan-vote-pool-updated"));
      setStatus(`${game.name} im Pool gespeichert.`);
    } catch (error) {
      try {
        await postJson<PoolGame>("/api/games", topGameToDraft(game));
        window.dispatchEvent(new Event("lan-vote-pool-updated"));
        setStatus(`${game.name} ohne Steam-Details im Pool gespeichert: ${(error as Error).message}`);
      } catch (fallbackError) {
        setStatus((fallbackError as Error).message);
      }
    }
  }

  return (
    <section className="steam-top-games">
      <div className="section-heading">
        <h2>Schnellauswahl: Steam Top-Multiplayer</h2>
        <span className="muted">Top 20 nach Steam-Charts</span>
      </div>
      {status ? <div className="muted">{status}</div> : null}
      {games.length ? (
        <div className="top-game-grid">
          {games.map((game) => (
            <article className="top-game-card" key={game.appid}>
              <img src={game.coverUrl} alt="" loading="lazy" />
              <div>
                <strong>#{game.rank} {game.name}</strong>
                <span className="muted">{game.peakPlayers ? `24h-Peak ${formatNumber(game.peakPlayers)}` : `AppID ${game.appid}`}</span>
              </div>
              <div className="actions">
                <button type="button" onClick={() => addToPoll(game)}>Zur Abstimmung</button>
                <button type="button" className="secondary" onClick={() => addToPool(game)}>In Pool</button>
                <SteamStoreLink href={game.storeUrl} label="Store" />
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function PoolManager({ groupSize, selectedGames, onTogglePoll }: { groupSize: number; selectedGames: GameDraft[]; onTogglePoll: (game: PoolGame) => void }) {
  const [games, setGames] = useState<PoolGame[]>([]);
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<GameDraft>(emptyPoolDraft());
  const [poolSearch, setPoolSearch] = useState("");
  const [poolTag, setPoolTag] = useState("");
  const [poolPlayerFilter, setPoolPlayerFilter] = useState<PoolPlayerFilter>("all");
  const [poolSourceFilter, setPoolSourceFilter] = useState<PoolSourceFilter>("all");
  const [onlyGroupFit, setOnlyGroupFit] = useState(true);

  useEffect(() => {
    loadPool();
    window.addEventListener("lan-vote-pool-updated", loadPool);
    return () => window.removeEventListener("lan-vote-pool-updated", loadPool);
  }, []);

  async function loadPool() {
    try {
      const payload = await getJson<{ games: PoolGame[] }>("/api/games");
      setGames(payload.games);
      setStatus("");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function save() {
    try {
      const enriched = await enrichDraftFromSteam(editing);
      const saved = await postJson<PoolGame>("/api/games", enriched);
      setEditing(emptyPoolDraft());
      setStatus(`${saved.name} gespeichert.`);
      await loadPool();
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function remove(id: string) {
    await fetch(`/api/games/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadPool();
  }

  const poolTags = useMemo(
    () => [...new Set(games.flatMap((game) => game.tags))].sort((a, b) => a.localeCompare(b, "de-DE")),
    [games]
  );
  const visibleGames = useMemo(
    () => games.filter((game) => matchesPoolFilters(game, {
      groupSize,
      onlyGroupFit,
      playerFilter: poolPlayerFilter,
      query: poolSearch,
      sourceFilter: poolSourceFilter,
      tag: poolTag
    })),
    [games, groupSize, onlyGroupFit, poolPlayerFilter, poolSearch, poolSourceFilter, poolTag]
  );

  return (
    <section className="pool-manager">
      <div className="section-title">
        <h2>Spiel-Pool</h2>
        <button type="button" className="secondary" onClick={loadPool}>Aktualisieren</button>
      </div>
      <PoolEditor draft={editing} onChange={setEditing} onSave={save} />
      {status ? <div className="muted">{status}</div> : null}
      <div className="pool-filters" aria-label="Spiel-Pool filtern">
        <label>Suchen<input value={poolSearch} onChange={(event) => setPoolSearch(event.target.value)} placeholder="Name, Notiz, Tag" /></label>
        <label>Tag / Genre<select value={poolTag} onChange={(event) => setPoolTag(event.target.value)}>
          <option value="">Alle Tags</option>
          {poolTags.map((tag) => <option value={tag} key={tag}>{tag}</option>)}
        </select></label>
        <label>Spieler<select value={poolPlayerFilter} onChange={(event) => setPoolPlayerFilter(event.target.value as PoolPlayerFilter)}>
          <option value="all">Alle Spielerbereiche</option>
          <option value="2-4">2-4 Spieler</option>
          <option value="5-8">5-8 Spieler</option>
          <option value="9-16">9-16 Spieler</option>
          <option value="17+">17+ Spieler</option>
        </select></label>
        <label>Quelle<select value={poolSourceFilter} onChange={(event) => setPoolSourceFilter(event.target.value as PoolSourceFilter)}>
          <option value="all">Alle Quellen</option>
          <option value="steam">Steam</option>
          <option value="manual">Nicht-Steam / manuell</option>
        </select></label>
        <label className="checkbox-row pool-fit-filter">
          <input type="checkbox" checked={onlyGroupFit} onChange={(event) => setOnlyGroupFit(event.target.checked)} />
          <span>Passend für {groupSize} Spieler</span>
        </label>
        <button type="button" className="secondary" onClick={() => {
          setPoolSearch("");
          setPoolTag("");
          setPoolPlayerFilter("all");
          setPoolSourceFilter("all");
          setOnlyGroupFit(true);
        }}>Filter zurücksetzen</button>
        <span className="muted">{visibleGames.length} von {games.length} Spielen</span>
      </div>
      {!visibleGames.length ? <div className="empty">Keine passenden Spiele im Pool. Prüfe Spielerzahl oder füge Spiele hinzu.</div> : (
        <div className="pool-list">
          {visibleGames.map((game) => {
            const selected = isDraftSelected(selectedGames, poolToDraft(game));
            return (
              <article className={`pool-row ${game.coverUrl ? "" : "no-cover"} ${selected ? "selected" : ""}`} key={game.id}>
                {game.coverUrl ? <img src={game.coverUrl} alt="" loading="lazy" /> : null}
                <div>
                  <strong>{game.name}</strong>
                  <span className="muted">{game.note || (game.steamAppId ? `Steam AppID ${game.steamAppId}` : "Manuell")}</span>
                  {selected ? <span className="status-pill">In Abstimmung</span> : null}
                  <GameMeta game={game} />
                </div>
                <button type="button" className={selected ? "secondary" : ""} onClick={() => onTogglePoll(game)}>{selected ? "Aus Abstimmung entfernen" : "Zur Abstimmung"}</button>
                <button type="button" className="secondary" onClick={() => setEditing(poolToDraft(game))}>Bearbeiten</button>
                <button type="button" className="danger" onClick={() => remove(game.id)}>Löschen</button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function PoolEditor({ draft, onChange, onSave }: { draft: GameDraft; onChange: (draft: GameDraft) => void; onSave: () => void }) {
  return (
    <div className="pool-editor">
      <label>Name<input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} placeholder="Spielname" /></label>
      <label>Notiz<input value={draft.note} onChange={(event) => onChange({ ...draft, note: event.target.value })} placeholder="z.B. Einsteigerfreundlich" /></label>
      <div className="compact-grid">
        <label>Min<input type="number" min={1} max={256} value={draft.minPlayers || ""} onChange={(event) => onChange({ ...draft, minPlayers: numberOrNull(event.target.value) })} /></label>
        <label>Max<input type="number" min={1} max={256} value={draft.maxPlayers || ""} onChange={(event) => onChange({ ...draft, maxPlayers: numberOrNull(event.target.value) })} /></label>
      </div>
      <label>Tags<input value={(draft.tags || []).join(", ")} onChange={(event) => onChange({ ...draft, tags: tagTextToArray(event.target.value) })} placeholder="Koop, Kurz, Party" /></label>
      <label>Steam AppID<input type="number" min={1} value={draft.steamAppId || ""} onChange={(event) => onChange({ ...draft, steamAppId: numberOrNull(event.target.value) })} /></label>
      <label>Cover-URL<input value={draft.coverUrl || ""} onChange={(event) => onChange({ ...draft, coverUrl: event.target.value })} /></label>
      <label>Store-Link<input value={draft.storeUrl || ""} onChange={(event) => onChange({ ...draft, storeUrl: event.target.value })} /></label>
      <label>Release<input value={draft.releaseDate || ""} onChange={(event) => onChange({ ...draft, releaseDate: event.target.value })} placeholder="z.B. 14. Sep. 2004" /></label>
      <div className="actions">
        <button type="button" className="secondary" onClick={onSave}>Spiel speichern</button>
        <button type="button" className="secondary" onClick={() => onChange(emptyPoolDraft())}>Leeren</button>
      </div>
    </div>
  );
}

function OnboardingAdmin({ initial }: { initial: OnboardingSettings }) {
  const [settings, setSettings] = useState(initial);
  const [status, setStatus] = useState("");
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
  const [imageStatus, setImageStatus] = useState("");

  useEffect(() => setSettings(initial), [initial]);
  useEffect(() => {
    void loadUploadedImages();
  }, []);

  async function save() {
    try {
      await saveSettings(settings);
      setStatus("Onboarding gespeichert.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function saveSettings(nextSettings: OnboardingSettings) {
    const saved = await putJson<OnboardingSettings>("/api/onboarding", nextSettings);
    setSettings(saved);
    return saved;
  }

  async function loadUploadedImages() {
    try {
      const response = await getJson<UploadedImagesResponse>("/api/uploads/images");
      setUploadedImages(response.images);
    } catch (error) {
      setImageStatus((error as Error).message);
    }
  }

  async function deleteUploadedImage(image: UploadedImage) {
    const label = image.referenced ? "Dieses Bild wird in den Onboarding-Texten verwendet. Referenzen werden entfernt und gespeichert." : "Dieses Bild wird gelöscht.";
    if (!window.confirm(`${label}\n\n${image.filename}`)) return;
    try {
      setImageStatus(`${image.filename} wird gelöscht...`);
      const cleanedSettings = removeImageFromOnboarding(settings, image.url);
      if (onboardingSettingsChanged(settings, cleanedSettings)) await saveSettings(cleanedSettings);
      await deleteJson(`/api/uploads/images/${encodeURIComponent(image.filename)}`);
      await loadUploadedImages();
      setImageStatus(`${image.filename} gelöscht.`);
    } catch (error) {
      setImageStatus((error as Error).message);
    }
  }

  async function deleteOrphanedImages() {
    if (!window.confirm("Alle Uploads löschen, die in keinem Onboarding-Feld mehr referenziert werden?")) return;
    try {
      setImageStatus("Verwaiste Bilder werden gelöscht...");
      await saveSettings(settings);
      const response = await deleteJson<{ deleted: string[] }>("/api/uploads/images/orphans");
      await loadUploadedImages();
      setImageStatus(response.deleted.length ? `${response.deleted.length} verwaiste Bilder gelöscht.` : "Keine verwaisten Bilder gefunden.");
    } catch (error) {
      setImageStatus((error as Error).message);
    }
  }

  function addSection() {
    const id = createClientId();
    setSettings({
      ...settings,
      sections: [...settings.sections, { id, title: "Neue Kategorie", content: "" }],
      categoryOrder: [...getOnboardingCategoryOrder(settings), id],
      tvLayout: addTvLayoutItem(settings.tvLayout, id, "right")
    });
  }

  function updateSection(id: string, patch: Partial<OnboardingSection>) {
    setSettings({
      ...settings,
      sections: settings.sections.map((section) => section.id === id ? { ...section, ...patch } : section)
    });
  }

  function removeSection(id: string) {
    const section = settings.sections.find((item) => item.id === id);
    if (section && !window.confirm(`Kategorie "${section.title || "Ohne Titel"}" löschen?`)) return;
    setSettings({
      ...settings,
      sections: settings.sections.filter((item) => item.id !== id),
      categoryOrder: getOnboardingCategoryOrder(settings).filter((item) => item !== id),
      tvLayout: removeTvLayoutItem(settings.tvLayout, id)
    });
  }

  function moveCategory(id: string, direction: -1 | 1) {
    const order = getOnboardingCategoryOrder(settings);
    const index = order.indexOf(id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
    const next = [...order];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(nextIndex, 0, item);
    setSettings({ ...settings, categoryOrder: next });
  }

  const categories = getOrderedOnboardingCategoryEntries(settings);
  const tvLayout = getOnboardingTvLayout(settings);

  function moveTvBox(id: string, target: TvLayoutColumn) {
    setSettings({ ...settings, tvLayout: moveTvLayoutItem(settings.tvLayout, id, target) });
  }

  function reorderTvBox(column: TvLayoutColumn, id: string, direction: -1 | 1) {
    setSettings({ ...settings, tvLayout: reorderTvLayoutItem(settings.tvLayout, column, id, direction) });
  }

  return (
    <div className="field-grid">
      <label className="checkbox-row">
        <input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />
        <span>QR-Code zuerst auf LAN-Startseite führen.</span>
      </label>
      <label>Titel<input value={settings.title} onChange={(event) => setSettings({ ...settings, title: event.target.value })} /></label>
      <section className="onboarding-category-manager">
        <div className="section-title">
          <h3>Kategorien</h3>
          <button type="button" className="secondary compact-button" onClick={addSection}>Kategorie hinzufügen</button>
        </div>
        <div className="onboarding-category-list">
          {categories.map((category, index) => (
            <article className="onboarding-category-row" key={category.id}>
              <div className="category-row-header">
                <strong>{category.title}</strong>
                <div className="actions">
                  <button type="button" className="secondary compact-button" disabled={index === 0} onClick={() => moveCategory(category.id, -1)}>Nach oben</button>
                  <button type="button" className="secondary compact-button" disabled={index === categories.length - 1} onClick={() => moveCategory(category.id, 1)}>Nach unten</button>
                  {category.type === "custom" ? <button type="button" className="danger compact-button" onClick={() => removeSection(category.id)}>Löschen</button> : null}
                </div>
              </div>
              {category.type === "default" ? (
                <MarkdownEditor label={category.title} value={settings[category.key]} onChange={(value) => setSettings({ ...settings, [category.key]: value })} onUpload={loadUploadedImages} placeholder={category.placeholder} />
              ) : (
                <>
                  <label>Kategorietitel<input value={category.section.title} onChange={(event) => updateSection(category.id, { title: event.target.value })} placeholder="z.B. Turnierregeln" /></label>
                  <MarkdownEditor label="Inhalt" value={category.section.content} onChange={(content) => updateSection(category.id, { content })} onUpload={loadUploadedImages} placeholder="Markdown-Inhalt für diese Kategorie" />
                </>
              )}
            </article>
          ))}
        </div>
      </section>
      <TvOnboardingLayoutManager categories={categories} layout={tvLayout} onMove={moveTvBox} onReorder={reorderTvBox} />
      <UploadedImageManager images={uploadedImages} status={imageStatus} onRefresh={loadUploadedImages} onDelete={deleteUploadedImage} onDeleteOrphans={deleteOrphanedImages} />
      <div className="actions"><button type="button" className="secondary" onClick={save}>Onboarding speichern</button></div>
      {status ? <div className="status">{status}</div> : null}
    </div>
  );
}

function TvOnboardingLayoutManager({
  categories,
  layout,
  onMove,
  onReorder
}: {
  categories: OrderedOnboardingCategory[];
  layout: OnboardingTvLayout;
  onMove: (id: string, target: TvLayoutColumn) => void;
  onReorder: (column: TvLayoutColumn, id: string, direction: -1 | 1) => void;
}) {
  const labels = new Map(categories.map((category) => [category.id, category.title]));
  const columns: Array<{ id: TvLayoutColumn; title: string }> = [
    { id: "left", title: "TV links" },
    { id: "right", title: "TV rechts" },
    { id: "hidden", title: "Ausgeblendet" }
  ];

  return (
    <section className="tv-layout-manager">
      <div className="section-title">
        <h3>TV-Boxen</h3>
        <span className="muted">Ordnet nur die Onboarding-Boxen im TV-Modus an.</span>
      </div>
      <div className="tv-layout-columns">
        {columns.map((column) => (
          <section className="tv-layout-column" key={column.id}>
            <h4>{column.title}</h4>
            {layout[column.id].length ? (
              <div className="tv-layout-list">
                {layout[column.id].map((categoryId, index) => (
                  <article className="tv-layout-row" key={categoryId}>
                    <strong>{labels.get(categoryId) || categoryId}</strong>
                    <div className="actions">
                      <button type="button" className="secondary compact-button" disabled={index === 0} onClick={() => onReorder(column.id, categoryId, -1)}>Hoch</button>
                      <button type="button" className="secondary compact-button" disabled={index === layout[column.id].length - 1} onClick={() => onReorder(column.id, categoryId, 1)}>Runter</button>
                      {column.id !== "left" ? <button type="button" className="secondary compact-button" onClick={() => onMove(categoryId, "left")}>Links</button> : null}
                      {column.id !== "right" ? <button type="button" className="secondary compact-button" onClick={() => onMove(categoryId, "right")}>Rechts</button> : null}
                      {column.id !== "hidden" ? <button type="button" className="secondary compact-button" onClick={() => onMove(categoryId, "hidden")}>Ausblenden</button> : null}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty">Keine Boxen.</div>
            )}
          </section>
        ))}
      </div>
    </section>
  );
}

function MarkdownEditor({ label, value, onChange, onUpload, placeholder }: { label: string; value: string; onChange: (value: string) => void; onUpload?: () => void | Promise<void>; placeholder?: string }) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadStatus, setUploadStatus] = useState("");

  function replaceSelection(nextText: string, selectionStart: number, selectionEnd: number) {
    onChange(nextText);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  function wrapSelection(prefix: string, suffix = prefix, fallback = "Text") {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || fallback;
    const insertion = `${prefix}${selected}${suffix}`;
    replaceSelection(`${value.slice(0, start)}${insertion}${value.slice(end)}`, start + prefix.length, start + prefix.length + selected.length);
  }

  function prefixLines(prefix: string, fallback = "Text") {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || fallback;
    const lines = selected.split("\n").map((line) => `${prefix}${line || fallback}`).join("\n");
    replaceSelection(`${value.slice(0, start)}${lines}${value.slice(end)}`, start, start + lines.length);
  }

  function insertLink() {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || "Link";
    const url = window.prompt("URL einfügen", "https://");
    if (!url) return;
    const insertion = `[${selected}](${url})`;
    replaceSelection(`${value.slice(0, start)}${insertion}${value.slice(end)}`, start + 1, start + 1 + selected.length);
  }

  async function uploadImage(file: File) {
    setUploadStatus(`${file.name} wird hochgeladen...`);
    try {
      const payload = await fileToUploadPayload(file);
      const uploaded = await postJson<{ url: string }>("/api/uploads/images", payload);
      insertAtCursor(`![](${uploaded.url}) {mitte 100%}`);
      await onUpload?.();
      setUploadStatus(`${file.name} eingefügt.`);
    } catch (error) {
      setUploadStatus((error as Error).message);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function insertAtCursor(markdown: string) {
    const textarea = textareaRef.current;
    const current = textarea?.value ?? value;
    const start = textarea?.selectionStart ?? current.length;
    const end = textarea?.selectionEnd ?? current.length;
    const spacingBefore = start > 0 && !current.slice(0, start).endsWith("\n") ? "\n" : "";
    const spacingAfter = end < current.length && !current.slice(end).startsWith("\n") ? "\n" : "";
    const insertion = `${spacingBefore}${markdown}${spacingAfter}`;
    replaceSelection(`${current.slice(0, start)}${insertion}${current.slice(end)}`, start + insertion.length, start + insertion.length);
  }

  function updateImageLine(update: { align?: MarkdownImageAlign; width?: string }) {
    const textarea = textareaRef.current;
    const current = textarea?.value ?? value;
    const cursor = textarea?.selectionStart ?? current.length;
    const lineStart = current.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
    const nextBreak = current.indexOf("\n", cursor);
    const lineEnd = nextBreak === -1 ? current.length : nextBreak;
    const line = current.slice(lineStart, lineEnd);
    const image = line.match(/^(\s*!\[[^\]]*\]\([^)]+\))(?:\s*\{([^}]*)\})?(\s*)$/);
    if (!image) {
      insertAtCursor(`![](/uploads/bild.png) ${formatMarkdownImageAttributes({ align: update.align || "center", width: update.width })}`);
      return;
    }
    const attributes = parseMarkdownImageAttributes(image[2]);
    const replacement = `${image[1]}${formatMarkdownImageAttributes({ ...attributes, ...update })}${image[3] || ""}`;
    replaceSelection(`${current.slice(0, lineStart)}${replacement}${current.slice(lineEnd)}`, lineStart + replacement.length, lineStart + replacement.length);
  }

  function setCustomImageWidth() {
    const value = window.prompt("Bildbreite, z.B. 120%, 480px oder 150%", "150%");
    const width = normalizeImageSize(value || "");
    if (width) updateImageLine({ width });
  }

  return (
    <div className="markdown-editor">
      <span className="editor-label">{label}</span>
      <div className="markdown-toolbar" aria-label={`${label} formatieren`}>
        <button type="button" className="secondary compact-button" title="Fett" onClick={() => wrapSelection("**", "**", "fetter Text")}><strong>B</strong></button>
        <button type="button" className="secondary compact-button" title="Kursiv" onClick={() => wrapSelection("_", "_", "kursiver Text")}><em>I</em></button>
        <button type="button" className="secondary compact-button" title="Überschrift" onClick={() => prefixLines("## ", "Überschrift")}>H2</button>
        <button type="button" className="secondary compact-button" title="Liste" onClick={() => prefixLines("- ")}>•</button>
        <button type="button" className="secondary compact-button" title="Nummerierte Liste" onClick={() => prefixLines("1. ")}>1.</button>
        <button type="button" className="secondary compact-button" title="Zitat" onClick={() => prefixLines("> ")}>“”</button>
        <button type="button" className="secondary compact-button" title="Code" onClick={() => wrapSelection("`", "`", "code")}>{"<>"}</button>
        <button type="button" className="secondary compact-button" title="Link" onClick={insertLink}>Link</button>
        <button type="button" className="secondary compact-button" title="Bild ohne Bildunterschrift hochladen" onClick={() => fileInputRef.current?.click()}>Bild</button>
        <button type="button" className="secondary compact-button" title="Bild links ausrichten" onClick={() => updateImageLine({ align: "left" })}>← Bild</button>
        <button type="button" className="secondary compact-button" title="Bild mittig ausrichten" onClick={() => updateImageLine({ align: "center" })}>↔ Bild</button>
        <button type="button" className="secondary compact-button" title="Bild rechts ausrichten" onClick={() => updateImageLine({ align: "right" })}>Bild →</button>
        <button type="button" className="secondary compact-button" title="Bild auf 25 Prozent Breite setzen" onClick={() => updateImageLine({ width: "25%" })}>25%</button>
        <button type="button" className="secondary compact-button" title="Bild auf 50 Prozent Breite setzen" onClick={() => updateImageLine({ width: "50%" })}>50%</button>
        <button type="button" className="secondary compact-button" title="Bild auf 75 Prozent Breite setzen" onClick={() => updateImageLine({ width: "75%" })}>75%</button>
        <button type="button" className="secondary compact-button" title="Bild auf volle Breite setzen" onClick={() => updateImageLine({ width: "100%" })}>100%</button>
        <button type="button" className="secondary compact-button" title="Bild auf 125 Prozent Breite setzen" onClick={() => updateImageLine({ width: "125%" })}>125%</button>
        <button type="button" className="secondary compact-button" title="Bild auf 150 Prozent Breite setzen" onClick={() => updateImageLine({ width: "150%" })}>150%</button>
        <button type="button" className="secondary compact-button" title="Bild auf 200 Prozent Breite setzen" onClick={() => updateImageLine({ width: "200%" })}>200%</button>
        <button type="button" className="secondary compact-button" title="Freie Bildbreite setzen" onClick={setCustomImageWidth}>Breite...</button>
      </div>
      <textarea ref={textareaRef} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        if (file) void uploadImage(file);
      }} />
      {uploadStatus ? <span className="muted">{uploadStatus}</span> : null}
    </div>
  );
}

function UploadedImageManager({
  images,
  status,
  onRefresh,
  onDelete,
  onDeleteOrphans
}: {
  images: UploadedImage[];
  status: string;
  onRefresh: () => void | Promise<void>;
  onDelete: (image: UploadedImage) => void | Promise<void>;
  onDeleteOrphans: () => void | Promise<void>;
}) {
  const orphanCount = images.filter((image) => !image.referenced).length;

  return (
    <section className="upload-manager">
      <div className="section-title">
        <h3>Hochgeladene Bilder</h3>
        <div className="actions">
          <button type="button" className="secondary compact-button" onClick={() => void onRefresh()}>Aktualisieren</button>
          <button type="button" className="danger compact-button" disabled={orphanCount === 0} onClick={() => void onDeleteOrphans()}>Verwaiste löschen</button>
        </div>
      </div>
      {status ? <span className="muted">{status}</span> : null}
      {images.length ? (
        <div className="upload-list">
          {images.map((image) => (
            <article className="upload-row" key={image.filename}>
              <img src={image.url} alt="" loading="lazy" />
              <div>
                <strong>{image.filename}</strong>
                <span className="muted">{image.referenced ? "Wird verwendet" : "Verwaist"} | {formatBytes(image.size)} | {formatDateTime(image.modifiedAt)}</span>
                <span className="copyable-link"><a href={image.url} target="_blank" rel="noreferrer">{image.url}</a><CopyUrlButton url={new URL(image.url, location.origin).href} /></span>
              </div>
              <button type="button" className="danger" onClick={() => void onDelete(image)}>Löschen</button>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty">Noch keine Bilder hochgeladen.</div>
      )}
    </section>
  );
}

function AdminNoticeManager({ current, onState }: { current: AdminNotice | null; onState: (state: PublicState) => void }) {
  const [title, setTitle] = useState(current?.title || "");
  const [message, setMessage] = useState(current?.message || "");
  const [expiresAt, setExpiresAt] = useState(formatGermanDateTimeInput(current?.expiresAt || defaultNoticeExpiry()));
  const [status, setStatus] = useState("");

  useEffect(() => {
    setTitle(current?.title || "");
    setMessage(current?.message || "");
    setExpiresAt(formatGermanDateTimeInput(current?.expiresAt || defaultNoticeExpiry()));
  }, [current?.id]);

  async function publish() {
    try {
      const parsedExpiresAt = parseGermanDateTimeInput(expiresAt);
      if (!parsedExpiresAt) {
        setStatus("Bitte Datum und Uhrzeit im Format TT.MM.JJJJ HH:mm eingeben.");
        return;
      }
      const notice = await postJson<AdminNotice>("/api/admin-notice", {
        title,
        message,
        expiresAt: parsedExpiresAt.toISOString()
      });
      setStatus(`Meldung "${notice.title}" veröffentlicht.`);
      onState(await fetchState());
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function remove() {
    try {
      await deleteJson("/api/admin-notice");
      setStatus("Meldung entfernt.");
      setTitle("");
      setMessage("");
      setExpiresAt(formatGermanDateTimeInput(defaultNoticeExpiry()));
      onState(await fetchState());
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  return (
    <section className="notice-manager">
      {current ? <AdminNoticeBanner notice={current} /> : <div className="empty">Aktuell ist keine Admin-Meldung aktiv.</div>}
      <div className="compact-grid">
        <label>Titel<input maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="z.B. Pizza ist da" /></label>
        <label>Sichtbar bis<input value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} placeholder="26.05.2026 18:30" /></label>
      </div>
      <label>Nachricht<textarea maxLength={800} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Kurze Info für TV und Besucher" /></label>
      <div className="actions">
        <button type="button" disabled={!title.trim() || !message.trim() || !expiresAt} onClick={publish}>Meldung anzeigen</button>
        <button type="button" className="secondary" disabled={!current} onClick={remove}>Meldung entfernen</button>
      </div>
      {status ? <div className="status">{status}</div> : null}
    </section>
  );
}

function SettingsAdmin({ initial }: { initial: AppSettings }) {
  const [settings, setSettings] = useState(initial);
  const [status, setStatus] = useState("");

  useEffect(() => setSettings(initial), [initial]);

  async function save() {
    try {
      const saved = await putJson<AppSettings>("/api/settings", settings);
      setSettings(saved);
      setStatus("Einstellungen gespeichert.");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  return (
    <div className="field-grid">
      <label className="checkbox-row settings-row">
        <input type="checkbox" checked={settings.participantPollsEnabled} onChange={(event) => setSettings({ ...settings, participantPollsEnabled: event.target.checked })} />
        <span>Teilnehmer dürfen Abstimmungen aus dem Spiel-Pool starten, wenn aktuell keine Abstimmung läuft.</span>
      </label>
      <div className="actions"><button type="button" className="secondary" onClick={save}>Einstellungen speichern</button></div>
      {status ? <div className="status">{status}</div> : null}
    </div>
  );
}

function QrCode({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, value, { width: 320, margin: 1, color: { dark: "#000000", light: "#ffffff" } });
    }
  }, [value]);
  return <div className="qr-frame"><canvas ref={canvasRef} width={320} height={320} aria-label="QR-Code" /></div>;
}

function SteamStoreLink({ href, label, className }: { href: string; label: string; className?: string }) {
  return (
    <a className={className ? `steam-link ${className}` : "steam-link"} href={href} target="_blank" rel="noreferrer">
      <svg className="steam-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <circle cx="15.5" cy="8.5" r="2.8" />
        <circle cx="8" cy="15.2" r="2.4" />
        <path d="M10.1 14.1l3.3-3.6" />
        <path d="M5.8 14.2l2.4 1" />
      </svg>
      <span>{label}</span>
    </a>
  );
}

function Results({ results, tv = false }: { results: ResultOption[]; tv?: boolean }) {
  const sorted = [...results].sort((a, b) => b.votes - a.votes || b.firstPlaceVotes - a.firstPlaceVotes || b.readyVotes - a.readyVotes || a.name.localeCompare(b.name));
  const tieBreakerOptions = getTieBreakerOptions(results);
  return (
    <div className={`result-list ${tv ? "tv-results" : ""}`}>
      {tieBreakerOptions.length > 1 ? (
        <div className="tie-breaker-note">Gleichstand: {tieBreakerOptions.map((option) => option.name).join(" vs. ")}</div>
      ) : null}
      {sorted.map((option) => (
        <article className={`result-row ${option.coverUrl ? "with-cover" : ""}`} key={option.id}>
          <div className="result-top">
            <span className="result-name">{option.name}</span>
            <span className="result-count">{option.votes} Punkte | {option.firstPlaceVotes}x Rang 1 | {option.readyVotes} installiert</span>
          </div>
          {option.coverUrl ? <img className="result-cover" src={option.coverUrl} alt="" loading="lazy" /> : null}
          <div className="bar"><span style={{ width: `${Math.max(option.percent, option.votes > 0 ? 3 : 0)}%` }} /></div>
          <div className="ready-bar"><span style={{ width: `${Math.max(option.readyPercent, option.readyVotes > 0 ? 3 : 0)}%` }} /></div>
          <GameMeta game={option} padded />
          {option.voters.length ? (
            <div className="voter-list" aria-label={`Teilnehmer für ${option.name}`}>
              {option.voters.map((voter, index) => (
                <span className={voter.isInstalled ? "voter-chip ready" : "voter-chip"} key={`${option.id}-${voter.name}-${voter.rank}-${index}`}>
                  #{voter.rank} {voter.name || "Spieler"}{voter.isInstalled ? " · installiert" : ""}
                </span>
              ))}
            </div>
          ) : null}
          {option.storeUrl ? <SteamStoreLink href={option.storeUrl} label="Steam Store" className="store-link" /> : null}
        </article>
      ))}
    </div>
  );
}

function getTieBreakerOptions(results: ResultOption[]): ResultOption[] {
  const maxVotes = Math.max(0, ...results.map((option) => option.votes));
  if (maxVotes <= 0) return [];
  return results
    .filter((option) => option.votes === maxVotes)
    .sort((a, b) => a.name.localeCompare(b.name, "de-DE"));
}

function History({ state, onDelete }: { state: PublicState; onDelete?: (entry: PublicState["history"][number]) => void }) {
  if (!state.history.length) return <div className="empty">Noch keine abgeschlossene Abstimmung.</div>;
  return (
    <div className="history-list">
      {state.history.slice(0, 8).map((item) => (
        <article className="history-item" key={item.pollId}>
          <strong>{item.title}</strong>
          <span className="winner">{item.winners.length ? item.winners.map((winner) => `${winner.name} (${winner.votes} Punkte)`).join(", ") : "Keine Stimmen"}</span>
          <span className="muted">{item.totalVotes} Teilnehmer | {formatDate(item.closedAt)}</span>
          {onDelete ? (
            <div className="actions">
              <button type="button" className="danger compact-button" onClick={() => onDelete(item)}>Abstimmung löschen</button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function GameMeta({ game, padded = false }: { game: Pick<GameDraft, "note" | "releaseDate" | "minPlayers" | "maxPlayers" | "tags">; padded?: boolean }) {
  const tags = (game.tags || []).filter(Boolean);
  const genre = game.note?.trim() || inferGenreFromTags(tags);
  return (
    <div className={`game-meta ${padded ? "padded" : ""}`}>
      <div className="game-meta-row">
        <span>Genre</span>
        <strong>{genre || "Nicht gesetzt"}</strong>
      </div>
      <div className="game-meta-row">
        <span>Release</span>
        <strong>{game.releaseDate || "Nicht gesetzt"}</strong>
      </div>
      <div className="game-meta-row">
        <span>Spieler</span>
        <strong>{formatPlayerRange(game) || "Nicht gesetzt"}</strong>
      </div>
      <div className="game-meta-row">
        <span>Tags</span>
        {tags.length ? <div className="meta-chips">{tags.map((tag) => <strong key={tag}>{tag}</strong>)}</div> : <strong>Keine Tags</strong>}
      </div>
    </div>
  );
}

type MarkdownBlock =
  | { type: "heading"; level: 2 | 3 | 4; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | MarkdownImageBlock
  | { type: "imageRow"; images: MarkdownImageBlock[] };

type MarkdownImageBlock = { type: "image"; alt: string; url: string; align: MarkdownImageAlign; width?: string };
type MarkdownLightboxImage = { alt: string; url: string };

type MarkdownImageAlign = "left" | "center" | "right";
type MarkdownImageAttributes = { align: MarkdownImageAlign; width?: string };

function MarkdownContent({ value, onOpenImage }: { value: string; onOpenImage?: (image: MarkdownLightboxImage) => void }) {
  const blocks = parseMarkdown(value);
  if (!blocks.length) return null;
  return (
    <div className="markdown-content">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const HeadingTag = `h${block.level}` as "h2" | "h3" | "h4";
          return <HeadingTag key={index}><InlineMarkdown text={block.text} onOpenImage={onOpenImage} /></HeadingTag>;
        }
        if (block.type === "list") {
          return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} onOpenImage={onOpenImage} /></li>)}</ul>;
        }
        if (block.type === "image") return <MarkdownImage alt={block.alt} url={block.url} align={block.align} width={block.width} onOpenImage={onOpenImage} key={index} />;
        if (block.type === "imageRow") return <MarkdownImageRow images={block.images} onOpenImage={onOpenImage} key={index} />;
        return <p key={index}><InlineMarkdown text={block.text} onOpenImage={onOpenImage} /></p>;
      })}
    </div>
  );
}

function InlineMarkdown({ text, onOpenImage }: { text: string; onOpenImage?: (image: MarkdownLightboxImage) => void }) {
  return <>{renderInlineMarkdown(text, onOpenImage)}</>;
}

function MarkdownImage({ alt, url, align = "center", width, onOpenImage }: { alt: string; url: string; align?: MarkdownImageAlign; width?: string; onOpenImage?: (image: MarkdownLightboxImage) => void }) {
  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) return <span className="muted">Bild-URL nicht erlaubt: {url}</span>;
  const style = width ? ({ "--markdown-image-width": width } as React.CSSProperties) : undefined;
  const image = <img src={safeUrl} alt={alt} loading="lazy" />;
  return (
    <figure className={`markdown-image align-${align} ${width ? "sized" : ""}`} style={style}>
      {onOpenImage ? (
        <button type="button" className="markdown-image-button" onClick={() => onOpenImage({ alt, url: safeUrl })} title="Bild in Originalgröße öffnen">
          {image}
        </button>
      ) : image}
      {alt ? (
        <figcaption>
          <span>{alt}</span>
          <CopyUrlButton url={safeUrl} />
        </figcaption>
      ) : null}
    </figure>
  );
}

function MarkdownImageRow({ images, onOpenImage }: { images: MarkdownImageBlock[]; onOpenImage?: (image: MarkdownLightboxImage) => void }) {
  const align = images[0]?.align || "center";
  return (
    <div className={`markdown-image-row align-${align}`}>
      {images.map((image, index) => <MarkdownImage alt={image.alt} url={image.url} align={image.align} width={image.width} onOpenImage={onOpenImage} key={`${image.url}-${index}`} />)}
    </div>
  );
}

function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await copyText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return <button type="button" className="copy-url" onClick={copy}>{copied ? "Kopiert" : "URL kopieren"}</button>;
}

function parseMarkdown(value: string): MarkdownBlock[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];

  function flushParagraph() {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join("\n").trim() });
      paragraph = [];
    }
  }

  function flushList() {
    if (listItems.length) {
      blocks.push({ type: "list", items: listItems });
      listItems = [];
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const imageRow = parseMarkdownImageRow(trimmed);
    if (imageRow) {
      flushParagraph();
      flushList();
      blocks.push(imageRow.length === 1 ? imageRow[0]! : { type: "imageRow", images: imageRow });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: Math.min(4, heading[1]!.length + 1) as 2 | 3 | 4, text: heading[2]!.trim() });
      continue;
    }

    const list = trimmed.match(/^[-*]\s+(.+)$/);
    if (list) {
      flushParagraph();
      listItems.push(list[1]!.trim());
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function parseMarkdownImageRow(value: string): MarkdownImageBlock[] | null {
  const images: MarkdownImageBlock[] = [];
  const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)\)(?:\s*\{([^}]*)\})?/gy;
  let index = 0;
  while (index < value.length) {
    const whitespace = value.slice(index).match(/^\s+/);
    if (whitespace) index += whitespace[0].length;
    imagePattern.lastIndex = index;
    const match = imagePattern.exec(value);
    if (!match) return null;
    images.push({ type: "image", alt: match[1] || "", url: match[2] || "", ...parseMarkdownImageAttributes(match[3]) });
    index = imagePattern.lastIndex;
  }
  return images.length ? images : null;
}

function renderInlineMarkdown(text: string, onOpenImage?: (image: MarkdownLightboxImage) => void): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|!\[[^\]]*\]\([^\s)]+\)(?:\s*\{[^}\n]+\})?|\[[^\]]+\]\([^\s)]+\)|https?:\/\/[^\s<)]+)/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text))) {
    appendPlainText(nodes, text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${match.index}-${token}`;

    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(token.slice(2, -2), onOpenImage)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{renderInlineMarkdown(token.slice(1, -1), onOpenImage)}</em>);
    } else if (token.startsWith("![")) {
      const image = token.match(/^!\[([^\]]*)\]\(([^)]+)\)(?:\s*\{([^}]*)\})?$/i);
      if (image) nodes.push(<MarkdownImage key={key} alt={image[1] || ""} url={image[2] || ""} onOpenImage={onOpenImage} {...parseMarkdownImageAttributes(image[3])} />);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const label = link ? link[1]! : token;
      const url = link ? link[2]! : token;
      const safeUrl = safeHttpUrl(url);
      nodes.push(
        safeUrl ? (
          <span className="copyable-link" key={key}>
            <a href={safeUrl} target="_blank" rel="noreferrer">{label}</a>
            <CopyUrlButton url={safeUrl} />
          </span>
        ) : (
          <span className="muted" key={key}>{label}</span>
        )
      );
    }

    lastIndex = match.index + token.length;
  }

  appendPlainText(nodes, text.slice(lastIndex));
  return nodes;
}

function appendPlainText(nodes: React.ReactNode[], text: string): void {
  text.split("\n").forEach((part, index) => {
    if (index > 0) nodes.push(<br key={`br-${nodes.length}-${index}`} />);
    if (part) nodes.push(part);
  });
}

function normalizeImageAlign(value: string | undefined): MarkdownImageAlign {
  const normalized = value?.toLocaleLowerCase("de-DE");
  if (normalized === "links" || normalized === "left") return "left";
  if (normalized === "rechts" || normalized === "right") return "right";
  return "center";
}

function parseMarkdownImageAttributes(value: string | undefined): MarkdownImageAttributes {
  const attributes: MarkdownImageAttributes = { align: "center" };
  value?.split(/[\s,]+/).forEach((rawToken) => {
    const token = rawToken.trim();
    if (!token) return;
    const normalized = token.toLocaleLowerCase("de-DE");
    if (["links", "left", "mitte", "center", "rechts", "right"].includes(normalized)) {
      attributes.align = normalizeImageAlign(token);
      return;
    }
    const size = normalizeImageSize(token.replace(/^(?:breite|größe|groesse|size|width)=/i, ""));
    if (size) attributes.width = size;
  });
  return attributes;
}

function normalizeImageSize(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLocaleLowerCase("de-DE");
  if (!normalized) return undefined;
  if (normalized === "klein" || normalized === "small") return "25%";
  if (normalized === "mittel" || normalized === "medium") return "50%";
  if (normalized === "gross" || normalized === "groß" || normalized === "large") return "75%";
  if (normalized === "voll" || normalized === "full") return "100%";

  const percent = normalized.match(/^(\d{1,3})%$/);
  if (percent) return `${Math.min(200, Math.max(5, Number(percent[1]!)))}%`;

  const pixels = normalized.match(/^(\d{2,4})px$/);
  if (pixels) return `${Math.min(2400, Math.max(80, Number(pixels[1]!)))}px`;

  return undefined;
}

function formatMarkdownImageAttributes(attributes: MarkdownImageAttributes): string {
  const tokens = [markdownImageAlignToken(attributes.align)];
  if (attributes.width) tokens.push(attributes.width);
  return `{${tokens.join(" ")}}`;
}

function markdownImageAlignToken(align: MarkdownImageAlign): string {
  if (align === "left") return "links";
  if (align === "right") return "rechts";
  return "mitte";
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value, location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

async function copyText(value: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    throw new Error("Clipboard API nicht verfügbar.");
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function Countdown({ endsAt }: { endsAt: string | null }) {
  const now = useNow();
  if (!endsAt) return <span className="timer">Kein Timer</span>;
  const remaining = Date.parse(endsAt) - now;
  if (remaining <= 0) return <span className="timer danger-text">Abgeschlossen</span>;
  return <span className="timer">{formatDuration(remaining)}</span>;
}

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

async function fetchState(): Promise<PublicState> {
  return getJson<PublicState>("/api/state");
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Anfrage fehlgeschlagen.");
  return payload;
}

async function fileToUploadPayload(file: File): Promise<{ filename: string; mimeType: string; data: string }> {
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
    throw new Error("Bitte PNG, JPG, WebP oder GIF hochladen.");
  }
  if (file.size > 4 * 1024 * 1024) throw new Error("Bild darf maximal 4 MB groß sein.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Bild konnte nicht gelesen werden."));
    reader.readAsDataURL(file);
  });
  const [, data = ""] = dataUrl.split(",", 2);
  return { filename: file.name, mimeType: file.type, data };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Anfrage fehlgeschlagen.");
  return payload;
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Anfrage fehlgeschlagen.");
  return payload;
}

async function deleteJson<T = void>(url: string): Promise<T> {
  const response = await fetch(url, { method: "DELETE" });
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  const payload = await response.json().catch(() => ({ error: "Löschen fehlgeschlagen." }));
  throw new Error(payload.error || "Löschen fehlgeschlagen.");
}

async function submitVote(
  rankings: string[],
  installedOptionIds: string[],
  voterId: string,
  name: string,
  setStatus: (status: string) => void,
  resultUrl: string
) {
  try {
    localStorage.setItem("lanVoteName", name);
    const isReady = rankings.length > 0 && rankings.every((id) => installedOptionIds.includes(id));
    const result = await postJson<{ voterId: string }>("/api/vote", { voterId, name: name || "Spieler", rankings, installedOptionIds, isReady });
    localStorage.setItem("lanVoteVoterId", result.voterId);
    setStatus("Ranking gespeichert.");
    window.location.assign(resultUrl);
  } catch (error) {
    setStatus((error as Error).message);
  }
}

function normalizeDraft(game: GameDraft): GameDraft {
  return {
    ...game,
    name: game.name.trim(),
    note: game.note?.trim() || "",
    coverUrl: game.coverUrl?.trim() || "",
    storeUrl: game.storeUrl?.trim() || "",
    releaseDate: game.releaseDate?.trim() || "",
    minPlayers: game.minPlayers ?? null,
    maxPlayers: game.maxPlayers ?? null,
    tags: normalizeTags(game.tags || [])
  };
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.slice(0, 28)))].slice(0, 12);
}

async function closePoll(onState: (state: PublicState) => void) {
  const result = await postJson<{ state: PublicState }>("/api/polls/close", {});
  onState(result.state);
}

async function startTieBreaker(onState: (state: PublicState) => void) {
  const state = await postJson<PublicState>("/api/polls/tiebreaker", {});
  onState(state);
}

async function clearHistory(onState: (state: PublicState) => void) {
  if (!confirm("Historie wirklich leeren?")) return;
  onState(await postJson<PublicState>("/api/history/clear", {}));
}

async function deleteHistoryEntry(pollId: string, title: string, onState: (state: PublicState) => void) {
  if (!confirm(`Abstimmung "${title}" wirklich aus der Historie löschen?`)) return;
  onState(await deleteJson<PublicState>(`/api/history/${encodeURIComponent(pollId)}`));
}

async function getSteamDetails(appid: number): Promise<SteamGameDetails> {
  return getJson<SteamGameDetails>(`/api/steam/apps/${appid}`);
}

function addDraft(games: GameDraft[], game: GameDraft): GameDraft[] {
  const key = gameIdentityKey(game);
  const exists = games.some((item) => gameIdentityKey(item) === key);
  return exists ? games : [...games, game];
}

function removeDraft(games: GameDraft[], game: GameDraft): GameDraft[] {
  const key = gameIdentityKey(game);
  return games.filter((item) => gameIdentityKey(item) !== key);
}

function isDraftSelected(games: GameDraft[], game: GameDraft): boolean {
  const key = gameIdentityKey(game);
  return games.some((item) => gameIdentityKey(item) === key);
}

function gameIdentityKey(game: Pick<GameDraft, "name" | "steamAppId">): string {
  return game.steamAppId ? `steam:${game.steamAppId}` : `name:${game.name.trim().toLocaleLowerCase("de-DE")}`;
}

function detailsToDraft(details: SteamGameDetails): GameDraft {
  return {
    name: details.name,
    note: details.genres.slice(0, 3).join(", ") || details.categories.slice(0, 2).join(", ") || `Steam AppID ${details.appid}`,
    steamAppId: details.appid,
    coverUrl: details.coverUrl,
    storeUrl: details.storeUrl,
    releaseDate: details.releaseDate,
    minPlayers: details.minPlayers,
    maxPlayers: details.maxPlayers,
    tags: normalizeTags(details.tags.length ? details.tags : details.genres.slice(0, 4))
  };
}

function topGameToDraft(game: SteamTopGame): GameDraft {
  return {
    name: game.name,
    note: game.peakPlayers ? `Steam Top-Multiplayer, 24h-Peak ${formatNumber(game.peakPlayers)}` : `Steam AppID ${game.appid}`,
    steamAppId: game.appid,
    coverUrl: game.coverUrl,
    storeUrl: game.storeUrl,
    releaseDate: "",
    minPlayers: null,
    maxPlayers: null,
    tags: ["Steam", "Mehrspieler"]
  };
}

function poolToDraft(game: PoolGame): GameDraft {
  return {
    id: game.id,
    name: game.name,
    note: game.note,
    steamAppId: game.steamAppId,
    coverUrl: game.coverUrl,
    storeUrl: game.storeUrl,
    releaseDate: game.releaseDate,
    minPlayers: game.minPlayers,
    maxPlayers: game.maxPlayers,
    tags: game.tags
  };
}

function snapshotToDraft(game: GameDraftSnapshot): GameDraft {
  return { ...game };
}

function emptyPoolDraft(): GameDraft {
  return { name: "", note: "", steamAppId: null, coverUrl: "", storeUrl: "", releaseDate: "", minPlayers: null, maxPlayers: null, tags: [] };
}

async function enrichDraftFromSteam(draft: GameDraft): Promise<GameDraft> {
  if (!draft.steamAppId) return draft;

  const needsSteamData =
    !draft.coverUrl ||
    !draft.storeUrl ||
    !draft.releaseDate ||
    !draft.note?.trim() ||
    !draft.tags?.length ||
    !draft.minPlayers ||
    !draft.maxPlayers;

  if (!needsSteamData) return draft;

  const details = detailsToDraft(await getSteamDetails(draft.steamAppId));
  return {
    ...draft,
    name: draft.name.trim() || details.name,
    note: draft.note?.trim() ? draft.note : details.note,
    coverUrl: draft.coverUrl || details.coverUrl,
    storeUrl: draft.storeUrl || details.storeUrl,
    releaseDate: draft.releaseDate || details.releaseDate,
    minPlayers: draft.minPlayers ?? details.minPlayers ?? null,
    maxPlayers: draft.maxPlayers ?? details.maxPlayers ?? null,
    tags: normalizeTags(draft.tags?.length ? draft.tags : details.tags || [])
  };
}

function inferGenreFromTags(tags: string[]): string {
  const supportPattern = /(mehrspieler|multiplayer|koop|co-op|pvp|lan|split|plattformübergreifend|online)/i;
  return tags.filter((tag) => !supportPattern.test(tag)).slice(0, 3).join(", ");
}

function getOnboardingItems(onboarding: OnboardingSettings): Array<{ id: string; title: string; value: string }> {
  return getOrderedOnboardingCategoryEntries(onboarding)
    .map((category) => category.type === "default"
      ? { id: category.id, title: category.title, value: onboarding[category.key] }
      : { id: category.id, title: category.section.title, value: category.section.content })
    .filter((item) => item.title.trim().length > 0 && item.value.trim().length > 0);
}

function getTvOnboardingColumns(onboarding: OnboardingSettings): { left: Array<{ id: string; title: string; value: string }>; right: Array<{ id: string; title: string; value: string }> } {
  const itemsById = new Map(getOrderedOnboardingCategoryEntries(onboarding).map((category) => {
    const item = category.type === "default"
      ? { id: category.id, title: category.title, value: onboarding[category.key] }
      : { id: category.id, title: category.section.title, value: category.section.content };
    return [category.id, item];
  }));
  const layout = getOnboardingTvLayout(onboarding);
  const visibleItem = (id: string) => {
    const item = itemsById.get(id);
    return item && item.title.trim() && item.value.trim() ? item : null;
  };

  return {
    left: layout.left.map(visibleItem).filter(Boolean) as Array<{ id: string; title: string; value: string }>,
    right: layout.right.map(visibleItem).filter(Boolean) as Array<{ id: string; title: string; value: string }>
  };
}

type OrderedOnboardingCategory =
  | { type: "default"; id: string; title: string; key: DefaultOnboardingKey; placeholder: string }
  | { type: "custom"; id: string; title: string; section: OnboardingSection };

function getOrderedOnboardingCategoryEntries(onboarding: OnboardingSettings): OrderedOnboardingCategory[] {
  const defaultsById = new Map(defaultOnboardingCategories.map((category) => [category.id, category]));
  const sectionsById = new Map(onboarding.sections.map((section) => [section.id, section]));
  const order = getOnboardingCategoryOrder(onboarding);
  const entries: OrderedOnboardingCategory[] = [];

  for (const id of order) {
    const defaultCategory = defaultsById.get(id);
    if (defaultCategory) {
      entries.push({ type: "default", ...defaultCategory });
      continue;
    }
    const section = sectionsById.get(id);
    if (section) entries.push({ type: "custom", id: section.id, title: section.title, section });
  }

  return entries;
}

function getOnboardingCategoryOrder(onboarding: Pick<OnboardingSettings, "sections" | "categoryOrder">): string[] {
  const defaultIds = defaultOnboardingCategories.map((category) => category.id);
  const customIds = onboarding.sections.map((section) => section.id);
  const allowed = new Set([...defaultIds, ...customIds]);
  const saved = onboarding.categoryOrder || [];
  const ordered = [...new Set(saved.filter((id) => allowed.has(id)))];
  for (const id of [...defaultIds, ...customIds]) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

function getOnboardingTvLayout(onboarding: Pick<OnboardingSettings, "sections" | "categoryOrder" | "tvLayout">): OnboardingTvLayout {
  const order = getOnboardingCategoryOrder(onboarding);
  const allowed = new Set(order);
  const used = new Set<string>();
  const source = onboarding.tvLayout || { left: [], right: [], hidden: [] };

  function normalizeColumn(items: string[] | undefined): string[] {
    const column: string[] = [];
    for (const item of items || []) {
      if (!allowed.has(item) || used.has(item)) continue;
      used.add(item);
      column.push(item);
    }
    return column;
  }

  const left = normalizeColumn(source.left);
  const right = normalizeColumn(source.right);
  const hidden = normalizeColumn(source.hidden);
  for (const id of order) {
    if (used.has(id)) continue;
    if (left.length <= right.length) left.push(id);
    else right.push(id);
    used.add(id);
  }
  return { left, right, hidden };
}

function removeTvLayoutItem(layout: OnboardingTvLayout, id: string): OnboardingTvLayout {
  return {
    left: layout.left.filter((item) => item !== id),
    right: layout.right.filter((item) => item !== id),
    hidden: layout.hidden.filter((item) => item !== id)
  };
}

function addTvLayoutItem(layout: OnboardingTvLayout, id: string, target: TvLayoutColumn): OnboardingTvLayout {
  const next = removeTvLayoutItem(layout, id);
  return { ...next, [target]: [...next[target], id] };
}

function moveTvLayoutItem(layout: OnboardingTvLayout, id: string, target: TvLayoutColumn): OnboardingTvLayout {
  return addTvLayoutItem(layout, id, target);
}

function reorderTvLayoutItem(layout: OnboardingTvLayout, column: TvLayoutColumn, id: string, direction: -1 | 1): OnboardingTvLayout {
  const next = { left: [...layout.left], right: [...layout.right], hidden: [...layout.hidden] };
  const index = next[column].indexOf(id);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= next[column].length) return layout;
  const [item] = next[column].splice(index, 1);
  if (!item) return layout;
  next[column].splice(nextIndex, 0, item);
  return next;
}

function matchesGroupSize(game: PoolGame, groupSize: number): boolean {
  if (game.minPlayers && groupSize < game.minPlayers) return false;
  if (game.maxPlayers && groupSize > game.maxPlayers) return false;
  return true;
}

function matchesPoolFilters(
  game: PoolGame,
  filters: {
    groupSize: number;
    onlyGroupFit: boolean;
    playerFilter: PoolPlayerFilter;
    query: string;
    sourceFilter: PoolSourceFilter;
    tag: string;
  }
): boolean {
  if (filters.onlyGroupFit && !matchesGroupSize(game, filters.groupSize)) return false;
  if (filters.sourceFilter === "steam" && !game.steamAppId) return false;
  if (filters.sourceFilter === "manual" && game.steamAppId) return false;
  if (filters.tag && !game.tags.includes(filters.tag)) return false;
  if (!matchesPlayerFilter(game, filters.playerFilter)) return false;

  const query = filters.query.trim().toLocaleLowerCase("de-DE");
  if (!query) return true;
  const haystack = [game.name, game.note, formatPlayerRange(game), game.steamAppId ? "steam" : "manuell", ...game.tags]
    .join(" ")
    .toLocaleLowerCase("de-DE");
  return haystack.includes(query);
}

function matchesPlayerFilter(game: Pick<PoolGame, "maxPlayers">, filter: PoolPlayerFilter): boolean {
  if (filter === "all") return true;
  if (!game.maxPlayers) return false;
  if (filter === "2-4") return game.maxPlayers <= 4;
  if (filter === "5-8") return game.maxPlayers > 4 && game.maxPlayers <= 8;
  if (filter === "9-16") return game.maxPlayers > 8 && game.maxPlayers <= 16;
  return game.maxPlayers > 16;
}

function numberOrNull(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function tagTextToArray(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))].slice(0, 12);
}

function formatPlayerRange(game: Pick<GameDraft, "minPlayers" | "maxPlayers">): string {
  if (game.minPlayers && game.maxPlayers) return `${game.minPlayers}-${game.maxPlayers} Spieler`;
  if (game.minPlayers) return `ab ${game.minPlayers} Spieler`;
  if (game.maxPlayers) return `bis ${game.maxPlayers} Spieler`;
  return "";
}

function getVoterId(): string {
  const existing = localStorage.getItem("lanVoteVoterId");
  if (existing) return existing;
  const next = createClientId();
  localStorage.setItem("lanVoteVoterId", next);
  return next;
}

function createClientId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function currentRoute(): Route {
  if (location.pathname.startsWith("/start")) return "start";
  if (location.pathname.startsWith("/vote")) return "vote";
  if (location.pathname.startsWith("/admin")) return "admin";
  if (location.pathname.startsWith("/tv")) return "tv";
  return "monitor";
}

function getSavedTheme(): ThemeMode {
  const saved = localStorage.getItem("lanVoteTheme");
  return saved === "light" || saved === "dark" ? saved : "dark";
}

function hasSeenAdminNotice(id: string): boolean {
  return localStorage.getItem("lanVoteSeenAdminNoticeId") === id;
}

function markAdminNoticeSeen(id: string): void {
  localStorage.setItem("lanVoteSeenAdminNoticeId", id);
}

function removeImageFromOnboarding(settings: OnboardingSettings, imageUrl: string): OnboardingSettings {
  return {
    ...settings,
    wlanInfo: removeImageMarkdown(settings.wlanInfo, imageUrl),
    voiceInfo: removeImageMarkdown(settings.voiceInfo, imageUrl),
    foodInfo: removeImageMarkdown(settings.foodInfo, imageUrl),
    scheduleInfo: removeImageMarkdown(settings.scheduleInfo, imageUrl),
    helpInfo: removeImageMarkdown(settings.helpInfo, imageUrl),
    sections: settings.sections.map((section) => ({ ...section, content: removeImageMarkdown(section.content, imageUrl) }))
  };
}

function removeImageMarkdown(value: string, imageUrl: string): string {
  const escapedUrl = escapeRegExp(imageUrl);
  return value
    .replace(new RegExp(`(^|\\n)\\s*!\\[[^\\]]*\\]\\(${escapedUrl}\\)(?:\\s*\\{[^}]*\\})?\\s*(?=\\n|$)`, "g"), "$1")
    .replace(new RegExp(`\\s*!\\[[^\\]]*\\]\\(${escapedUrl}\\)(?:\\s*\\{[^}]*\\})?`, "g"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function onboardingSettingsChanged(left: OnboardingSettings, right: OnboardingSettings): boolean {
  return left.enabled !== right.enabled
    || left.title !== right.title
    || left.wlanInfo !== right.wlanInfo
    || left.voiceInfo !== right.voiceInfo
    || left.foodInfo !== right.foodInfo
    || left.scheduleInfo !== right.scheduleInfo
    || left.helpInfo !== right.helpInfo
    || JSON.stringify(left.sections) !== JSON.stringify(right.sections)
    || JSON.stringify(left.categoryOrder) !== JSON.stringify(right.categoryOrder)
    || JSON.stringify(left.tvLayout) !== JSON.stringify(right.tvLayout);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("de-DE").format(value);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

let notificationAudio: AudioContext | null = null;

function isNotificationSoundEnabled(): boolean {
  return localStorage.getItem("lanVoteSoundEnabled") === "true";
}

async function enableNotificationSound(): Promise<void> {
  localStorage.setItem("lanVoteSoundEnabled", "true");
  const audio = getNotificationAudio();
  if (audio.state === "suspended") await audio.resume();
  playNewPollSound();
}

function getNotificationAudio(): AudioContext {
  notificationAudio ||= new AudioContext();
  return notificationAudio;
}

function playNewPollSound(): void {
  try {
    const audio = getNotificationAudio();
    const now = audio.currentTime;
    [0, 0.16, 0.34].forEach((offset, index) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime([660, 880, 1175][index]!, now + offset);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.14);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.16);
    });
  } catch {
    localStorage.removeItem("lanVoteSoundEnabled");
  }
}

function notifyDevice(): void {
  if ("vibrate" in navigator) {
    navigator.vibrate([180, 80, 180]);
  }
}

createRoot(document.getElementById("root")!).render(<App />);
