# tasks-desktop (Rust-Hub + Svelte-Oberfläche zu tasks.nvim)

Privates Repo (kein bezahlter Tarif: CI, Rolling-Bau und Release laufen auf dem selbst gehosteten
Windows-Runner, nur Windows; siehe `docs/RELEASING.md`). Hub und Oberfläche rechnen keine Regeln der Tasks: das tut die
Engine (`tasks.nvim`), die Seite zeigt nur (Regel WEB-13). Übergabe und Regelwerk:
`tasks-desktop-stand-*_HANDOVER.md`, `rules-vault/rulesets/native`.

## Bauen und prüfen (vor "fertig")

```
cd ui && pnpm check && pnpm test && pnpm build
touch crates/tasks-hub/src/ui.rs        # sonst bettet das Binary die alte Oberfläche ein
cargo build --locked
cargo fmt --check && cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cd ui && pnpm e2e                        # echtes Binary, echte Engine, axe
python tools/check-control-chars.py
python tools/check-color-literals.py    # no colour outside the tokens of appkit-ui (CI job hygiene)
```

- Umgebung für Browser- und Engine-Tests: `TASKS_ENGINE_DIR=E:/repos/tasks.nvim`,
  `LIB_NVIM_DIR=E:/repos/lib.nvim`, `TASKS_DESKTOP_REQUIRE_ENGINE=1` (ohne das werden
  Tests mit Engine still übersprungen).
- `pnpm build | tail -0` bricht den Build ab (SIGPIPE): `tail -1` nehmen.
- Ein Fix ohne Test, der ohne den Fix rot wird, gilt nicht als fertig. Nach der
  Sabotage neu bauen (`touch` + `cargo build`), sonst bleibt der Test grün.

## appkit (der geteilte Unterbau)

- Wächter, Pairing, Engine-Naht, Store, Watcher, Suche, Installation und die Sicherheitsmatrix liegen in
  [appkit](https://github.com/WKDSteve/appkit) (`E:/repos/appkit`), eingebunden per Tag in
  `[workspace.dependencies]` von `Cargo.toml`. Eine Änderung dort: erst in `appkit` (CI grün, neues Tag
  nach `docs/RELEASING.md` dort), dann hier das Tag heben, `cargo update -p appkit-hub` (holt alle drei),
  `python tools/check-appkit-pin.py`.
- Die Oberfläche nimmt vom selben Tag das Paket `appkit-ui` (Ordner `ui-kit` in appkit: Tokens, Basisregeln,
  MenuBar, MultiSelect, Info, Markdown-Leser, Hinweis-Popup, SSE, Pairing-Code), eingebunden in `ui/package.json`
  als `"appkit-ui": "github:WKDSteve/appkit#vX.Y.Z&path:ui-kit"` (das `pnpm add "git+https://github.com/WKDSteve/appkit.git#vX.Y.Z&path:ui-kit"` aus dem README des Kits schreibt pnpm in diese Kurzform um; die Pin-Prüfung nimmt beide); `ui/pnpm-lock.yaml` pinnt den Commit,
  `tools/check-appkit-pin.py` verlangt dasselbe Tag und denselben Commit wie `Cargo.lock`. Tag heben: alle
  Stellen (`Cargo.toml`, `ui/package.json` und die `uses: WKDSteve/appkit/release-kit/...@<sha>` in
  `.github/workflows/rolling.yml` und `release.yml`, voller Commit des Tags), `cargo update -p appkit-hub`,
  `cd ui && pnpm install`. Die Pin-Prüfung meldet einen Workflow auf einem anderen Commit.
  Das alles in einem Befehl, für alle vier Apps: `python tools/bump-apps.py vX.Y.Z` in appkit (`--dry-run`
  zeigt es nur, `--commit` committet je App, pusht nie; der Tag muss auf origin liegen).
- Install-Skripte der Releases kommen aus `release-kit` von appkit (gestempelt beim Hochladen), nicht aus
  `scripts/`; dort liegen nur `uninstall.*` und `test-install.*` (die das Kit-Skript des gepinnten appkit
  gegen den Build prüfen, Ordner per `tools/release-kit-dir.py`).
- Gleichzeitig an `appkit` und hier arbeiten: `[patch."https://github.com/WKDSteve/appkit"]` mit Pfaden in
  einer **nicht eingecheckten** `.cargo/config.toml`; nie einen Pfad in `Cargo.toml` committen. Für die
  Oberfläche `pnpm add link:E:/repos/appkit/ui-kit` und vor dem Commit das Git-Tag zurück (die Pin-Prüfung
  meldet einen `link:`).
- Falle: ein `[patch]` (auch per `cargo --config 'patch...'`) schreibt `Cargo.lock` um, die `appkit`-Pakete
  verlieren ihre Git-Quelle. Danach `git checkout -- Cargo.lock`, ohne `--locked` bauen (nur die drei
  `source`-Zeilen dürfen sich ändern), `python tools/check-appkit-pin.py`. Nie eine so umgeschriebene
  Lock-Datei committen (das Skript meldet dann "no package of ... appkit").

## Vertrag mit der Engine

- Ändert sich `tasks-export/1`: Engine zuerst (Goldens, Typen, Doku, Changelog, Spec),
  dann hier `ui/src/lib/contract.d.ts` aus dem **veröffentlichten** Commit kopieren
  (`git -C E:/repos/tasks.nvim show <sha>:schemas/tasks-export/1/tasks-export.d.ts`)
  und `engine.lock` auf diesen Commit setzen. Die CI prüft beides (`cmp`, Checkout
  des gepinnten Commits).
- `engine.lock` nie aus `rev-parse HEAD` des Engine-Checkouts bestimmen: dort liegen
  oft lokale Commits einer anderen Sitzung, die GitHub nicht kennt (die CI scheitert
  mit "not our ref"). Nur ein Commit, der auf `origin/main` liegt.

## Browser-Tests (Playwright)

- `pnpm web:e2e` läuft auch in Playwrights Firefox und WebKit (Projekte `firefox`, `webkit`). Aus der Claude-App
  startet Firefox aus `%LOCALAPPDATA%\ms-playwright` nicht ("Side-by-Side-Konfiguration ungültig", `mozglue`): die App
  leitet AppData um. Die Browser nach `ui/node_modules/.cache/ms-playwright` kopieren (oder dort installieren) und
  `PLAYWRIGHT_BROWSERS_PATH` darauf setzen; die CI nimmt den Tool-Cache des Runners.
- Die Tests teilen einen Vault: Titel und Dateinamen müssen eindeutig sein (ein
  Suchbegriff darf keinen Task eines anderen Tests treffen).
- `keyboard.press('F')` sendet kein Shift: Umschalt+f ist `press('Shift+f')`.
- Eine Taste oder ein Drag, während ein Schreibvorgang unterwegs ist, wird nicht
  gesendet, sondern mit dem Fehler-Toast `write.busy` ("Still saving - try again in
  a moment.", role=alert) abgelehnt (`App.refusedWhileSaving`: Board `J`/`K`/`H`/`L`,
  Drops, Inbox-Tasten; Karten sind währenddessen nicht ziehbar). Bewusst nicht
  gepuffert: eine gemerkte Taste träfe eine Liste, die die Person noch nicht gesehen
  hat (der laufende Schreibvorgang kann die Karte verschieben oder den Task aus der
  Inbox sortieren). Puffern wäre an dieser einen Stelle einzubauen. Das Event des
  Hubs kann die Änderung zeigen, bevor die Antwort da ist: vor dem nächsten Schritt `settled(page)` abwarten (alle Karten wieder
  ziehbar, der Titel im Detail wieder bearbeitbar; gilt für Board und Inbox),
  nicht nur die sichtbare Änderung. Auf eine Schreibantwort `WRITE_BUDGET` (15 s)
  warten, nicht die 5 s eines `expect`: einen Schritt, der schreibt, in
  `write(page, () => ...)` fassen (wartet auf die Antwort und auf `settled`).
  Absichtlich langsame Schreibvorgänge (`slow`, `holdNextWrite`) brauchen
  `test.slow()`.
- Die Suche trifft Teilstrings (`Board` trifft `Board1`): Titel pro Wiederholung
  mit fester Breite (`r000`, `r001`, ...).
- `--repeat-each` nur mit dem einen Worker: mit `--workers=4` teilen sich die
  Wiederholungen den Vault, und wer nach Positionen in einer Liste fragt (Inbox),
  sieht die Tasks der anderen kommen und gehen.
- Anfragen zählen (`page.on('request')`) für alles, was ein `$effect` auslöst; die
  Unit-Tests sehen keine Effekte. Mehr dazu in der Vorlage `web`.

## Nie

- Den Hub nicht aus einer Claude-Sitzung installieren oder starten
  (`tasks-hub install|start|autostart`): die Claude-App leitet AppData und HKCU um.
- Keine Pull Requests: fertig, committen, pullen, auf `main` pushen. Vor dem Push
  `git log origin/main..HEAD` ansehen. Keine Co-Autorenschaft von Claude.
