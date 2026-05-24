# LAN Vote

LAN Vote ist eine lokale Abstimmungsapp für LAN-Partys. Der Hauptmonitor zeigt QR-Code, Live-Ergebnisse und Gewinner vergangener Runden. Teilnehmer stimmen per Handy ab. Neue Abstimmungen werden im Admin-Bereich manuell gestartet.

## Features

- Spiel-Pool für wiederverwendbare LAN-Spiele
- Spiel-Pool mit Tags, Notizen, Steam AppID und Min/Max-Spielerzahl
- Steam-Suche mit Coverbildern und Store-Links
- Optionaler Steam Web API Key
- Steam-Store-Suchfallback ohne API-Key
- Abstimmungs-Timer mit automatischem Abschluss
- Startklar-Checkbox pro Stimme
- Mehrfachauswahl mit Top-3-Ranking
- Abstimmungsvorlagen für wiederkehrende Runden
- Optionale LAN-Onboarding-Seite für WLAN/LAN, Voice, Essen, Ablauf und Hilfe
- Markdown in Onboarding-Texten inklusive Links und eingebetteten Bildern
- In-App-Benachrichtigung bei neuen Abstimmungen per Socket.IO
- TV-Modus mit auffälliger Animation und optionalem Signalton
- TV-Modus unter `/tv` für den Hauptmonitor

## Stack

- Node.js 24 LTS
- TypeScript
- React 19.2 mit Vite 8
- Express 5 API
- Socket.IO für Live-Updates
- SQLite mit `better-sqlite3` 12
- Zod 4 für Request-Validierung
- Docker Multi-Stage Build auf Debian Trixie Slim
- Steam Web API Suche im Admin-Bereich

## Docker-Start

In `docker-compose.yml` zuerst `LAN_VOTE_PUBLIC_URL` auf die LAN-IP oder den DNS-Namen des Docker-Hosts setzen:

```yaml
LAN_VOTE_PUBLIC_URL: "http://192.168.1.10:8080"
```

Für den Adminbereich muss ein Passwort in `.env` gesetzt werden:

```bash
cp .env.example .env
```

```dotenv
LAN_VOTE_ADMIN_USER=admin
LAN_VOTE_ADMIN_PASSWORD=ein-langes-passwort
```

Optional `STEAM_WEB_API_KEY` in derselben `.env` setzen, damit die serverseitige Steam-Suche mit deinem Steam Web API Key arbeitet:

```dotenv
STEAM_WEB_API_KEY=...
STEAM_APP_LIST_TTL_HOURS=24
STEAM_DETAILS_CACHE_TTL_DAYS=365
```

Mit Key nutzt der Server `IStoreService/GetAppList`. Ohne Key fragt die Suche zuerst die öffentliche Steam-Store-Suche ab und fällt nur bei Bedarf auf `ISteamApps/GetAppList` zurück.
Die `.env` bleibt lokal auf dem Docker-Host und ist über `.dockerignore` vom Image-Build ausgeschlossen.
Steam-Appdetails und Cover werden in SQLite unter `/app/data/lan-vote.sqlite` gecacht. Bei Steam-Fehlern oder Rate-Limits kann ein vorhandener älterer Cache-Eintrag weiterverwendet werden.

Dann starten:

```bash
docker compose up -d --build
```

Danach im Browser öffnen:

- Monitor: `http://<LAN-IP>:8080/`
- LAN-Startseite: `http://<LAN-IP>:8080/start`
- Abstimmung: `http://<LAN-IP>:8080/vote`
- Admin: `http://<LAN-IP>:8080/admin`
- TV-Modus: `http://<LAN-IP>:8080/tv`

Die SQLite-Datenbank liegt im Docker-Volume `lan-vote-data` unter `/app/data/lan-vote.sqlite`.

## Docker-Host-Voraussetzungen

- Linux-Host oder Linux-VM, z.B. Debian 13 oder Ubuntu 24.04.
- Docker Engine mit Compose Plugin.
- Der Host muss aus dem LAN von Handys und Hauptmonitor erreichbar sein.
- TCP-Port `8080` muss frei und in der Firewall erlaubt sein.
- Internetzugang beim Build, damit `node:24-trixie-slim` und npm-Pakete geladen werden können.
- Internetzugang zur Laufzeit, wenn die Steam-Suche genutzt werden soll.
- Ressourcen: 1 vCPU und 512 MB RAM reichen; 1 GB RAM ist sinnvoller.
- Persistenz: Docker-Volume oder Bind-Mount für `/app/data`.

## Lokale Entwicklung

```bash
npm install
npm run dev
```

Entwicklungsserver:

- Frontend: `http://localhost:5173`
- Backend/API: `http://localhost:8080`

Produktionsbuild lokal:

```bash
npm run build
npm start
```

Wichtige Umgebungsvariablen:

- `LAN_VOTE_PUBLIC_URL`: URL, die im QR-Code landet, z.B. `http://192.168.1.10:8080`.
- `LAN_VOTE_PORT`: Server-Port, Standard `8080`.
- `LAN_VOTE_HOST`: Bind-Adresse, Standard `0.0.0.0`.
- `LAN_VOTE_DB_PATH`: SQLite-Dateipfad, Standard `/app/data/lan-vote.sqlite`.
- `LAN_VOTE_ADMIN_USER`: Benutzername für den Adminbereich, Standard `admin`.
- `LAN_VOTE_ADMIN_PASSWORD`: Passwort für den Adminbereich, erforderlich.
- `STEAM_WEB_API_KEY`: Optionaler Steam Web API Key für die serverseitige Steam-Suche.
- `STEAM_APP_LIST_TTL_HOURS`: Cache-Dauer für die Steam-App-Liste, Standard `24`.
- `STEAM_DETAILS_CACHE_TTL_DAYS`: Cache-Dauer für Steam-Appdetails und Cover, Standard `365`.

Der Steam API Key bleibt serverseitig. Das Frontend ruft nur `/api/steam/search` auf.

## Bedienkonzept

- Der Monitor zeigt den QR-Code. Wenn Onboarding aktiviert ist, führt der QR-Code zuerst auf `/start`, sonst direkt auf `/vote`.
- Teilnehmer wählen bis zu drei Spiele in Reihenfolge. Rang 1 zählt 3 Punkte, Rang 2 zählt 2 Punkte, Rang 3 zählt 1 Punkt.
- Ergebnisse zeigen Punkte, Erstplatzierungen, startklare Teilnehmer und die Namen je Spiel.
- Im Adminbereich werden Spiel-Pool, Vorlagen, Onboarding-Texte und laufende Abstimmungen verwaltet.
- Offene Clients bekommen bei neuer Abstimmung einen Hinweis. Ton muss im Browser einmal über `Ton aktivieren` freigeschaltet werden.
- Onboarding-Texte unterstützen Markdown, z.B. Listen, Überschriften, `[Link](https://...)` und `![Bild](https://...)`. Gerenderte URLs können direkt kopiert werden.
