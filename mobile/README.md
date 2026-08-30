# Android APK build

The Capacitor wrapper turns the console into a sideloadable Android APK. The
APK is a thin WebView pointing at your hosted URL, so shipping a new UI does
not require rebuilding or re-installing the app — the client just closes and
reopens it.

## One-time setup (on your laptop)

1. Install Android Studio (or just the command-line SDK) and set `ANDROID_HOME`.
2. In the repo root run:

   ```bash
   npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/push-notifications
   ```

3. Edit `capacitor.config.json` — replace `REPLACE_WITH_YOUR_HOSTED_URL` with
   the URL your VPS serves the console at (e.g. `https://console.advoice.in`).
4. Scaffold the Android project once:

   ```bash
   npx cap add android
   ```

   This creates `android/`. Do not commit `android/app/google-services.json` if
   you generate one.

## Every build

```bash
# 1. Build the web bundle first
(cd web && npm run build)

# 2. Sync into the Android project
npx cap sync android

# 3. Produce an APK
(cd android && ./gradlew assembleDebug)
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Copy that APK to the client's phone (email/USB/drive), tap to install. Android
will ask them to allow installs from unknown sources the first time.

## Push notifications inside the APK

The `PushNotifications` plugin is already wired in `web/src/push.js`. It talks
to Firebase Cloud Messaging (FCM). To actually deliver pushes to the APK you
need a free Firebase project:

1. Create a project at <https://console.firebase.google.com>.
2. Add an Android app with the appId from `capacitor.config.json`
   (`com.thetwocubes.console`).
3. Download `google-services.json` and drop it in `android/app/`.
4. In the Firebase project settings, grab the *Server key* under Cloud
   Messaging and set it as `FCM_SERVER_KEY` in the backend `.env`.
5. Extend `src/push.js` on the backend to POST to
   `https://fcm.googleapis.com/fcm/send` for rows with `transport = 'fcm'`.

Until step 5 is done, FCM tokens are stored but no push is delivered to the
APK — the browser web push path keeps working normally.

## Web push (already live)

The browser path needs no Firebase. Generate VAPID keys once:

```bash
node scripts/generate-vapid.js >> .env
```

Restart the backend, and the console will offer "Turn on notifications" in the
top banner. Works on desktop Chrome/Edge/Firefox/Safari and Android Chrome. On
iOS the user must first install the site to the home screen (Share → Add to
Home Screen), then permission is grantable.
