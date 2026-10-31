package net.comic8muses.reader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Một WebView duy nhất, cộng một proxy nhỏ ngay trong app.
 *
 * Trang nguồn (comics.8muses.com) không trả CORS cho origin của app, nên phần
 * giao diện không thể fetch thẳng HTML/ảnh. Java nhận các đường nội bộ:
 *
 *   /api/page?u=/porn...   tải HTML (có cache đĩa, đọc offline được)
 *   /img?u=/image/fm/...   trả ảnh, tự lưu vào bộ nhớ đệm
 *   /api/save?u=...&k=...  tải trước một ảnh (nút "Tải cả bộ")
 *   /api/cache             thống kê dung lượng
 *   /api/delete?album=...  xoá ảnh của một album
 *   /api/clear             xoá toàn bộ ảnh đã lưu
 *
 * Ảnh của album nằm ở files/comics/fm/<albumId>/<số trang>.jpg. Nhờ vậy xoá
 * theo album, tính dung lượng theo album và đọc offline đều đơn giản.
 */
public class MainActivity extends Activity {

    private static final String BASE = "https://appassets.androidplatform.net";
    private static final String HOST = "appassets.androidplatform.net";
    private static final String SITE = "https://comics.8muses.com";

    private static final String UA =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    private static final String ACCEPT_HTML =
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    private static final String ACCEPT_IMG =
            "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";

    /** HTML cũ hơn 6 giờ thì trả bản đã lưu ngay, cập nhật ngầm cho lần sau. */
    private static final long PAGE_TTL = 6L * 60L * 60L * 1000L;
    private static final int MAX_BYTES = 32 * 1024 * 1024;

    private WebView web;
    private File cacheRoot;
    private File imgDir;
    private File miscDir;
    private File pageDir;

    private final ConcurrentHashMap<String, Object> locks = new ConcurrentHashMap<>();
    private final Set<String> refreshing = ConcurrentHashMap.newKeySet();
    private final ExecutorService bg = Executors.newFixedThreadPool(2);

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        cacheRoot = new File(getFilesDir(), "comics");
        imgDir = new File(cacheRoot, "fm");
        miscDir = new File(cacheRoot, "misc");
        pageDir = new File(cacheRoot, "pages");
        // noinspection ResultOfMethodCallIgnored
        imgDir.mkdirs();
        // noinspection ResultOfMethodCallIgnored
        miscDir.mkdirs();
        // noinspection ResultOfMethodCallIgnored
        pageDir.mkdirs();

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#12100E"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " Comic8muses/1.0");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return intercept(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(Uri.parse(url));
            }
        });

        String html = readAsset("web/app.html");
        if (html == null) {
            Toast.makeText(this, "Thiếu giao diện trong APK", Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        web.loadDataWithBaseURL(BASE + "/", html, "text/html", "UTF-8", BASE + "/");
        setContentView(web);
    }

    /* ------------------------------------------------------------------ */
    /* Proxy                                                              */
    /* ------------------------------------------------------------------ */

    private WebResourceResponse intercept(Uri uri) {
        if (uri == null || !HOST.equals(uri.getHost())) return null;

        String path = uri.getPath();
        if (path == null) return null;

        Map<String, String> q = query(uri);
        try {
            if ("/api/page".equals(path)) return apiPage(q.get("u"));
            if ("/img".equals(path)) return img(q.get("u"), q.get("k"));
            if ("/api/save".equals(path)) return apiSave(q.get("u"), q.get("k"));
            if ("/api/cache".equals(path)) return apiCache();
            if ("/api/delete".equals(path)) return apiDelete(q.get("album"), q.get("k"));
            if ("/api/clear".equals(path)) return apiClear();
        } catch (Exception e) {
            return json(502, "{\"error\":\"" + esc(friendly(e)) + "\"}");
        }
        return null;
    }

    private WebResourceResponse apiPage(String u) throws IOException {
        if (!validPagePath(u)) return json(400, "{\"error\":\"Đường dẫn không hợp lệ\"}");

        File f = new File(pageDir, sha1(u) + ".html");
        Object lock = locks.computeIfAbsent("page:" + u, x -> new Object());
        byte[] data;
        boolean stale = false;

        synchronized (lock) {
            data = f.isFile() && f.length() > 0 ? readFile(f) : null;
            if (data == null) {
                data = download(SITE + u, ACCEPT_HTML);
                writeAtomic(f, data);
            } else {
                stale = System.currentTimeMillis() - f.lastModified() > PAGE_TTL;
            }
        }
        if (stale) refreshPage(u, f);

        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        h.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("text/html", "utf-8", 200, "OK", h,
                new ByteArrayInputStream(data));
    }

    private void refreshPage(final String u, final File f) {
        if (!refreshing.add(u)) return;
        bg.execute(new Runnable() {
            @Override
            public void run() {
                Object lock = locks.computeIfAbsent("page:" + u, x -> new Object());
                synchronized (lock) {
                    try {
                        byte[] fresh = download(SITE + u, ACCEPT_HTML);
                        if (fresh.length > 0) writeAtomic(f, fresh);
                    } catch (Exception ignored) {
                        // Mất mạng thì giữ bản cũ, không báo lỗi.
                    } finally {
                        refreshing.remove(u);
                    }
                }
            }
        });
    }

    private WebResourceResponse img(String u, String k) throws IOException {
        if (!validImagePath(u)) return status(400, "Đường dẫn ảnh không hợp lệ");

        String key = validKey(k) ? k : "misc/" + sha1(u);
        String ext = u.toLowerCase(Locale.US).endsWith(".png") ? ".png" : ".jpg";
        File f = new File(cacheRoot, key + ext);

        Object lock = locks.computeIfAbsent(key, x -> new Object());
        synchronized (lock) {
            if (!f.isFile() || f.length() == 0) {
                byte[] data = download(SITE + u, ACCEPT_IMG);
                writeAtomic(f, data);
            }
        }

        if (!f.isFile() || f.length() == 0) return status(404, "Không có ảnh");
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        h.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse(ext.equals(".png") ? "image/png" : "image/jpeg", null,
                200, "OK", h, new FileInputStream(f));
    }

    private WebResourceResponse apiSave(String u, String k) throws IOException {
        if (!validImagePath(u)) return json(400, "{\"error\":\"Đường dẫn ảnh không hợp lệ\"}");
        if (!validKey(k)) return json(400, "{\"error\":\"Khoá lưu không hợp lệ\"}");

        String ext = u.toLowerCase(Locale.US).endsWith(".png") ? ".png" : ".jpg";
        File f = new File(cacheRoot, k + ext);

        Object lock = locks.computeIfAbsent(k, x -> new Object());
        boolean existed;
        synchronized (lock) {
            existed = f.isFile() && f.length() > 0;
            if (!existed) {
                byte[] data = download(SITE + u, ACCEPT_IMG);
                writeAtomic(f, data);
            }
        }
        long len = f.length();
        return json(200, "{\"ok\":true,\"bytes\":" + len + ",\"cached\":" + existed + "}");
    }

    private WebResourceResponse apiCache() {
        long total = 0;
        long imgBytes = 0;
        int imgFiles = 0;

        StringBuilder albums = new StringBuilder();
        File[] dirs = imgDir.listFiles();
        if (dirs != null) {
            for (File d : dirs) {
                if (!d.isDirectory()) continue;
                long b = dirSize(d);
                int n = countFiles(d);
                if (n == 0) continue;
                imgBytes += b;
                imgFiles += n;
                if (albums.length() > 0) albums.append(',');
                albums.append("{\"id\":\"").append(d.getName()).append("\",\"files\":")
                        .append(n).append(",\"bytes\":").append(b).append('}');
            }
        }

        long miscBytes = dirSize(miscDir);
        int miscFiles = countFiles(miscDir);
        long pageBytes = dirSize(pageDir);
        int pageFiles = countFiles(pageDir);
        total = imgBytes + miscBytes + pageBytes;

        return json(200, "{\"total\":" + total
                + ",\"images\":" + imgFiles
                + ",\"imageBytes\":" + imgBytes
                + ",\"misc\":" + miscFiles
                + ",\"miscBytes\":" + miscBytes
                + ",\"pages\":" + pageFiles
                + ",\"pageBytes\":" + pageBytes
                + ",\"albums\":[" + albums + "]}");
    }

    private WebResourceResponse apiDelete(String album, String k) throws IOException {
        long freed = 0;
        if (album != null && album.matches("[a-z0-9]{4,20}")) {
            File d = new File(imgDir, album);
            freed += dirSize(d);
            deleteTree(d);
            return json(200, "{\"ok\":true,\"freed\":" + freed + "}");
        }
        if (validKey(k)) {
            freed += deleteCached(k);
            return json(200, "{\"ok\":true,\"freed\":" + freed + "}");
        }
        return json(400, "{\"error\":\"Thiếu album hoặc khoá\"}");
    }

    private WebResourceResponse apiClear() {
        long freed = dirSize(imgDir) + dirSize(miscDir) + dirSize(pageDir);
        clearDir(imgDir);
        clearDir(miscDir);
        clearDir(pageDir);
        return json(200, "{\"ok\":true,\"freed\":" + freed + "}");
    }

    /* ------------------------------------------------------------------ */
    /* Mạng                                                               */
    /* ------------------------------------------------------------------ */

    private byte[] download(String urlStr, String accept) throws IOException {
        IOException last = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection c = null;
            try {
                URL url = new URL(urlStr);
                c = (HttpURLConnection) url.openConnection();
                c.setInstanceFollowRedirects(true);
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setRequestMethod("GET");
                c.setRequestProperty("User-Agent", UA);
                c.setRequestProperty("Accept", accept);
                c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
                c.setRequestProperty("Accept-Encoding", "identity");
                c.setRequestProperty("Referer", SITE + "/");

                int code = c.getResponseCode();
                if (code == 200) {
                    InputStream in = c.getInputStream();
                    try {
                        return readAll(in);
                    } finally {
                        in.close();
                    }
                }
                last = new IOException("Nguồn trả HTTP " + code);
                if (code < 500 && code != 429) throw last;
            } catch (IOException e) {
                last = e;
            } finally {
                if (c != null) c.disconnect();
            }
            if (attempt == 0) {
                try {
                    Thread.sleep(450);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        throw last != null ? last : new IOException("Không kết nối được");
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[32 * 1024];
        int n;
        int total = 0;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > MAX_BYTES) throw new IOException("Dữ liệu quá lớn");
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private static String friendly(Exception e) {
        String m = e.getMessage();
        if (m == null || m.length() == 0) m = "Không tải được dữ liệu";
        return m;
    }

    /* ------------------------------------------------------------------ */
    /* Kiểm tra đường dẫn, tệp                                            */
    /* ------------------------------------------------------------------ */

    /** u là đường dẫn đã mã hoá đúng như trong href của trang nguồn. */
    private static boolean validPagePath(String u) {
        if (u == null || u.length() > 500) return false;
        if (!u.equals("/porn") && !u.startsWith("/porn/")) return false;
        if (u.contains("..") || u.contains("\\") || u.contains("#") || u.contains(" ")) return false;
        int q = u.indexOf('?');
        if (q >= 0) {
            String query = u.substring(q + 1);
            if (!query.matches("sort=(like|date|az|view)")) return false;
            if (u.substring(0, q).contains("?")) return false;
        }
        return true;
    }

    private static boolean validImagePath(String u) {
        if (u == null || u.length() > 700) return false;
        if (!u.startsWith("/image/")) return false;
        if (u.contains("..") || u.contains("\\") || u.contains("#") || u.contains(" ")) return false;
        return u.indexOf('?') < 0;
    }

    private static boolean validKey(String k) {
        if (k == null) return false;
        if (k.matches("(fm|th)/[a-z0-9]{4,20}/[0-9]{1,4}")) return true;
        return k.matches("misc/[a-f0-9]{40}");
    }

    private File resolveKey(String k) {
        if (!validKey(k)) return null;
        File f = new File(cacheRoot, k + ".jpg");
        try {
            String root = cacheRoot.getCanonicalPath();
            String p = f.getCanonicalPath();
            return p.startsWith(root + File.separator) ? f : null;
        } catch (IOException e) {
            return null;
        }
    }

    private long deleteCached(String k) {
        if (!validKey(k)) return 0;
        long freed = 0;
        for (String ext : new String[]{".jpg", ".png"}) {
            File f = new File(cacheRoot, k + ext);
            try {
                String root = cacheRoot.getCanonicalPath();
                String p = f.getCanonicalPath();
                if (p.startsWith(root + File.separator) && f.isFile()) {
                    freed += f.length();
                    // noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            } catch (IOException ignored) {
                // bỏ qua tệp không hợp lệ
            }
        }
        return freed;
    }

    private static long dirSize(File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        long n = 0;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) n += dirSize(k);
        return n;
    }

    private static int countFiles(File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return 1;
        int n = 0;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) n += countFiles(k);
        return n;
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        // noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static void clearDir(File dir) {
        File[] kids = dir == null ? null : dir.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
    }

    private static void writeAtomic(File f, byte[] data) throws IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.isDirectory()) {
            // noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        }
        File tmp = new File(parent, f.getName() + ".tmp");
        FileOutputStream out = new FileOutputStream(tmp);
        try {
            out.write(data);
            out.flush();
            out.getFD().sync();
        } finally {
            out.close();
        }
        if (!tmp.renameTo(f)) {
            // noinspection ResultOfMethodCallIgnored
            f.delete();
            if (!tmp.renameTo(f)) {
                // noinspection ResultOfMethodCallIgnored
                tmp.delete();
                throw new IOException("Không ghi được bộ nhớ đệm");
            }
        }
    }

    private static byte[] readFile(File f) {
        try {
            InputStream in = new FileInputStream(f);
            try {
                return readAll(in);
            } finally {
                in.close();
            }
        } catch (IOException e) {
            return null;
        }
    }

    private static String sha1(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] b = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(40);
            for (byte x : b) sb.append(String.format(Locale.US, "%02x", x));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }

    /** Đọc query nhưng giữ nguyên dấu '+', vì token ảnh của nguồn dùng '+'. */
    private static Map<String, String> query(Uri uri) {
        Map<String, String> m = new HashMap<>();
        String q = uri.getEncodedQuery();
        if (q == null) return m;
        String[] parts = q.split("&");
        for (String part : parts) {
            int i = part.indexOf('=');
            String k = i < 0 ? part : part.substring(0, i);
            String v = i < 0 ? "" : part.substring(i + 1);
            m.put(percentDecode(k), percentDecode(v));
        }
        return m;
    }

    private static String percentDecode(String s) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '%' && i + 2 < s.length()) {
                int hi = Character.digit(s.charAt(i + 1), 16);
                int lo = Character.digit(s.charAt(i + 2), 16);
                if (hi >= 0 && lo >= 0) {
                    out.write((hi << 4) + lo);
                    i += 2;
                    continue;
                }
            }
            byte[] b = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
            out.write(b, 0, b.length);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String esc(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", " ").replace("\r", " ");
    }

    /* ------------------------------------------------------------------ */
    /* Trả lời                                                            */
    /* ------------------------------------------------------------------ */

    private static WebResourceResponse json(int code, String body) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        h.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("application/json", "utf-8", code, reason(code), h,
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    private static WebResourceResponse status(int code, String text) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", code, reason(code), h,
                new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)));
    }

    private static String reason(int code) {
        if (code == 200) return "OK";
        if (code == 400) return "Bad Request";
        if (code == 404) return "Not Found";
        return "Error";
    }

    /* ------------------------------------------------------------------ */
    /* WebView                                                            */
    /* ------------------------------------------------------------------ */

    private boolean handleUrl(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (("https".equals(scheme) || "http".equals(scheme)) && HOST.equals(uri.getHost())) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, "Không mở được liên kết", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private String readAsset(String name) {
        try {
            InputStream in = getAssets().open(name);
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return new String(out.toByteArray(), StandardCharsets.UTF_8);
            } finally {
                in.close();
            }
        } catch (Exception e) {
            return null;
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        bg.shutdownNow();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
