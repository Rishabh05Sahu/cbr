# CBR CRM: Android app (Flutter)

The CRM's Android app. It uses the same backend and database as the website through the bearer-only `/api/v1` API ([ADR-0027](../docs/architecture/adr/ADR-0027-android-app.md)).
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

## Scope (slices 1–2)
These screens are built:
- Sign-in, two-step verification and the organisation picker.
- Tabs by role.
- My Day.
- Leads: search, filters and paging.
- Lead screen: Reveal, Call and WhatsApp with the outcome sheet, script, follow-ups, visits and requirements.
- More: switch organisation, website, privacy policy and account deletion.

Visits, Calendar, Team, Inbox and People tabs link to the website for now.
