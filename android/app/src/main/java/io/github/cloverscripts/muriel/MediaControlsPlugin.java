package io.github.cloverscripts.muriel;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.activity.result.ActivityResult;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The phone's "now playing" controls for Android: a media session plus a playback notification, so
 * Muriel shows up in the notification shade, on the lock screen and in the quick-settings media
 * player, and headset / Bluetooth buttons work. Android's WebView doesn't do this for the page's
 * navigator.mediaSession the way iOS does. The page (mobile/media-controls.js) sends the song and
 * play state; button presses come back as "action" events.
 *
 * While a song plays, PlaybackService keeps the app in the foreground, so Android doesn't stop the
 * music in the background to save memory. Between two songs nothing plays while the next one downloads;
 * the page reports that as "loading", and the app stays in the foreground and awake for it.
 *
 * Android 16+ can also show the song as a "Live Update" (the island): see postIsland.
 */
@CapacitorPlugin(
        name = "MurielMedia",
        // asked for by allowIsland, once when the first song plays (media-controls.js) and from the island row.
        // Android 13+ is meant to show media notifications without it, but many phones hide them too (#25).
        permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") })
public class MediaControlsPlugin extends Plugin {
    static final String CHANNEL = "playback";
    static final int NOTIFICATION_ID = 7041;
    // The island at the top of the screen. vivo's Origin Island and OPPO's Fluid Cloud show music only from apps on
    // the maker's own list, hard-coded in the system, so Muriel's media notification never gets in there. What they
    // do take from any app is an Android 16 "Live Update" (a promoted ongoing notification, which can't be a media
    // one), so while a song plays one is posted beside the playback notification. Elsewhere it is a chip in the
    // status bar. Xiaomi's Super Island and Samsung's Now Bar show the playback notification by themselves.
    static final String ISLAND_CHANNEL = "island";
    static final int ISLAND_ID = 7042;
    // several updates come together on a song change, and Android drops an app's posts beyond a few a second
    static final long ISLAND_DELAY_MS = 500;
    // the phone's maker: "vivo" (iQOO too), "oplus" (OPPO, OnePlus, realme), "xiaomi" (Redmi, POCO), "samsung",
    // "honor" or "other"
    static final String VENDOR = vendor();
    // vivo, OPPO and Xiaomi islands don't run the Live Update's clock; they show its short text, so that's the title
    static final boolean ISLAND_SHOWS_TEXT = "vivo".equals(VENDOR) || "oplus".equals(VENDOR) || "xiaomi".equals(VENDOR);
    static final int ART_SIZE = 320;
    // paused: CPU and Wi-Fi are let go after this
    static final long LOCK_RELEASE_MS = 15_000;
    // re-taken on every update while playing; only a page that stopped talking lets it run out
    static final long WAKE_LOCK_MS = 30 * 60 * 1000;

    // read by PlaybackService
    static volatile MediaControlsPlugin instance;
    static volatile Notification notification;
    // a song is playing or the next one is on its way
    static volatile boolean playing;

    private MediaSessionCompat session;
    private final ExecutorService artLoader = Executors.newSingleThreadExecutor();
    private String title = "";
    private String artist = "";
    private String album = "";
    private long durationMs = 0;
    private String artworkUrl = "";
    private Bitmap artwork;
    // the extra buttons beside previous / next (Android 13+: in the quick-settings and lock-screen player)
    static final String CUSTOM_SHUFFLE = "io.github.cloverscripts.muriel.SHUFFLE";
    static final String CUSTOM_REPEAT = "io.github.cloverscripts.muriel.REPEAT";
    private boolean shuffle;
    private String repeat = "off"; // "off", "all" (the playlist) or "one" (the song)
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable releaseLater = this::releaseLocks;
    // the page's play state at the last update: the Live Update's clock runs from it
    private boolean nowPlaying;
    private long positionMs;
    private long positionAt;
    private float rate = 1f;
    // the island setting from the page: "on", "off" or "auto" (on for vivo)
    private String islandMode = "auto";
    // swiped away: not posted again until the music stops
    private volatile boolean islandDismissed;
    // what the Live Update should show (null: none) and what it shows; the second only on the main thread
    private volatile Island islandWanted;
    private Island islandShown;
    private boolean islandChannel;
    private final Runnable islandPost = this::postIsland;

    @Override
    public void load() {
        instance = this;
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("The song that's playing, with play, pause and skip");
            channel.setShowBadge(false);
            ctx.getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        // one left by an app that was stopped without cleaning up
        try { ctx.getSystemService(NotificationManager.class).cancel(ISLAND_ID); } catch (Exception ignored) {}
        session = new MediaSessionCompat(ctx, "Muriel");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { start("play"); }
            @Override public void onPause() { send("pause", -1); }
            @Override public void onStop() { send("pause", -1); }
            @Override public void onSkipToNext() { start("next"); }
            @Override public void onSkipToPrevious() { start("prev"); }
            @Override public void onSeekTo(long pos) { send("seek", pos / 1000.0); }
            @Override public void onCustomAction(String action, android.os.Bundle extras) {
                if (CUSTOM_SHUFFLE.equals(action)) send("shuffle", -1);
                else if (CUSTOM_REPEAT.equals(action)) send("repeat", -1);
            }
        });
    }

    // the repeat button: dim when off, lit for the playlist, lit with a 1 for the song
    private int repeatIcon() {
        return "one".equals(repeat) ? R.drawable.ic_repeat_one_on : "all".equals(repeat) ? R.drawable.ic_repeat_on : R.drawable.ic_repeat_off;
    }

    private String repeatLabel() {
        return "one".equals(repeat) ? "Repeat this song" : "all".equals(repeat) ? "Repeat playlist" : "Repeat off";
    }

    void send(String action, double position) {
        JSObject data = new JSObject();
        data.put("action", action);
        if (position >= 0) data.put("position", position);
        notifyListeners("action", data);
    }

    // play / next / previous from the notification, the lock screen or a headset: each starts a song.
    // Paused for a while, Muriel may no longer be in the foreground, and Android 15+ only lets apps in the
    // foreground play (the song stopped again right away). Such a button press may bring the app back into
    // the foreground, so that happens first.
    void start(String action) {
        if (!playing) {
            playing = true;
            holdLocks();
            refreshNotification();
        }
        send(action, -1);
    }

    @PluginMethod
    public void update(PluginCall call) {
        title = call.getString("title", "");
        artist = call.getString("artist", "");
        album = call.getString("album", "");
        durationMs = (long) (call.getDouble("duration", 0.0) * 1000);
        positionMs = (long) (call.getDouble("position", 0.0) * 1000);
        positionAt = System.currentTimeMillis();
        nowPlaying = Boolean.TRUE.equals(call.getBoolean("playing", false));
        boolean loading = !nowPlaying && Boolean.TRUE.equals(call.getBoolean("loading", false));
        rate = call.getFloat("rate", 1f);
        shuffle = Boolean.TRUE.equals(call.getBoolean("shuffle", false));
        repeat = call.getString("repeat", "off");
        if (!"all".equals(repeat) && !"one".equals(repeat)) repeat = "off";
        islandMode = call.getString("island", "auto");
        if (!"on".equals(islandMode) && !"off".equals(islandMode)) islandMode = "auto";
        String art = call.getString("artwork", "");
        if (art == null) art = "";
        if (!art.equals(artworkUrl)) {
            artworkUrl = art;
            artwork = null;
            loadArtwork(art);
        }
        playing = nowPlaying || loading;
        if (playing) holdLocks();
        else {
            handler.removeCallbacks(releaseLater);
            handler.postDelayed(releaseLater, LOCK_RELEASE_MS);
        }

        session.setMetadata(metadata());
        session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
                        | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_STOP
                        | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackStateCompat.ACTION_SEEK_TO)
                .setState(nowPlaying ? PlaybackStateCompat.STATE_PLAYING
                                : loading ? PlaybackStateCompat.STATE_BUFFERING : PlaybackStateCompat.STATE_PAUSED,
                        positionMs, nowPlaying ? rate : 0f)
                // shuffle goes left of "previous", repeat right of "next"; lit when on
                .addCustomAction(new PlaybackStateCompat.CustomAction.Builder(CUSTOM_SHUFFLE,
                        shuffle ? "Shuffle on" : "Shuffle off", shuffle ? R.drawable.ic_shuffle_on : R.drawable.ic_shuffle_off).build())
                .addCustomAction(new PlaybackStateCompat.CustomAction.Builder(CUSTOM_REPEAT, repeatLabel(), repeatIcon()).build())
                .build());
        session.setActive(true);
        refreshNotification();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        shutdown();
        call.resolve();
    }

    // For the island row in Settings (mobile-ui.js)
    @PluginMethod
    public void islandStatus(PluginCall call) {
        call.resolve(islandState());
    }

    // Turning the island on: asks for notifications if they're off (a Live Update is an ordinary notification, which
    // needs them), else opens the phone's switch for Live Updates if that is off (OPPO ships it off). Answers with
    // islandState; with settings: false it only asks, and never opens Settings.
    @PluginMethod
    public void allowIsland(PluginCall call) {
        boolean settings = !Boolean.FALSE.equals(call.getBoolean("settings", true));
        String pkg = getContext().getPackageName();
        if (!notificationsOn()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getActivity() != null
                    && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                    && getPermissionState("notifications") != PermissionState.DENIED) {
                requestPermissionForAlias("notifications", call, "notificationsAnswered");
                return;
            }
            // refused before, or turned off in Settings: only Settings can turn them back on
            if (settings) openSettings(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg), null);
        } else if (settings && Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA && !promotedOn()) {
            Intent promotion = new Intent("android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS").putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
            Intent app = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
            if ("oplus".equals(VENDOR)) {
                // ColorOS opens its whole notification page for this; the key makes it light up "Show Live Updates on Live Alerts"
                promotion.putExtra(":settings:fragment_args_key", "shown_as_live_alert_enable_key");
                app.putExtra(":settings:fragment_args_key", "shown_as_live_alert_enable_key");
            }
            // Honor has no page for it (there the notifications are the switch)
            openSettings(promotion, app);
        }
        call.resolve(islandState());
    }

    @PermissionCallback
    private void notificationsAnswered(PluginCall call) {
        if (call == null) return;
        call.resolve(islandState());
        // allowed while a song plays: the playback notification and the island show now
        refreshNotification();
    }

    private JSObject islandState() {
        boolean supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA;
        JSObject r = new JSObject();
        r.put("supported", supported);
        r.put("vendor", VENDOR);
        r.put("defaultOn", supported && "vivo".equals(VENDOR));
        r.put("notifications", notificationsOn());
        r.put("promoted", supported && promotedOn());
        return r;
    }

    private boolean notificationsOn() {
        try { return NotificationManagerCompat.from(getContext()).areNotificationsEnabled(); } catch (Throwable e) { return true; }
    }

    // the user's switch for Live Updates (Android 16+); a phone that doesn't know it says false
    private boolean promotedOn() {
        try { return NotificationManagerCompat.from(getContext()).canPostPromotedNotifications(); } catch (Throwable e) { return false; }
    }

    private void openSettings(Intent first, Intent fallback) {
        Activity activity = getActivity();
        for (Intent i : new Intent[] { first, fallback }) {
            if (i == null) continue;
            try {
                if (activity != null) activity.startActivity(i);
                else getContext().startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return;
            } catch (Exception ignored) {}
        }
    }

    // Some phones (Xiaomi, Huawei, Samsung's "sleeping apps"...) stop background apps to save battery even
    // while they play music, unless the app is let off battery optimization.
    @PluginMethod
    public void backgroundStatus(PluginCall call) {
        JSObject r = new JSObject();
        r.put("unrestricted", unrestricted());
        call.resolve(r);
    }

    // answers once the system dialog is closed
    @PluginMethod
    public void allowBackground(PluginCall call) {
        if (unrestricted() || getActivity() == null) { backgroundStatus(call); return; }
        try {
            startActivityForResult(call, new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getContext().getPackageName())), "backgroundAnswered");
        } catch (Exception e) {
            // no such dialog on this phone: the list in Settings instead
            try { getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); } catch (Exception ignored) {}
            getBridge().releaseCall(call);
            backgroundStatus(call);
        }
    }

    @ActivityCallback
    private void backgroundAnswered(PluginCall call, ActivityResult result) {
        if (call == null) return;
        getBridge().releaseCall(call);
        backgroundStatus(call);
    }

    // A song saved to Music/Muriel (mobile/shims/store.js) goes into the phone's media index right away, so music
    // apps list it: Android 10 and older only find new files at their next full scan. Takes a path or file:// URI.
    @PluginMethod
    public void scanFile(PluginCall call) {
        String path = call.getString("path", "");
        if (path != null && path.startsWith("file:")) path = Uri.parse(path).getPath();
        if (path == null || path.isEmpty()) {
            call.reject("no path");
            return;
        }
        MediaScannerConnection.scanFile(getContext(), new String[] { path }, null, null);
        call.resolve();
    }

    private boolean unrestricted() {
        PowerManager pm = getContext().getSystemService(PowerManager.class);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    // with the screen off the phone would otherwise sleep (and slow Wi-Fi down) while the next song downloads
    @SuppressWarnings("deprecation")
    private synchronized void holdLocks() {
        handler.removeCallbacks(releaseLater);
        Context app = getContext().getApplicationContext();
        try {
            if (wakeLock == null) {
                wakeLock = app.getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Muriel:playback");
                wakeLock.setReferenceCounted(false);
            }
            wakeLock.acquire(WAKE_LOCK_MS);
        } catch (Exception ignored) {}
        try {
            if (wifiLock == null) {
                wifiLock = ((WifiManager) app.getSystemService(Context.WIFI_SERVICE)).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Muriel:playback");
                wifiLock.setReferenceCounted(false);
            }
            if (!wifiLock.isHeld()) wifiLock.acquire();
        } catch (Exception ignored) {}
    }

    private synchronized void releaseLocks() {
        handler.removeCallbacks(releaseLater);
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) {}
    }

    private MediaMetadataCompat metadata() {
        MediaMetadataCompat.Builder b = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs);
        if (artwork != null) b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
        return b.build();
    }

    // posts the notification; while playing, the service holds it as its foreground notification
    private synchronized void refreshNotification() {
        Context ctx = getContext();
        notification = buildNotification(ctx);
        Intent service = new Intent(ctx, PlaybackService.class).setAction(PlaybackService.ACTION_REFRESH);
        try {
            if (playing) ContextCompat.startForegroundService(ctx, service.putExtra(PlaybackService.EXTRA_FOREGROUND, true));
            else if (PlaybackService.running) ctx.startService(service);
            else ctx.getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification);
        } catch (Exception e) {
            // Android 12+ refuses to start a foreground service from the background (say, a headset
            // button while the app is closed); the notification still updates
            try { ctx.getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification); } catch (Exception ignored) {}
        }
        scheduleIsland();
    }

    // tapping a notification opens the app
    private static PendingIntent openApp(Context ctx) {
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        return PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildNotification(Context ctx) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_muriel)
                .setContentTitle(title)
                .setContentText(artist)
                .setLargeIcon(artwork)
                .setContentIntent(openApp(ctx))
                .setDeleteIntent(PlaybackService.intent(ctx, PlaybackService.ACTION_DISMISS, 4))
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setSilent(true)
                .setOngoing(playing)
                // Android 12 and older draw these buttons themselves; newer versions use the session's
                .addAction(shuffle ? R.drawable.ic_shuffle_on : R.drawable.ic_shuffle_off, shuffle ? "Shuffle on" : "Shuffle off",
                        PlaybackService.intent(ctx, PlaybackService.ACTION_SHUFFLE, 5))
                .addAction(android.R.drawable.ic_media_previous, "Previous", PlaybackService.intent(ctx, PlaybackService.ACTION_PREV, 1))
                .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, playing ? "Pause" : "Play",
                        PlaybackService.intent(ctx, PlaybackService.ACTION_TOGGLE, 2))
                .addAction(android.R.drawable.ic_media_next, "Next", PlaybackService.intent(ctx, PlaybackService.ACTION_NEXT, 3))
                .addAction(repeatIcon(), repeatLabel(), PlaybackService.intent(ctx, PlaybackService.ACTION_REPEAT, 6))
                .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(1, 2, 3));
        return b.build();
    }

    // What the Live Update shows. It's posted again only when this changes, or when it would remove itself too early.
    private static final class Island {
        final String title;
        final String artist;
        final Bitmap art;
        // the title, on islands that show text instead of running the clock
        final String shortText;
        // when the song would have started at normal speed: the clock counts up from it (0: no clock)
        final long clockBase;
        // then it removes itself, in case the app is gone without taking it away
        final long expires;

        Island(String title, String artist, Bitmap art, String shortText, long clockBase, long expires) {
            this.title = title;
            this.artist = artist;
            this.art = art;
            this.shortText = shortText;
            this.clockBase = clockBase;
            this.expires = expires;
        }

        boolean looksLike(Island o) {
            return o != null && title.equals(o.title) && artist.equals(o.artist) && art == o.art
                    && Objects.equals(shortText, o.shortText) && (clockBase == 0) == (o.clockBase == 0)
                    && Math.abs(clockBase - o.clockBase) < 1500;
        }
    }

    private boolean islandOn() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.BAKLAVA) return false;
        return "on".equals(islandMode) || ("auto".equals(islandMode) && "vivo".equals(VENDOR));
    }

    // while a song plays or the next one loads, with the setting on; null otherwise
    private Island islandNow() {
        // the music stopped: one that was swiped away may come back with the next
        if (!playing) islandDismissed = false;
        if (!playing || islandDismissed || !islandOn() || title.isEmpty()) return null;
        long now = System.currentTimeMillis();
        float speed = rate > 0.05f ? rate : 1f;
        long position = positionMs + (nowPlaying ? (long) ((now - positionAt) * speed) : 0);
        // at another speed than 1x the clock would run wrong
        long clockBase = nowPlaying && !ISLAND_SHOWS_TEXT && Math.abs(speed - 1f) < 0.01f ? positionAt - positionMs : 0;
        long left = nowPlaying && durationMs > 0 ? (long) (Math.max(0, durationMs - position) / speed) + 2 * 60_000 : 30 * 60_000;
        return new Island(title, artist, artwork, ISLAND_SHOWS_TEXT ? title : null, clockBase, now + left);
    }

    private synchronized void scheduleIsland() {
        islandWanted = islandNow();
        handler.removeCallbacks(islandPost);
        handler.postDelayed(islandPost, ISLAND_DELAY_MS);
    }

    // On the main thread. Android 16 promotes a notification to the island / status bar chip only if it asks for it
    // (setRequestPromotedOngoing, with POST_PROMOTED_NOTIFICATIONS in the manifest), is ongoing, has a title, isn't
    // colorized, has no custom layout, isn't a group summary, has no style or one of a few (never the media style)
    // and its channel isn't "minimal". Not posted where it won't be promoted: there it would only be a second
    // playback notification. Older Android versions never get here (islandOn).
    private void postIsland() {
        try {
            Island want = islandWanted;
            NotificationManager nm = getContext().getSystemService(NotificationManager.class);
            if (want != null && !(notificationsOn() && promotedOn())) want = null;
            if (want == null) {
                if (islandShown != null) nm.cancel(ISLAND_ID);
                islandShown = null;
                return;
            }
            if (want.looksLike(islandShown) && want.expires <= islandShown.expires + 5000) return;
            ensureIslandChannel(nm);
            nm.notify(ISLAND_ID, buildIsland(getContext(), want));
            islandShown = want;
        } catch (Throwable ignored) {
            // a phone that is missing some of this: no island, everything else goes on
        }
    }

    private void ensureIslandChannel(NotificationManager nm) {
        if (islandChannel || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        // default importance (minimal is never promoted), without sound or vibration
        NotificationChannel channel = new NotificationChannel(ISLAND_CHANNEL, "Now playing in the island", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("The song at the top of the screen while it plays (an Android 16 live update)");
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.enableLights(false);
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(channel);
        islandChannel = true;
    }

    private Notification buildIsland(Context ctx, Island s) {
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, ISLAND_CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_muriel)
                .setContentTitle(s.title)
                .setContentText(s.artist)
                .setLargeIcon(s.art)
                .setContentIntent(openApp(ctx))
                .setDeleteIntent(PlaybackService.intent(ctx, PlaybackService.ACTION_ISLAND_DISMISSED, 7))
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                // a watch already gets the playback notification
                .setLocalOnly(true)
                .setRequestPromotedOngoing(true)
                .setTimeoutAfter(Math.max(60_000, s.expires - System.currentTimeMillis()))
                // only shown while playing, so the middle button is always "pause"
                .addAction(android.R.drawable.ic_media_pause, "Pause", PlaybackService.intent(ctx, PlaybackService.ACTION_TOGGLE, 2))
                .addAction(android.R.drawable.ic_media_next, "Next", PlaybackService.intent(ctx, PlaybackService.ACTION_NEXT, 3));
        if (s.shortText != null) b.setShortCriticalText(s.shortText);
        // the chip runs the clock itself; nothing is posted for it each second
        if (s.clockBase > 0) b.setShowWhen(true).setWhen(s.clockBase).setUsesChronometer(true);
        else b.setShowWhen(false);
        return b.build();
    }

    // The Live Update went away: swiped, or its time ran out. Called by PlaybackService, on the main thread.
    void islandDismissed() {
        Island shown = islandShown;
        islandShown = null;
        if (shown != null && System.currentTimeMillis() >= shown.expires - 10_000) {
            // ran out while the music plays on (a song longer than it said): a new one
            scheduleIsland();
            return;
        }
        // swiped away: Android asks apps not to post it again, so it stays away until the music stops
        islandDismissed = true;
        islandWanted = null;
    }

    private static String vendor() {
        String who = (Build.MANUFACTURER + " " + Build.BRAND).toLowerCase(Locale.ROOT);
        if (who.contains("vivo") || who.contains("iqoo")) return "vivo";
        if (who.contains("oppo") || who.contains("oneplus") || who.contains("realme")) return "oplus";
        if (who.contains("xiaomi") || who.contains("redmi") || who.contains("poco")) return "xiaomi";
        if (who.contains("samsung")) return "samsung";
        if (who.contains("honor")) return "honor";
        return "other";
    }

    private void loadArtwork(String url) {
        if (!url.startsWith("https://")) return;
        artLoader.execute(() -> {
            Bitmap bitmap = download(url);
            if (bitmap == null || !url.equals(artworkUrl)) return;
            artwork = bitmap;
            session.setMetadata(metadata());
            refreshNotification();
        });
    }

    private static Bitmap download(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            byte[] bytes;
            try (InputStream in = conn.getInputStream()) { bytes = readAll(in); }
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / (opts.inSampleSize * 2) >= ART_SIZE) opts.inSampleSize *= 2;
            opts.inPreferredConfig = Bitmap.Config.RGB_565;
            Bitmap decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
            if (decoded == null) return null;
            // the cover is handed to the system twice (session + notification); a big one is over the
            // 1 MB limit of such a call, so keep it small
            float k = Math.min(1f, ART_SIZE / (float) Math.max(decoded.getWidth(), decoded.getHeight()));
            if (k >= 1f) return decoded;
            Bitmap scaled = Bitmap.createScaledBitmap(decoded, Math.round(decoded.getWidth() * k), Math.round(decoded.getHeight() * k), true);
            if (scaled != decoded) decoded.recycle();
            return scaled;
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            out.write(buf, 0, n);
            if (out.size() > 8 * 1024 * 1024) break;
        }
        return out.toByteArray();
    }

    void shutdown() {
        playing = false;
        releaseLocks();
        Context ctx = getContext();
        if (session != null) session.setActive(false);
        try { ctx.stopService(new Intent(ctx, PlaybackService.class)); } catch (Exception ignored) {}
        try { ctx.getSystemService(NotificationManager.class).cancel(NOTIFICATION_ID); } catch (Exception ignored) {}
        // the Live Update goes too, also one being posted right now
        islandWanted = null;
        handler.removeCallbacks(islandPost);
        handler.post(islandPost);
        try { ctx.getSystemService(NotificationManager.class).cancel(ISLAND_ID); } catch (Exception ignored) {}
    }

    @Override
    protected void handleOnDestroy() {
        shutdown();
        if (session != null) session.release();
        artLoader.shutdownNow();
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }
}
