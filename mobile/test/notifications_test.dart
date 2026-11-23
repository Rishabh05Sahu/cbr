import 'dart:convert';

import 'package:crm/api/api_client.dart';
import 'package:crm/screens/notifications_screen.dart';
import 'package:crm/session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';

Map<String, dynamic> _n(String id, String title, {bool read = false}) => {
  'id': id,
  'type': 'LEAD_ASSIGNED',
  'title': title,
  'body': 'From the Bayut import',
  'link': '/app/my-day',
  'readAt': read ? '2026-11-23T08:00:00.000Z' : null,
  'createdAt': DateTime.now()
      .subtract(const Duration(minutes: 5))
      .toUtc()
      .toIso8601String(),
};

void main() {
  testWidgets('lists notifications, marks one read, then all', (t) async {
    final posts = <String>[];
    var unread = 2;
    final client = MockClient((req) async {
      final path = req.url.path.replaceFirst('/api/v1', '');
      if (req.method == 'GET' && path == '/notifications') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'data': {
              'rows': [
                _n('n1', 'Lead assigned: Rahul Khan'),
                _n('n2', 'Lead assigned: Sara M.'),
                _n('n3', 'Visit reminder', read: true),
              ],
              'nextCursor': null,
              'unread': unread,
            },
          }),
          200,
        );
      }
      posts.add(path);
      unread = path.endsWith('read-all') ? 0 : unread - 1;
      return http.Response(
        jsonEncode({
          'ok': true,
          'data': {'unread': unread},
        }),
        200,
      );
    });
    final session = Session(
      api: ApiClient(httpClient: client, baseUrl: 'https://crm.test')
        ..token = 't',
    );

    await t.pumpWidget(
      MaterialApp(home: NotificationsScreen(session: session)),
    );
    await t.pumpAndSettle();
    expect(find.text('Lead assigned: Rahul Khan'), findsOneWidget);
    expect(find.text('5m'), findsNWidgets(3));
    expect(session.unread.value, 2);

    await t.tap(find.text('Lead assigned: Rahul Khan'));
    await t.pumpAndSettle();
    expect(posts, ['/notifications/n1/read']);
    expect(session.unread.value, 1);

    await t.tap(find.text('Mark all read'));
    await t.pumpAndSettle();
    expect(posts.last, '/notifications/read-all');
    expect(session.unread.value, 0);
    expect(find.text('Mark all read'), findsNothing);
  });

  test('ago() gives short relative times', () {
    final now = DateTime(2026, 11, 23, 12);
    expect(ago(now.subtract(const Duration(seconds: 20)), now), 'Just now');
    expect(ago(now.subtract(const Duration(minutes: 7)), now), '7m');
    expect(ago(now.subtract(const Duration(hours: 3)), now), '3h');
    expect(ago(now.subtract(const Duration(hours: 30)), now), 'Yesterday');
    expect(ago(DateTime(2026, 11, 2), now), '2 Nov');
  });
}
