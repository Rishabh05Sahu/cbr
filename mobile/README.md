# CBR CRM: Android and iPhone app (Flutter)

The CRM's phone app for Android and iPhone. It uses the same backend and database as the website through the bearer-only `/api/v1` API ([ADR-0027](../docs/architecture/adr/ADR-0027-android-app.md)).
- **App ID:** `com.crystalbricks.crm`
- **Release server:** `https://crm.crystalbricksroofs.com`

## Develop

```sh
cd mobile
flutter pub get
flutter run                                                     # against the live server
flutter run --dart-define=API_BASE_URL=http://192.168.1.7:3000  # a server on this PC (debug builds allow http)
```

Local test logins: `npx tsx --env-file=.env scripts/dev/seed-app-test.mts` (local database only).

## Checks

```sh
flutter analyze
flutter test
```

## Release (Google Play)

1. Increase `version:` in `pubspec.yaml` for every upload. For example, `1.0.1+2`: the number after `+` must always go up.
2. Build: `flutter build appbundle --release`. The output is `build/app/outputs/bundle/release/app-release.aab`.
3. Upload the `.aab` in Play Console.

### Signing
- The release build is signed with the **upload key** named in `android/key.properties`.
- That file and the keystore are git-ignored. The keystore lives outside the repository, in `C:\Users\aDMIN\cbr-play-keys\` (see its `README.txt`). **Back that folder up.**
- Google re-signs the app with its own key (Play App Signing). A lost upload key can be reset through Play support, but that takes time.
- Without `key.properties`, release builds fall back to the debug key, and Play refuses them.

### Release behaviour
- Screenshots and screen recording are blocked (`FLAG_SECURE` in `MainActivity.kt`). Debug builds allow them, so take store screenshots from a debug build.
- Only HTTPS connections are allowed. Plain `http` is allowed in debug builds only (`src/debug/AndroidManifest.xml`).

### Store material
- `store/play-listing.md`: descriptions, Data safety and App content answers.
- `store/play-icon-512.png`: the store icon.
- `assets/icon/`: the launcher icon source. Regenerate with `dart run flutter_launcher_icons`.

## Release (iPhone)

iPhone apps can only be built on a Mac, so the iPhone build runs on Codemagic's cloud Macs (`codemagic.yaml` at the repository root, workflow `ios-testflight`). It is started by hand and uploads to **TestFlight**; staff install the app from Apple's TestFlight app.

- **Project:** `ios/`, bundle ID `com.crystalbricks.crm`, iOS 15 or later (the Firebase SDK's minimum), display name *CBR CRM*.
- **Permissions:** camera and photos (property photos), Face ID (app lock). `Runner/Info.plist` holds the wording Apple shows.
- **Screenshots:** iPhones do not let apps block screenshots. Release builds cover the app in the app switcher instead (`lib/privacy_cover.dart`).

### One-time setup (owner)
1. **Apple Developer Program:** enrol at developer.apple.com ($99 a year, as an organisation if possible, which needs a D-U-N-S number).
2. **App Store Connect:** create the app with bundle ID `com.crystalbricks.crm`. Then go to *Users and Access → Integrations* and create an API key with the *App Manager* role.
3. **Codemagic:** sign in with GitHub and add this repository. Add the API key under *Team settings → Integrations → Developer Portal* with the name `CBR App Store Connect`. Under *Code signing → iOS*, generate or fetch an App Store distribution certificate and profile for `com.crystalbricks.crm`.
4. Start the `ios-testflight` workflow. When the build appears in TestFlight, add testers by email.

### Each release
Raise `version:` in `pubspec.yaml`; TestFlight refuses a build number it has already seen. Then start the workflow.

### Push notifications on iPhone (later)
Push is off in the iPhone build until all of these are done. The rest of the app works without them.
1. In the Firebase console, add an iOS app with the bundle ID `com.crystalbricks.crm`.
2. Upload an APNs key (Apple Developer → Keys) to Firebase under *Cloud Messaging*.
3. Add `GoogleService-Info.plist` to the Runner target in Xcode. It must be in the project, not only in the folder.
4. Turn on the *Push Notifications* capability (`aps-environment` entitlement) for `com.crystalbricks.crm`.

The server sends iPhone pushes through FCM as it does for Android; no server change is needed.

## Push notifications (Firebase)
Push is off until both halves are configured:
1. **App:** in the Firebase console, add an Android app with package name `com.crystalbricks.crm`. Download `google-services.json` into `mobile/android/app/` and rebuild. The file is not a secret; it ships inside the APK.
2. **Server:** in Project settings → Service accounts, choose *Generate new private key*. Put the JSON, on one line or base64-encoded, in `FCM_SERVICE_ACCOUNT_JSON` in `/opt/crm/worker.env`, then restart the worker. This file **is** a secret: never commit it.

Without the file, the app builds and runs with in-app notifications only. Without the key, the server sends no push.

## Scope (slices 1–2)
These screens are built:
- Sign-in, two-step verification and the organisation picker.
- Tabs by role.
- My Day.
- Leads: search, filters and paging.
- Lead screen: Reveal, Call and WhatsApp with the outcome sheet, script, follow-ups, visits and requirements.
- More: switch organisation, website, privacy policy and account deletion.

- Visits (1.0.3): outcome due, today, upcoming and recently closed. Confirm, reschedule, cancel, and record attended or no-show (`GET /api/v1/visits`, `POST /api/v1/visits/:id`).
- My Day (1.0.3): Done and Reschedule on one's own follow-ups and tasks, including those on leads the person may change (`POST /api/v1/tasks/:id/complete`, `POST /api/v1/tasks/:id/reschedule`).

- Lead screen (1.0.4), the same as the website's lead page:
  - **Log outcome:** every channel; who made contact; when; duration; notes; the contact-status confirmation; an optional requirements update; the follow-up (mark mine done, the next one at a chosen time with a title, or a reschedule with a reason).
  - **Book a visit:** time, meeting point and, for managers, the salesperson (`POST /api/v1/leads/:id/visits`).
  - **Change stage:** Lost reason, Nurture date and reasons (`POST /api/v1/leads/:id/stage`).

- Everyday work (1.0.4):
  - **New lead** with the duplicate check;
  - **Add task** on a lead or for oneself;
  - **Calls with no outcome** on My Day;
  - **Offline outcomes**: saved on the phone without signal and sent later with the same idempotency key.
- Field and admin screens (1.0.4):
  - **Properties** with camera and gallery photos;
  - **Call scripts**;
  - **Calendar** tab;
  - **Dashboard**;
  - **People**: invite, role, suspend and reactivate, cancel an invitation;
  - **Fingerprint unlock** (More).

- Import template (1.0.7): Download template (CSV) on Import leads, the same file as the website, and a list of what goes in each column (`GET /api/v1/imports/template`).
