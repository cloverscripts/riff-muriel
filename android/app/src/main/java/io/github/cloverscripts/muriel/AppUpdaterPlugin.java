package io.github.cloverscripts.muriel;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * In-app updates for Android: "Update" in the update banner (update-notifier.js, through mobile/app-updater.js)
 * downloads the new Muriel.apk from the android-latest release into the app's cache, checks it against GitHub's
 * SHA-256 for that file, and hands it to Android's installer. Android always asks the person to confirm the
 * install, and the first time also to allow installs from Muriel (install() opens that setting).
 */
@CapacitorPlugin(name = "MurielUpdater")
public class AppUpdaterPlugin extends Plugin {
    private static final long PROGRESS_EVERY_MS = 150;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private File apk() {
        return new File(new File(getContext().getCacheDir(), "updates"), "Muriel.apk");
    }

    // release downloads only: github.com links redirect to GitHub's download servers, over https all the way
    private static boolean fromGithub(String url) {
        try {
            URL u = new URL(url);
            return "https".equals(u.getProtocol()) && "github.com".equals(u.getHost());
        } catch (Exception e) {
            return false;
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", "");
        String sha256 = call.getString("sha256", "").toLowerCase(Locale.ROOT);
        long size = (long) (double) call.getDouble("size", 0.0);
        if (!fromGithub(url) || !sha256.matches("[0-9a-f]{64}")) {
            call.reject("not a verified GitHub download");
            return;
        }
        worker.execute(() -> {
            File target = apk();
            File part = new File(target.getPath() + ".part");
            HttpURLConnection conn = null;
            try {
                target.getParentFile().mkdirs();
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                if (conn.getResponseCode() != 200) throw new Exception("download failed (HTTP " + conn.getResponseCode() + ")");
                if (!"https".equals(conn.getURL().getProtocol())) throw new Exception("insecure redirect");
                long total = size > 0 ? size : conn.getContentLengthLong();
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long received = 0;
                long lastSent = 0;
                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                        digest.update(buf, 0, n);
                        received += n;
                        long now = System.currentTimeMillis();
                        if (now - lastSent > PROGRESS_EVERY_MS) {
                            lastSent = now;
                            progress(received, total);
                        }
                    }
                }
                progress(received, total);
                if (size > 0 && received != size) throw new Exception("download incomplete");
                StringBuilder hex = new StringBuilder();
                for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
                if (!hex.toString().equals(sha256)) throw new Exception("download doesn't match GitHub's checksum");
                if (target.exists() && !target.delete()) throw new Exception("couldn't replace the old download");
                if (!part.renameTo(target)) throw new Exception("couldn't save the download");
                JSObject ret = new JSObject();
                ret.put("ok", true);
                call.resolve(ret);
            } catch (Exception e) {
                part.delete();
                call.reject(e.getMessage() != null ? e.getMessage() : "download failed");
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private void progress(long received, long total) {
        JSObject p = new JSObject();
        p.put("received", received);
        p.put("total", total);
        notifyListeners("progress", p);
    }

    @PluginMethod
    public void install(PluginCall call) {
        Context ctx = getContext();
        File file = apk();
        JSObject ret = new JSObject();
        if (!file.exists()) {
            call.reject("nothing downloaded");
            return;
        }
        // Android 8+: installing needs the person's OK for Muriel once ("Install unknown apps")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(settings);
            ret.put("ok", false);
            ret.put("error", "permission");
            call.resolve(ret);
            return;
        }
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);
        ret.put("ok", true);
        call.resolve(ret);
    }
}
