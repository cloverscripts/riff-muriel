## Muriel 1.3.9

**Downloads**
- **iPhone:** [ios-latest](https://github.com/cloverscripts/riff-muriel/releases/tag/ios-latest) (`Muriel.ipa`, install with SideStore, AltStore or Sideloadly). Needs iOS 16.2 or newer
- **Android:** [android-latest](https://github.com/cloverscripts/riff-muriel/releases/tag/android-latest) (`Muriel.apk`)
- **Windows:** installer below, or the portable exe on [windows-latest](https://github.com/cloverscripts/riff-muriel/releases/tag/windows-latest)
- **macOS:** `.dmg` / `.zip` below, for Apple Silicon and Intel. The app is unsigned: if macOS blocks it, open System Settings → Privacy & Security → Open Anyway.
- **Linux:** `.AppImage` below (needs FUSE 2: `fuse2` / `libfuse2`)

Or get it from the website: https://cloverscripts.github.io/riff-muriel/

**New**
- **Download a whole album** from its page, with progress; songs you already have are skipped. Thanks to Dandeleah!
- **Sorting:** Albums (recent, title, artist, year), Playlists (custom, name, most songs) and Artists (recent, name, most played). Muriel remembers your choice.
- **Better recommendations:** My Wave and the Daily Mixes now use YouTube Music radio and Last.fm similar songs, skip what you just heard, and tidy up video titles.
- **Block artists and songs** from a song's menu or the artist page; they're skipped and kept out of mixes. Unblock in Settings → Tracks. Syncs between devices.
- **Search filters:** All, Songs, Artists, Albums.
- **Choose the sound output device** (computers, Settings → Tracks).
- **Add a whole folder** of local music (computers).
- **Yandex Music:** album and single-song links import now.
- **Mac:** native window buttons, the Dock icon reopens Muriel, and songs start much faster.
- Covers that won't load fall back to Apple Music artwork (computers).

**Fixed**
- **iPhone:** music resumes after another app's sound ends, and the lock screen / Control Center shows the right play state, progress and speed. (#26)
- **Android:** the play/pause notification shows on Android 13 and newer; Muriel asks for notification permission once. (#25)
- **Phones:** pressing play from outside the app after a pause works again. (#24)
- **Windows taskbar:** the pinned icon opens Muriel, no duplicate icon, and the pin survives updates. Unpin the old icon once and pin Muriel again after updating. (#23)
- **Songs cutting off early:** with Crossfade on, the song now fades out and plays to its end instead of skipping ahead. (#22)
- **Android seek bar:** dragging with a finger works. (#21)
- **Switching the app language back to English** works again. (#20)
- **Windows:** first play no longer fails with a DOMException. (#17)
- Reduce motion follows your system setting, and the accent color picker saves properly.

**Fixed in 1.3.8**
- **"Failed, retry or skip" when Retry would have worked:** a song you click no longer inherits a failed lookup of the next-song preparation, and an expired stream link isn't reused. Muriel also quietly tries once more with a fresh lookup before asking.
- **Player bar visualizer ("Behind bar"):** the bars sit inside the player bar again instead of in a strip over the page, as a quiet backdrop that keeps the times and buttons readable. Turn it off under Settings → Interface → Visualizer.

**New in 1.3.7**
- **Cover picker:** in a song's track art dialog, "Find covers" shows YouTube images and Apple Music album covers to choose from.

**Fixed in 1.3.7**
- **First play is faster on computers:** a song you click no longer waits behind background work, SoundCloud search no longer starts a process per search, and caching a song reuses the stream it already has. Far fewer background processes.
- **YouTube Music on computers:** songs from YouTube Music no longer fail with "HTTP Error 403", and a song that failed once is looked up again instead of staying broken.
- **Playlist imports pick the right songs:** the artist has to match now, not just the title; covers, karaoke, sped-up and live versions are skipped unless the original is one.
- **Missing covers on phones:** songs saved without a working cover get one from YouTube, and covers that fail to load fall back to the next one.
- **Lighter:** capped memory caches and less work per second while the app is open.

**New in 1.3.6**
- **TV Karaoke controls:** favorite, shuffle, repeat and volume right in the karaoke screen, in sync with the player bar. Thanks to 10k-Reaper!
- **Settings, sorted:** every category has headings, and 30 settings moved to where you'd look for them. Settings that used to hide behind a fold-out in Advanced now show up in search too.

**Fixed in 1.3.6**
- **High CPU on computers:** Muriel ran many YouTube lookups at once (each can start a deno process), even when you just moved the mouse over songs. Now at most 2 run at a time at lower priority, nothing runs on hover, and only the next song is prepared near the end of the current one.
- **Settings on phones:** tapping a category no longer adds a second arrow.

**New in 1.3.5**
- **Looks and moves like Riff again:** see-through panels with your album's colours behind them, Riff's sidebar and player buttons, the Spotify-style home, and calmer motion without the glows and pink gradients. You can switch back to solid panels and My Wave in Settings.
- **Encore** uses your theme colours and Riff's style.
- **Smoother:** song changes, opening Now Playing and opening Settings do less work; on phones, Now Playing follows your finger when you swipe it down.
- **Settings:** a search field at the top. On phones, a list of categories with names.
- **Show on Discord:** your Discord profile can show what you're listening to (Settings → Integrations, computers only, off by default). Thanks to 10k-Reaper!

**New in 1.3.4**
- **Per-song sound:** in Audio → Tempo, "For this track only" keeps speed, pitch and volume for one song. "Ignore per-track settings" plays everything with the global values again, without deleting what songs saved.
- **Speed & pitch presets:** Normal, Slowed, Daycore, Sped up, Nightcore and Practice, plus your own.
- **Artists tab:** the artists you follow in one grid (turn it on in Settings).

**Fixed in 1.3.4**
- **SoundCloud:** share links (on.soundcloud.com, m.soundcloud.com) import again. Search no longer shows songs that SoundCloud only streams encrypted, which never played.
- **Favorites:** the same song can't end up in favorites twice any more; existing duplicates are cleaned up.
- **Home rows:** the mouse wheel scrolls the artists and playlists rows instead of the whole page.
- **Copy diagnostics and the logs button** work again, on phones too.
- **Google login:** when Google refuses the sign-in, Muriel now says why and suggests importing playlists by link.

**Fixed in 1.3.3**
- **Settings on phones:** the page sat shifted to the right and was cut off at the edge. It fits the screen again, at any font size.

**Fixed in 1.3.2**
- **Yandex Music import:** shared playlist links (music.yandex.ru/playlists/lk.…) are read now. When Yandex refuses, the message says why, instead of "Spotify doesn't allow reading this playlist".
- **Import dialog:** its title and menu follow the app's language

**Changed in 1.3.1**
- **Last.fm:** connecting is now just a login, so you no longer need your own API key

**New in 1.3** (everything new in Riff 43)
- **Muriel in your language:** Settings → Interface → Language. Song titles, artists and playlist names are never sent for translation.
- **Last.fm scrobbling:** each profile has its own login
- **Import and back up:**
  - **YouTube library (desktop):** sign in with Google and import your liked songs and playlists from YouTube and YouTube Music.
  - **Yandex Music:** import playlists.
  - **Playlist files:** import and export playlists as files that work with Riff.
  - **Profile backup:** back up and restore a profile.
- **Albums:** save albums to a new Albums tab (turn it on in Settings).
- **Artist pages:** a new design with a big header, follow button, bio and Songs/Albums tabs. Followed artists show up on the home page.
- **Spotify-style home (optional, Settings → Advanced):** quick picks, daily mixes you can rate, what's trending, and your artists.
- **Sorting and descriptions:** sort favorites and playlists, and give playlists a description.
- **Explicit [E] badges.**
- **Lyrics:**
  - **Source:** choose where they come from (LRCLIB or Genius).
  - **Word timing:** words light up in time with the song, where the timings are available.
  - **Mini lyrics:** lyrics in the mini player.
- **Trim the best part:** save a trimmed part of a song; playback jumps to it.
- **Look:**
  - **Visualizer:** it can sit behind the player bar.
  - **Icons:** icon packs and home button icons.
  - **Desktop:** a splash screen and a hideable title bar.
  - **Karaoke screen:** a seek bar.
- **Android islands:** on vivo phones with OriginOS 6 (Android 16) the song shows in the Origin Island. It also works on OPPO, OnePlus, realme and Honor (turn it on in Settings) and in the status bar on other Android 16 phones.

**Fixed**
- **Mini player:** a tap just under the song title opened the artist instead of Now Playing.
- **Artist lookups:** searching by name now finds the exact artist (for example "Queen"), and disambiguation pages are no longer shown as a bio.
- **Stuck songs:** a song that loads nothing for 12 seconds is skipped (adjustable in Settings).

Everything from 1.2.9 is included too: profiles, songs that wouldn't play trying YouTube, downloads in Music/Muriel on Android, and the right artist when several share a name.
