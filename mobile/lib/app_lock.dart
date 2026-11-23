import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';

/// Fingerprint / face unlock (app 1.0.4). When switched on in More, the app asks for the
/// fingerprint, face or the phone's screen lock when it starts and when it comes back after
/// [timeout] in the background. The sign-in token stays in encrypted storage either way; this
/// only stops someone who picks up an unlocked phone from opening the CRM.
class AppLock extends ChangeNotifier with WidgetsBindingObserver {
  AppLock({FlutterSecureStorage? storage, LocalAuthentication? auth})
    : _storage = storage ?? const FlutterSecureStorage(),
      _auth = auth ?? LocalAuthentication();

  final FlutterSecureStorage _storage;
  final LocalAuthentication _auth;
  static const _key = 'app_lock_enabled';
  static const timeout = Duration(seconds: 60);

  bool enabled = false;
  bool locked = false;
  DateTime? _backgroundSince;

  Future<void> init() async {
    enabled = await _storage.read(key: _key) == 'true';
    locked = enabled;
    WidgetsBinding.instance.addObserver(this);
    notifyListeners();
  }

  /// The phone has a fingerprint, face or screen lock the app can use.
  Future<bool> available() async {
    try {
      return await _auth.isDeviceSupported();
    } catch (_) {
      return false;
    }
  }

  Future<bool> _prompt(String reason) async {
    try {
      return await _auth.authenticate(
        localizedReason: reason,
        persistAcrossBackgrounding: true,
      );
    } catch (_) {
      return false;
    }
  }

  Future<bool> unlock() async {
    final ok = await _prompt('Unlock CBR CRM');
    if (ok) {
      locked = false;
      notifyListeners();
    }
    return ok;
  }

  /// Switching on asks once, so a phone that cannot unlock never locks the person out.
  Future<bool> setEnabled(bool on) async {
    if (on && !await _prompt('Confirm to use fingerprint unlock')) return false;
    enabled = on;
    locked = false;
    await _storage.write(key: _key, value: on ? 'true' : 'false');
    notifyListeners();
    return true;
  }

  /// Sign-out: the next person on this phone starts without the lock.
  Future<void> reset() async {
    enabled = false;
    locked = false;
    await _storage.delete(key: _key);
    notifyListeners();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!enabled) return;
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _backgroundSince ??= DateTime.now();
    } else if (state == AppLifecycleState.resumed) {
      final since = _backgroundSince;
      _backgroundSince = null;
      // The fingerprint prompt itself pauses the app; that must not lock it again.
      if (since != null &&
          !locked &&
          DateTime.now().difference(since) >= timeout) {
        locked = true;
        notifyListeners();
      }
    }
  }
}
