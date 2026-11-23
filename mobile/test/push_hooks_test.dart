import 'dart:convert';

import 'package:crm/api/api_client.dart';
import 'package:crm/session.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

class _FakePush implements PushHooks {
  final events = <String>[];
  @override
  Future<void> onReady(Session session) async => events.add('ready');
  @override
  Future<void> beforeSignOut(Session session) async {
    // Still signed in: the token can unregister the phone.
    events.add('unregister token=${session.api.token}');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  FlutterSecureStorage.setMockInitialValues({});

  test(
    'registers the phone when the session is ready, unregisters before sign-out',
    () async {
      final calls = <String>[];
      final client = MockClient((req) async {
        calls.add('${req.method} ${req.url.path}');
        if (req.url.path == '/api/v1/me') {
          return http.Response(
            jsonEncode({
              'ok': true,
              'data': {
                'user': {'id': 'u', 'name': 'Amit', 'email': 'a@x.test'},
                'memberships': [
                  {'orgId': 'o', 'orgName': 'CBR', 'role': 'SALES_EXECUTIVE'},
                ],
                'blocked': null,
                'active': {
                  'orgId': 'o',
                  'orgName': 'CBR',
                  'role': 'SALES_EXECUTIVE',
                  'permissions': {},
                  'unreadNotifications': 3,
                },
              },
            }),
            200,
          );
        }
        return http.Response('{}', 200);
      });
      final push = _FakePush();
      final session = Session(
        api: ApiClient(httpClient: client, baseUrl: 'https://crm.test')
          ..token = 'tok',
      )..push = push;

      await session.refresh();
      expect(session.status, SessionStatus.ready);
      expect(session.unread.value, 3);
      expect(push.events, ['ready']);

      await session.signOut();
      expect(push.events.last, 'unregister token=tok');
      expect(session.status, SessionStatus.signedOut);
    },
  );

  test('a failing push never blocks sign-out', () async {
    final session = Session(
      api: ApiClient(
        httpClient: MockClient((_) async => http.Response('{}', 200)),
        baseUrl: 'https://crm.test',
      )..token = 'tok',
    )..push = _ThrowingPush();
    await session.signOut();
    expect(session.status, SessionStatus.signedOut);
  });
}

class _ThrowingPush implements PushHooks {
  @override
  Future<void> onReady(Session session) => throw StateError('no firebase');
  @override
  Future<void> beforeSignOut(Session session) => throw StateError('offline');
}
