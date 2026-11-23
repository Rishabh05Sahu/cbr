import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:material_ui/material_ui.dart';

import 'screens/auth_screens.dart';
import 'screens/lead_detail_screen.dart';
import 'session.dart';

final _leadLink = RegExp(r'^/app/leads/([0-9a-f-]{36})$');

/// Phone notifications through Firebase Cloud Messaging (ADR-0027 slice 5).
///
/// - After sign-in (and after switching organisation) the phone's token is sent to
///   POST /api/v1/push-devices; on sign-out it is removed (DELETE).
/// - While the app is closed or in the background, Android shows the notification itself.
///   Tapping it opens the app on the lead (other links open the website).
/// - While the app is open, a push only refreshes the unread badge; the app shows its own
///   "You have a new notification" message.
///
/// Without android/app/google-services.json Firebase does not start and push stays off.
class Push implements PushHooks {
  Push(this.navigatorKey);

  final GlobalKey<NavigatorState> navigatorKey;
  bool _enabled = false;
  String? _token;
  Session? _session;
  RemoteMessage? _pendingTap;

  Future<void> init(Session session) async {
    _session = session;
    try {
      await Firebase.initializeApp();
      _enabled = true;
    } catch (_) {
      return; // Not configured in this build.
    }
    final m = FirebaseMessaging.instance;
    FirebaseMessaging.onMessage.listen((_) => session.refreshUnread());
    FirebaseMessaging.onMessageOpenedApp.listen(_tapped);
    // Registration tokens, which the server's FCM v1 "token" send targets. firebase_messaging 17
    // deprecates them in favour of installation IDs (a newer direct-send API); kept on purpose
    // until the server moves to that API.
    // ignore: deprecated_member_use
    m.onTokenRefresh.listen((t) {
      _token = t;
      if (session.status == SessionStatus.ready) unawaited(_register(session));
    });
    final initial = await m.getInitialMessage();
    if (initial != null) _tapped(initial);
  }

  @override
  Future<void> onReady(Session session) async {
    if (!_enabled) return;
    final m = FirebaseMessaging.instance;
    // Android 13+ shows the system "Allow notifications?" prompt once.
    await m.requestPermission();
    // ignore: deprecated_member_use
    _token ??= await m.getToken();
    await _register(session);
    final tap = _pendingTap;
    if (tap != null) {
      _pendingTap = null;
      _open(tap);
    }
  }

  Future<void> _register(Session session) async {
    final t = _token;
    if (t == null) return;
    await session.api.post('/push-devices', {'token': t});
  }

  @override
  Future<void> beforeSignOut(Session session) async {
    if (!_enabled || _token == null) return;
    await session.api.delete('/push-devices', {'token': _token});
  }

  void _tapped(RemoteMessage msg) {
    if (_session?.status == SessionStatus.ready &&
        navigatorKey.currentState != null) {
      _open(msg);
    } else {
      _pendingTap = msg; // Opened once signed in.
    }
  }

  void _open(RemoteMessage msg) {
    final session = _session;
    final nav = navigatorKey.currentState;
    if (session == null || nav == null) return;
    unawaited(session.refreshUnread());
    final link = msg.data['link'];
    if (link is! String) return;
    final lead = _leadLink.firstMatch(link);
    if (lead != null) {
      nav.push(
        MaterialPageRoute<void>(
          builder: (_) =>
              LeadDetailScreen(session: session, leadId: lead.group(1)!),
        ),
      );
    } else if (link != '/app/my-day') {
      unawaited(openWebsite(link));
    }
  }
}
