# Muriel Glass: design spec

A complete redesign of Muriel (desktop and phones) in Apple's Liquid Glass language, on the `muriel-glass`
branch. Muriel today is Material 3 (Google): pill buttons, tonal surfaces, M3 shapes, wavy progress, a left rail,
a bottom player bar. **Nothing of that look stays.** Behaviour stays: every feature, setting and flow still works.

Shared foundation: `glass/tokens.css` (type, colors, materials, shape, motion, the `.g-glass` material class).
Each area lives in its own file, all loaded after `styles.css` (and `mobile.css` on phones):

| file | owner | covers |
|---|---|---|
| `glass/shell.css` (+ `glass/shell.js` if needed) | app frame | navigation, window chrome, search field placement, the player, Now Playing, lyrics, karaoke/TV view, queue, profile switcher placement, toasts, banners, splash, mini window |
| `glass/views.css` (+ `glass/views.js`) | content | Home (both layouts), search results, Favorites, Playlists + detail, Albums + album page, Artist page, History, Encore, My files/downloads, empty states, track rows, cards and grids |
| `glass/settings.css` (+ `glass/settings.js`) | settings & overlays | Settings (every section), all dialogs/modals (import, download/trim, create playlist, share, profiles, sync, Last.fm, backups, confirm), menus, context menus, popovers, dropdowns, the command palette |

Markup: change `index.html` only inside your area, keep every `id` that `app.js` uses (or update app.js where it
reads them), and prefer CSS. If you must move an element, do it with markup in your area, not by rewriting others'.

## Principles (from Apple's HIG / Adopting Liquid Glass)

1. **Content first, glass on top.** Glass is a separate functional layer *above* content: navigation, toolbars,
   the player, menus, sheets. Content (artwork, lists, text) is never glass. Don't stack glass on glass.
2. **Sparingly.** A screen has a few glass elements, not a dozen. Everything else is plain content on `--g-bg`.
3. **Floating, inset, rounded.** Bars float with a margin from the edges and use capsule or concentric corners
   (inner radius = outer radius - padding). No full-width hard-edged bars.
4. **Legibility.** Where content scrolls under glass, add a scroll-edge fade (`--g-scroll-edge`). Use
   `.g-glass.g-strong` behind dense text. Respect Reduce Transparency, `body.perf` (no blur) and reduced motion.
5. **System look.** System font (`--g-font`) and text styles (`--g-large-title` … `--g-caption`), system colors,
   one accent (`--g-accent`, defaults to pink; the Theme accent setting sets `--g-user-accent`), SF-Symbols-like
   line icons (2px rounded strokes or filled glyphs; Muriel's "SF" icon pack is a good base), 44px tap targets,
   hairline separators inset from the leading edge, no drop shadows on content except artwork.
6. **Motion.** Calm spring curves (`--g-ease`, `--g-dur`): controls scale slightly when pressed (0.96), sheets slide
   up, the mini player expands into Now Playing. Nothing bounces for decoration.
7. **Light and dark.** Dark (default) and `body.theme-light` both look intentional. Check both.

## Layout

### Desktop (macOS 26 Music-like)
- **Sidebar:** a floating glass panel on the left, inset 10px from the window edges, radius `--g-r-l`. Sections:
  search field at the top; Home, Favorites, History, Albums (if on), Encore; "Library" with the playlists listed
  by name with small artwork; Settings at the bottom with the profile avatar. Collapsible to icons.
- **Toolbar / player:** no bottom bar. The player is a glass capsule centered at the top of the window (the
  "LCD"): artwork, title + artist, a thin progress line along its bottom edge; transport controls (shuffle, prev,
  play/pause, next, repeat) as plain glyph buttons to its left; volume, lyrics, queue, more to its right.
  The window title bar area becomes this toolbar (keep window drag regions and the window buttons working).
- **Content:** large title (`--g-large-title`) at the top of each page that shrinks into the toolbar on scroll;
  artwork grids with `--g-art-radius`, lists with hairline separators.
- **Now Playing:** full-window, immersive: blurred artwork-derived background, large artwork left, lyrics right
  (big, bold, current line bright, others dimmed), glass controls floating at the bottom.
- **Queue / lyrics side panel:** a floating glass panel from the right, not a docked column.

### Phones (iOS 26 Music-like)
- **Tab bar:** a floating glass capsule at the bottom (inset 16px, above the home indicator) with 4 tabs (Home,
  Favorites, Library, Settings, or what fits Muriel best) and a separate round glass search button to its right.
  The tab bar shrinks when scrolling down and grows back on scroll up.
- **Mini player:** a glass capsule docked just above the tab bar (artwork, title, play/pause, next). Tap opens
  Now Playing.
- **Large titles** that collapse into a small centered title in a glass top area on scroll.
- **Now Playing:** a full-screen sheet with an artwork-colored gradient background, big artwork, title row with a
  favorite button, scrubber, transport controls, volume, and buttons for lyrics / queue / devices. Swipe down to
  close (keep that working). Lyrics as a full-screen view like Apple Music.
- **Sheets:** dialogs become bottom sheets with a grabber, radius `--g-r-xl` at the top.

## Done means
Every view and dialog restyled on desktop and phone, in dark and light; no leftovers of the old look
(M3 shapes, tonal pills, wavy progress, the old rail and bottom player); `npm test` passes; `node mobile/build.mjs`
works; screenshots of every view at 1440x900 and 390x844 in `/tmp/claude-0/-home-user-riff-muriel/53a50415-4003-59e6-9c0d-75aaa8c8792f/scratchpad/glass/<area>/`.
