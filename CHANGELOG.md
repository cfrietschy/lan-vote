# Changelog

Alle relevanten Änderungen an LAN Vote werden in dieser Datei dokumentiert.

## 2026-05-26

### Hinzugefügt

- Eigene Onboarding-Kategorien im Adminbereich.
- Freie Kategorien haben Titel, Markdown-Inhalt, Bild-Uploads und können sortiert oder gelöscht werden.
- Onboarding-Datenmodell speichert zusätzliche Kategorien migrationsfreundlich als JSON neben den bestehenden Standardfeldern.
- Reihenfolge aller Onboarding-Kategorien ist frei editierbar, inklusive der Standardkategorien.
- Markdown-Bilder in Onboarding-Texten können links, mittig oder rechts ausgerichtet werden.
- Markdown-Bilder in Onboarding-Texten können per Toolbar auf 25%, 50%, 75% oder 100% Breite gesetzt werden.
- TV-Seite kann Onboarding-Kategorien als verschiebbare Boxen in linker und rechter TV-Spalte darstellen.

### Behoben

- Ranking-Buttons zeigen nach Auswahl von drei Spielen kein falsches „Als Rang 4 wählen“ mehr, sondern deaktivieren weitere Optionen korrekt.
- Onboarding-Bildgrößen werden in Start- und TV-Ansicht einheitlich über die Markdown-Bildattribute dargestellt.
- `docker-compose.yml` enthält keine private Beispiel-Domain mehr; `LAN_VOTE_PUBLIC_URL` ist jetzt ein Pflichtwert aus `.env`.
- `qrcode` ist als Produktionsabhängigkeit deklariert.

## 2026-05-25

### Hinzugefügt

- TV-Ansicht mit besserer Aufteilung für laufende Abstimmungen: QR-Code bleibt sichtbar, LAN-Infos werden kompakter angezeigt und Gewinner bleiben erreichbar.
- Markdown-Editor für die Onboarding-Texte mit Toolbar für Fett, Kursiv, Überschriften, Listen, Zitate, Code, Links und Bilder.
- Bild-Upload für Onboarding-Inhalte mit Unterstützung für PNG, JPG, WebP und GIF.
- Bildverwaltung im Adminbereich: hochgeladene Bilder auflisten, URLs kopieren, einzelne Bilder löschen und verwaiste Uploads entfernen.
- Server-Endpunkte für Upload-Liste, Upload-Löschung und Bereinigung nicht referenzierter Bilder.
- Update-Anleitung in der README inklusive Backup, Compose-Update, Healthcheck und Rollback-Hinweisen.

### Geändert

- Onboarding-Markdown kann Bilder ohne sichtbare Bildunterschrift darstellen.
- Hochgeladene Bilder werden ohne erzwungene Caption eingefügt.
- Onboarding-Feldlimits wurden erhöht, damit umfangreichere LAN-Infos und eingebettete Bilder praktikabel sind.
- TV-Ansicht zeigt Onboarding-Bilder sowohl im Idle-Modus als auch kompakt während laufender Abstimmungen.
- TV-Ansicht zeigt Spielcover in laufenden Abstimmungen wieder kompakt neben den Ergebnissen.
- Ergebnis-Cover nutzen ein festes Steam-Header-Seitenverhältnis, damit sie nicht gestreckt oder falsch gerahmt werden.
- README enthält jetzt klarere Betriebsinformationen für Updates per Docker Compose.

### Behoben

- Bilder der LAN-Startseite waren in der TV-Ansicht ausgeblendet.
- Spielcover fehlten in der TV-Ansicht bei laufender Abstimmung.
- Cover in laufenden Ergebnissen wurden zuvor schlecht skaliert und nicht passend in den Rahmen gesetzt.

## 2026-05-24

### Hinzugefügt

- Erste veröffentlichte Version der LAN-Party-Abstimmungsapp.
- Docker-basierter Betrieb mit Node.js 24 auf Debian Trixie Slim.
- Adminbereich, Spiel-Pool, Abstimmungen, Vorlagen, Steam-Anbindung, LAN-Onboarding, TV-Modus und Live-Updates per Socket.IO.
- MIT-Lizenz.
