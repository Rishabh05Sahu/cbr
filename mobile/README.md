# CBR CRM — Android app (Flutter)

The CRM's Android app. It uses the same backend and database as the website through the bearer-only `/api/v1` API ([ADR-0027](../docs/architecture/adr/ADR-0027-android-app.md)). App ID: `com.crystalbricks.crm`.

## Run on a phone or emulator

```sh
cd mobile
flutter pub get
flutter run                                              # uses https://cbr-liart.vercel.app
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000   # local `pnpm dev` from the Android emulator
```

The server must include ADR-0027: the bearer plugin, `cbrcrm://app` as a trusted origin, and `/api/v1`.

## Checks

```sh
flutter analyze
flutter test
flutter build apk --debug      # build/app/outputs/flutter-apk/app-debug.apk
```

## What is in slice 2
These screens are built:
- Sign in, two-step verification (authenticator code or recovery code), and the organisation picker.
- Tabs by role.
- My Day, with ticking off tasks that have no lead.
- Leads: search, quick filters and paging.
- Lead screen:
  - masked number with Reveal;
  - Call and WhatsApp, with the outcome sheet opening automatically when you come back;
  - script, follow-ups, visits and requirements.
- More: switch organisation, website links and sign out.

Visits, Calendar, Team, Inbox and People appear as tabs that link to the website. They are built in later slices.

## Not yet done (before Play Store)
- A release signing key.
- An app icon.
- Screenshot blocking on lead screens.
- Push notifications (FCM).
- Offline queue for outcomes.
- Privacy policy, Data Safety form and an account-deletion link.
