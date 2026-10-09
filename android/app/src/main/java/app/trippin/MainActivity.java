package app.trippin;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * Thin native shell around the Trippin' web app (bundled in assets, served from a secure https origin).
 * WebView has no Web Bluetooth, so BLE (for the OBD-II adapter), text-to-speech, keep-awake and file saving
 * are exposed to the page as window.TrippinNative — see trippin/js/native.js for the matching JS side.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final int REQ_PERMS = 41;
    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private Runnable afterPerms;
    private GeolocationPermissions.Callback pendingGeo;
    private String pendingGeoOrigin;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return loader.shouldInterceptRequest(r.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    cb.invoke(origin, true, false);
                } else {
                    pendingGeo = cb; pendingGeoOrigin = origin;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_PERMS);
                }
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) { request.deny(); }
        });
        web.addJavascriptInterface(new Bridge(), "TrippinNative");
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) { ttsReady = true; tts.setLanguage(Locale.getDefault()); }
        });
        web.loadUrl("https://" + HOST + "/assets/trippin/index.html");
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        boolean ok = results.length > 0;
        for (int r : results) if (r != PackageManager.PERMISSION_GRANTED) ok = false;
        if (pendingGeo != null) {
            boolean loc = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            pendingGeo.invoke(pendingGeoOrigin, loc, false); pendingGeo = null;
        }
        Runnable r = afterPerms; afterPerms = null;
        if (r != null && ok) r.run();
        else if (r != null) { js("MPN.onBleState('error','Permission was denied')"); js("MPN.onSpeechEnd('permission denied')"); }
    }

    /** Back: the page closes sheets / the HUD / leaves a tab for Drive; on Drive it sends the app to the background (a drive keeps running). */
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.MPN && MPN.handleBack && MPN.handleBack()) === true", value -> {
            if (!"true".equals(value)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onDestroy() {
        Bridge.closeGatt();
        if (recognizer != null) { recognizer.destroy(); recognizer = null; }
        if (tts != null) { tts.stop(); tts.shutdown(); }
        super.onDestroy();
    }

    private void js(final String code) {
        ui.post(() -> web.evaluateJavascript("window.MPN && " + code, null));
    }

    private static String q(String s) { return s == null ? "null" : JSONObject.quote(s); }

    /** Ask for any of `perms` not yet granted, then run `then`. */
    private void withPerms(List<String> perms, Runnable then) {
        List<String> need = new ArrayList<>();
        for (String p : perms) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) need.add(p);
        if (need.isEmpty()) { then.run(); return; }
        afterPerms = then;
        requestPermissions(need.toArray(new String[0]), REQ_PERMS);
    }

    /** Runtime permissions needed for BLE on this Android version, then run `then`. */
    private void withBlePerms(Runnable then) {
        withPerms(Build.VERSION.SDK_INT >= 31
                ? Arrays.asList(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
                : Arrays.asList(Manifest.permission.ACCESS_FINE_LOCATION), then);
    }

    private void startListening() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) { js("MPN.onSpeechEnd('no speech service on this phone')"); return; }
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(new RecognitionListener() {
                private String text(Bundle b) {
                    ArrayList<String> r = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    return r == null || r.isEmpty() ? "" : r.get(0);
                }
                @Override public void onPartialResults(Bundle b) { String t = text(b); if (!t.isEmpty()) js("MPN.onSpeech(" + q(t) + ",false)"); }
                @Override public void onResults(Bundle b) { String t = text(b); if (t.isEmpty()) js("MPN.onSpeechEnd('nothing heard')"); else js("MPN.onSpeech(" + q(t) + ",true)"); }
                @Override public void onError(int code) { js("MPN.onSpeechEnd('code " + code + "')"); }
                @Override public void onReadyForSpeech(Bundle b) { }
                @Override public void onBeginningOfSpeech() { }
                @Override public void onRmsChanged(float v) { }
                @Override public void onBufferReceived(byte[] b) { }
                @Override public void onEndOfSpeech() { }
                @Override public void onEvent(int t, Bundle b) { }
            });
        }
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag());
        recognizer.startListening(i);
    }

    /** window.TrippinNative */
    @SuppressLint("MissingPermission")
    public class Bridge {
        private BluetoothGatt gatt;
        private BluetoothGattCharacteristic rx, tx;
        private ScanCallback scanCb;
        private boolean scanning = false;
        private BluetoothAdapter adapter() {
            BluetoothManager m = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
            return m == null ? null : m.getAdapter();
        }
        private static Bridge current;
        Bridge() { current = this; }
        static void closeGatt() { if (current != null && current.gatt != null) { try { current.gatt.close(); } catch (Exception ignored) { } } }

        @JavascriptInterface public String version() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
        }

        /* ------------------------------------------------------ speech in */
        @JavascriptInterface public void listen() {
            ui.post(() -> withPerms(Arrays.asList(Manifest.permission.RECORD_AUDIO), MainActivity.this::startListening));
        }
        @JavascriptInterface public void cancelListen() {
            ui.post(() -> { if (recognizer != null) recognizer.cancel(); });
        }

        @JavascriptInterface public void keepAwake(final boolean on) {
            ui.post(() -> { if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); });
        }

        @JavascriptInterface public void vibrate(long ms) {
            android.os.Vibrator v = (android.os.Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (v != null) v.vibrate(ms);
        }

        @JavascriptInterface public void speak(String text, float rate) {
            if (!ttsReady) return;
            tts.setSpeechRate(rate <= 0 ? 1f : rate);
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "mp");
        }
        @JavascriptInterface public void stopSpeak() { if (tts != null) tts.stop(); }

        @JavascriptInterface public void share(String text) {
            Intent i = new Intent(Intent.ACTION_SEND); i.setType("text/plain"); i.putExtra(Intent.EXTRA_TEXT, text);
            startActivity(Intent.createChooser(i, "Share").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        @JavascriptInterface public void openUrl(String url) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { }
        }

        @JavascriptInterface public boolean saveFile(String name, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, name); v.put(MediaStore.Downloads.MIME_TYPE, mime); v.put(MediaStore.Downloads.IS_PENDING, 1);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return false;
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) { os.write(bytes); }
                    v.clear(); v.put(MediaStore.Downloads.IS_PENDING, 0); getContentResolver().update(uri, v, null, null);
                } else {
                    java.io.File f = new java.io.File(getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS), name);
                    try (java.io.FileOutputStream os = new java.io.FileOutputStream(f)) { os.write(bytes); }
                }
                ui.post(() -> Toast.makeText(MainActivity.this, "Saved to Downloads: " + name, Toast.LENGTH_SHORT).show());
                return true;
            } catch (Exception e) { return false; }
        }

        /* ------------------------------------------------------------ BLE */
        @JavascriptInterface public void bleScan(final int ms) {
            ui.post(() -> withBlePerms(() -> startScan(ms)));
        }
        private void startScan(int ms) {
            BluetoothAdapter a = adapter();
            if (a == null || !a.isEnabled()) { js("MPN.onBleState('error','Turn Bluetooth on first')"); js("MPN.onScanDone()"); return; }
            stopScan();
            scanCb = new ScanCallback() {
                @Override public void onScanResult(int type, ScanResult r) {
                    BluetoothDevice d = r.getDevice();
                    String name = r.getScanRecord() != null ? r.getScanRecord().getDeviceName() : null;
                    if (name == null) { try { name = d.getName(); } catch (SecurityException ignored) { } }
                    js("MPN.onScanResult(" + q(d.getAddress()) + "," + q(name) + "," + r.getRssi() + ")");
                }
            };
            scanning = true;
            a.getBluetoothLeScanner().startScan(scanCb);
            ui.postDelayed(() -> { if (scanning) { stopScan(); js("MPN.onScanDone()"); } }, Math.max(2000, ms));
        }
        private void stopScan() {
            BluetoothAdapter a = adapter();
            if (scanning && a != null && a.getBluetoothLeScanner() != null && scanCb != null) { try { a.getBluetoothLeScanner().stopScan(scanCb); } catch (Exception ignored) { } }
            scanning = false;
        }
        @JavascriptInterface public void bleStopScan() { ui.post(this::stopScan); }

        @JavascriptInterface public void bleConnect(final String id) {
            ui.post(() -> withBlePerms(() -> {
                stopScan();
                BluetoothAdapter a = adapter();
                if (a == null) { js("MPN.onBleState('error','No Bluetooth')"); return; }
                if (gatt != null) { try { gatt.close(); } catch (Exception ignored) { } gatt = null; }
                BluetoothDevice dev = a.getRemoteDevice(id);
                gatt = Build.VERSION.SDK_INT >= 23 ? dev.connectGatt(MainActivity.this, false, cb, BluetoothDevice.TRANSPORT_LE) : dev.connectGatt(MainActivity.this, false, cb);
            }));
        }

        @JavascriptInterface public void bleWrite(String text) {
            if (gatt == null || tx == null) return;
            byte[] data = text.getBytes(StandardCharsets.ISO_8859_1);
            for (int i = 0; i < data.length; i += 20) {
                byte[] part = java.util.Arrays.copyOfRange(data, i, Math.min(data.length, i + 20));
                tx.setValue(part);
                tx.setWriteType((tx.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0 ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                gatt.writeCharacteristic(tx);
                try { Thread.sleep(12); } catch (InterruptedException ignored) { }
            }
        }

        @JavascriptInterface public void bleDisconnect() {
            ui.post(() -> { if (gatt != null) { try { gatt.disconnect(); gatt.close(); } catch (Exception ignored) { } gatt = null; rx = null; tx = null; } });
        }

        private final BluetoothGattCallback cb = new BluetoothGattCallback() {
            @Override public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
                if (newState == android.bluetooth.BluetoothProfile.STATE_CONNECTED) {
                    ui.postDelayed(g::discoverServices, 600);
                } else if (newState == android.bluetooth.BluetoothProfile.STATE_DISCONNECTED) {
                    js("MPN.onBleState('closed','Adapter disconnected')");
                }
            }
            @Override public void onServicesDiscovered(BluetoothGatt g, int status) {
                BluetoothGattCharacteristic n = null, w = null;
                for (BluetoothGattService s : g.getServices()) {
                    BluetoothGattCharacteristic sn = null, sw = null;
                    for (BluetoothGattCharacteristic c : s.getCharacteristics()) {
                        int p = c.getProperties();
                        if (sn == null && (p & (BluetoothGattCharacteristic.PROPERTY_NOTIFY | BluetoothGattCharacteristic.PROPERTY_INDICATE)) != 0) sn = c;
                        if (sw == null && (p & (BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)) != 0) sw = c;
                    }
                    if (sn != null && sw != null) { n = sn; w = sw; break; }
                }
                if (n == null) { js("MPN.onBleState('error','No UART service on this device — is it a BLE adapter?')"); return; }
                rx = n; tx = w;
                g.setCharacteristicNotification(rx, true);
                BluetoothGattDescriptor d = rx.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"));
                if (d == null) { js("MPN.onBleState('connected','')"); return; }
                d.setValue((rx.getProperties() & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0 ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE : BluetoothGattDescriptor.ENABLE_INDICATION_VALUE);
                g.writeDescriptor(d);
            }
            @Override public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) { js("MPN.onBleState('connected','')"); }
            @Override public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
                byte[] v = c.getValue();
                if (v != null) js("MPN.onBleData(" + q(new String(v, StandardCharsets.ISO_8859_1)) + ")");
            }
        };
    }
}
