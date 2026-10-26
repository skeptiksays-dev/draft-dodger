# DoTA Draft Dodger (desktop app)

Draft Dodger in its own window, with the Dota 2 game link built in. It reads your draft through
Valve's official **Game State Integration** (GSI), so the board fills in by itself. It never reads game memory
or changes game files. The only thing it adds to Dota is the GSI config file that switches the feature on.

The website version lives at https://draftdodger.netlify.app/

## Installing

1. Open the **Releases** page of this repository (right-hand side on GitHub).
2. Download `DraftDodger-Setup-<version>.exe` from the newest release and run it.
3. Windows may show *"Windows protected your PC"* because the app isn't code-signed. Click **More info**, then **Run anyway**.
4. In Steam: Library, right-click **Dota 2**, Properties, General, **Launch Options**. Add `-gamestateintegration`, then restart Dota.
5. Open Draft Dodger. The first time, it adds the GSI file to your Dota folder and shows a setup check if anything needs fixing.

The app updates itself: when a new release is published it downloads it and installs it the next time you close the app.

## Using it

- Leave Draft Dodger open while you play. When the draft starts the board fills in and you get a notification if the window isn't in front.
- **Always on top** (button in the toolbar, or Ctrl+T) keeps it above Dota on a second monitor.
- Press **Alt** to show the menu: reload, zoom, the log folder and *Check for updates*.
- If the separate PowerShell helper is also running, the app reads from it instead. Close the helper; you don't need it with the app.

## Publishing a new version (no tools needed)

1. Change `"version"` in `package.json` (for example `0.8.0` → `0.8.1`). Every release needs a new number.
2. Upload the changed files: on GitHub, **Add file → Upload files**, drag them in, then **Commit changes**.
3. GitHub builds the installer automatically (Actions tab, about 5–10 minutes) and publishes it under **Releases**.
   Installed apps pick the update up on their own.

If the version number didn't change, the build still runs (handy to check nothing broke) but no new release is made.
Each run also keeps the installer for 14 days under **Actions → the run → Artifacts**.

## Files

| File | What it does |
| --- | --- |
| `app/index.html` | The Draft Dodger site itself (same file as the website) |
| `main.js` | Opens the window, serves the site, menu, notifications, updates |
| `preload.js` | The small bridge the page uses to talk to the app |
| `gsi.js` | Finds Dota, installs the GSI file, checks the launch option, listens for game data |
| `test/gsi.test.js` | Tests for `gsi.js`; they run before every build |
| `.github/workflows/build.yml` | The automatic Windows build |
| `build/` | App icons |

## Running it from source (optional)

With [Node.js](https://nodejs.org) installed: `npm install`, then `npm start`. `npm run dist` builds an installer into `dist/`.

---
Fan-made. Not affiliated with or endorsed by Valve Corporation. Dota 2 is a trademark of Valve Corporation.
Data from OpenDota and STRATZ.
