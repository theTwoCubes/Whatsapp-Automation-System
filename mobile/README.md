# Android APK build

The Capacitor wrapper turns the console into a sideloadable Android APK. The
APK is a thin WebView pointing at the hosted URL in `capacitor.config.json`
(set per deployment), so shipping a new UI does not require
rebuilding or re-installing the app - the client just closes and reopens it.

Rebuild the APK only when the app id, the hosted URL, the native shell, or the
set of Capacitor plugins changes.

## One-time setup (per machine)

1. Install Android Studio (or just the command-line SDK) and set `ANDROID_HOME`.
   `scripts/build-apk.sh` auto-detects `~/Android/Sdk` if it is there.
2. Install a JDK (21 is fine) and set `JAVA_HOME`.
3. From the repo root, install dependencies. The Capacitor packages live in
   `devDependencies`, so a plain install is enough:

   ```bash
   npm install
   ```

4. Scaffold the Android project once:

   ```bash
   npx cap add android
   ```

   This creates `android/`, which is gitignored and regenerated on demand.

## Every build

```bash
npm run apk
```

That wraps `scripts/build-apk.sh`, which checks the toolchain, builds the web
bundle, runs `npx cap sync android`, stamps the version from `package.json`
into `build.gradle`, and assembles the APK. The result lands at:

    build/console-latest.apk          (plus a timestamped copy alongside it)

Copy that APK to the client's phone (email/USB/drive) and tap to install.
Android asks them to allow installs from unknown sources the first time.

To do the same steps by hand:

```bash
(cd web && npm run build)
npx cap sync android
(cd android && ./gradlew assembleDebug)
```

`cap sync` prints the plugins it found. It should list five: `app`,
`filesystem`, `haptics`, `push-notifications`, and `share`. A plugin the
console imports but that is missing from this list is not in the APK, and the
dynamic `import()` for it fails at runtime on the device.

## Push notifications inside the APK

The APK path uses Firebase Cloud Messaging; the browser path uses Web Push.
Both are already implemented in `src/push.js` on the backend, which picks the
transport per subscription row. To deliver to the APK you need a Firebase
project:

1. Create a project at <https://console.firebase.google.com>.
2. Add an Android app using the app id from `capacitor.config.json`:
   `com.wamanager.console`. It has to match exactly or no push arrives.
3. Download `google-services.json` and drop it in `android/app/`. Do not
   commit it.
4. Firebase console, Project settings, Service accounts, Generate new private
   key. Base64 encode the downloaded json and set it as
   `FCM_SERVICE_ACCOUNT_JSON` in the backend `.env`:

   ```bash
   base64 -w 0 your-service-account.json
   ```

   The project id is read from that json, so there is nothing else to set.
5. Restart the backend and reinstall the APK.

With `FCM_SERVICE_ACCOUNT_JSON` unset the backend logs nothing and simply
stores FCM tokens without sending to them; the browser web push path keeps
working normally.

## Web push (no Firebase needed)

Generate VAPID keys once:

```bash
node scripts/generate-vapid.js >> .env
```

Restart the backend and the console offers "Turn on notifications" in the top
banner. Works on desktop Chrome/Edge/Firefox/Safari and Android Chrome. On iOS
the user must first install the site to the home screen (Share, then Add to
Home Screen) before permission can be granted.
