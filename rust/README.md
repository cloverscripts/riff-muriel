# Muriel RS

Muriel without Electron: a Rust (Tauri 2) app that shows Muriel's player UI in the system web view
(WebView2 on Windows) and runs Muriel's music backend as a small sidecar process. Personal build: it is not
part of any release.

## What's Rust here

- The app itself: window, tray (show, play/pause, next, quit), single instance, close-to-tray, file
  dialogs, importing local music, saving backups, clipboard, opening links.
- Starting and stopping the backend: it gets the port and token from the backend, hands them to the page,
  and the backend exits when the app does.

The backend (search, stream lookups, the audio proxy, cache, lyrics, imports) is Muriel's own `server.js`,
copied in unchanged by `stage.mjs` and run with a bundled `node.exe`. Song start time is decided by yt-dlp,
not by the backend's language, so that part keeps every feature working while the window, which used most
of the memory, is now the system's.

## Build

- Windows: run the **Muriel RS (Windows)** workflow on GitHub (Actions → Run workflow, branch
  `muriel-rust`) and download the installer from the run's artifacts.
- Locally: `node stage.mjs`, then `npx @tauri-apps/cli@2 build` (or `cargo run` while developing; it uses
  `node` from PATH). Linux needs the webkit2gtk-4.1 development packages.

## Not in the Rust build yet

Mini player window, Discord presence, choosing another data or download folder, plugins and themes from
files, YouTube library import via Google sign-in, the first-run welcome page. Media keys and the Windows
media overlay come from the web view's own media session support.
