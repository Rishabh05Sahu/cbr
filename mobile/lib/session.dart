import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api/api_client.dart';

enum SessionStatus { loading, signedOut, twoFactor, chooseOrg, blocked, ready }

/// The signed-in person and their active organisation (from GET /api/v1/me).
class Me {
  Me(this.raw);

  final Map<String, dynamic> raw;

  Map<String, dynamic> get user => raw['user'] as Map<String, dynamic>;
  String get name => user['name'] as String? ?? '';
  String get email => user['email'] as String? ?? '';
  List<Map<String, dynamic>> get memberships =>
      (raw['memberships'] as List).cast<Map<String, dynamic>>();
  Map<String, dynamic>? get active => raw['active'] as Map<String, dynamic>?;
  String? get blocked => raw['blocked'] as String?;

  String get role => active?['role'] as String? ?? '';
  String get orgName => active?['orgName'] as String? ?? '';
  int get unread => (active?['unreadNotifications'] as num?)?.toInt() ?? 0;
  Map<String, dynamic> get permissions =>
      (active?['permissions'] as Map<String, dynamic>?) ?? const {};

  /// The caller holds the permission (at any scope).
  bool can(String permission) => permissions.containsKey(permission);
  String? scope(String permission) => permissions[permission] as String?;
}

/// Session state for the whole app. The token lives in Android's encrypted storage.
class Session extends ChangeNotifier {
  Session({ApiClient? api, FlutterSecureStorage? storage})
    : api = api ?? ApiClient(),
      _storage = storage ?? const FlutterSecureStorage() {
    this.api.onUnauthenticated = _expired;
  }

  final ApiClient api;
  final FlutterSecureStorage _storage;
  static const _tokenKey = 'session_token';

  SessionStatus status = SessionStatus.loading;
  Me? me;
  String? notice;

  /// Unread notifications for the badges. Kept apart from [notifyListeners] so a count change
  /// redraws only the badges, not the whole app.
  final ValueNotifier<int> unread = ValueNotifier(0);

  /// Re-reads the unread count (on resume and every minute while the app is open).
  Future<void> refreshUnread() async {
    if (status != SessionStatus.ready) return;
    try {
      final data = await api.get('/me') as Map<String, dynamic>;
      unread.value = Me(data).unread;
    } on ApiException {
      // Offline or signed out: keep the last count; [_expired] handles a dead session.
    }
  }

  Future<void> start() async {
    api.token = await _storage.read(key: _tokenKey);
    if (api.token == null) return _set(SessionStatus.signedOut);
    try {
      await refresh();
    } on ApiException catch (e) {
      if (e.unauthenticated) return _set(SessionStatus.signedOut);
      // Offline at start-up: keep the token and let the person retry.
      notice = e.message;
      _set(SessionStatus.signedOut);
    }
  }

  Future<void> signIn(String email, String password) async {
    final step = await api.signIn(email, password);
    if (step == SignInStep.twoFactor) return _set(SessionStatus.twoFactor);
    await _signedIn();
  }

  Future<void> verifySecondFactor(
    String code, {
    bool recoveryCode = false,
  }) async {
    await api.verifySecondFactor(code, recoveryCode: recoveryCode);
    await _signedIn();
  }

  Future<void> _signedIn() async {
    await _storage.write(key: _tokenKey, value: api.token);
    await refresh();
    // One organisation: no need to ask.
    final m = me;
    if (m != null &&
        m.active == null &&
        m.blocked == 'NO_ACTIVE_ORG' &&
        m.memberships.length == 1) {
      await chooseOrg(m.memberships.first['orgId'] as String);
    }
  }

  Future<void> chooseOrg(String orgId) async {
    await api.setActiveOrganization(orgId);
    await refresh();
  }

  /// Back to the organisation picker (More → Switch organisation).
  void switchOrg() => _set(SessionStatus.chooseOrg);

  Future<void> refresh() async {
    final data = await api.get('/me') as Map<String, dynamic>;
    me = Me(data);
    unread.value = me!.unread;
    final blocked = me!.blocked;
    if (blocked == null) return _set(SessionStatus.ready);
    if (blocked == 'NO_ACTIVE_ORG' || blocked == 'NOT_A_MEMBER') {
      return _set(
        me!.memberships.isEmpty
            ? SessionStatus.blocked
            : SessionStatus.chooseOrg,
      );
    }
    _set(SessionStatus.blocked);
  }

  Future<void> signOut() async {
    await api.signOut();
    await _storage.delete(key: _tokenKey);
    me = null;
    _set(SessionStatus.signedOut);
  }

  void _expired() {
    if (status == SessionStatus.signedOut) return;
    api.token = null;
    _storage.delete(key: _tokenKey);
    me = null;
    notice = 'Your session ended. Please sign in again.';
    _set(SessionStatus.signedOut);
  }

  void _set(SessionStatus s) {
    status = s;
    notifyListeners();
  }
}
