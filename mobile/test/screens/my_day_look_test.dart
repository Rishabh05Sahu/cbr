// Renders My Day at a common phone size (360 × 780 dp) with the real Roboto and Material Icons
// fonts and writes test/screens/goldens/my_day.png, so the layout can be looked at. Run with
// `flutter test --update-goldens test/screens` to refresh the picture after a layout change.
import 'dart:convert';

import 'package:crm/api/api_client.dart';
import 'package:crm/screens/my_day_screen.dart';
import 'package:crm/session.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';

import 'look.dart';

/// Fixed clock times (today or a whole number of days away) so the picture never changes with the
/// minute the test runs: [d] is whole days plus an hour of the day, e.g. Duration(hours: 9).
String _iso(Duration d) {
  final now = DateTime.now();
  final day = DateTime(now.year, now.month, now.day + d.inDays);
  return day.add(Duration(hours: d.inHours % 24)).toUtc().toIso8601String();
}

Map<String, dynamic> _t(
  String id,
  String? title,
  String lead, {
  required Duration due,
  String type = 'FOLLOW_UP',
  String priority = 'NORMAL',
  String? intent,
}) => {
  'id': id,
  'type': type,
  'title': title,
  'dueAt': _iso(due),
  'dueAtLocal': '2026-11-24T10:00',
  'priority': priority,
  'version': 1,
  'onLead': true,
  'canUpdate': false,
  'canUpdateOnLead': true,
  'attending': false,
  'rescheduleCount': 0,
  'rescheduleNeedsReason': false,
  'lead': {
    'id': 'l-$id',
    'fullName': lead,
    'stage': 'CONTACTED',
    'intent': intent,
    'archived': false,
  },
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  for (final (scale, file) in const [
    (1.0, 'my_day.png'),
    (1.3, 'my_day_large_text.png'),
  ]) {
    testWidgets('My Day on a phone, text × $scale', (t) async {
      await phone(t);

      final api = ApiClient(
        httpClient: MockClient((req) async {
          final path = req.url.path.replaceFirst('/api/v1', '');
          final data = path == '/my-day'
              ? {
                  'overdue': [
                    _t(
                      'a',
                      null,
                      'Mohammed Abdullah Al Mansoori Trading',
                      due: const Duration(hours: 9),
                      priority: 'URGENT',
                    ),
                  ],
                  'today': [
                    _t(
                      'b',
                      'Send floor plans for the 2 BHK in Marina',
                      'Priya Sharma',
                      due: const Duration(hours: 15),
                      intent: 'HOT',
                    ),
                    _t(
                      'c',
                      'Site office meeting',
                      'Rahul Khan',
                      due: const Duration(hours: 18),
                      type: 'MEETING',
                    ),
                  ],
                  'upcoming': [
                    _t(
                      'd',
                      null,
                      'Sara M.',
                      due: const Duration(days: 1, hours: 11),
                      priority: 'HIGH',
                    ),
                  ],
                  'later': const [],
                  'truncated': false,
                }
              : path == '/unlogged-calls'
              ? {
                  'rows': [
                    {
                      'id': 'i1',
                      'leadId': 'l-x',
                      'leadName': 'Mohamed Abdullah Al Mansoori',
                      'channel': 'PHONE_NATIVE',
                      'occurredAt':
                          '${_iso(const Duration(hours: 9)).substring(0, 10)}T09:33',
                    },
                  ],
                }
              : {'rows': const [], 'unread': 0};
          return http.Response(jsonEncode({'ok': true, 'data': data}), 200);
        }),
        baseUrl: 'https://crm.test',
      )..token = 't';
      final session = Session(api: api)
        ..me = Me({
          'user': {'id': 'u1', 'name': 'Synthetic Exec', 'email': 'e@x.test'},
          'memberships': const [],
          'active': {
            'orgId': 'o1',
            'orgName': 'Northstar Realty',
            'role': 'SALES_EXECUTIVE',
            'permissions': {
              'task.read': 'OWN',
              'task.create': 'OWN',
              'lead.read': 'OWN',
              'interaction.create': 'OWN',
            },
          },
        });

      await t.pumpWidget(
        MaterialApp(
          theme: lookTheme(),
          debugShowCheckedModeBanner: false,
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
          home: MyDayScreen(session: session),
        ),
      );
      await t.pumpAndSettle();
      await expectLater(
        find.byType(MyDayScreen),
        matchesGoldenFile('goldens/$file'),
      );
    });
  }
}
