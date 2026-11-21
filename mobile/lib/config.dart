/// Build-time settings. Point the app at another server with
/// `flutter run --dart-define=API_BASE_URL=https://your-server`.
const String apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'https://cbr-liart.vercel.app',
);

/// The app's fixed Origin (ADR-0027). The server only hands the session token to requests that
/// carry it; no browser can send a custom-scheme Origin.
const String appOrigin = 'cbrcrm://app';
