import 'dart:convert';

import 'package:crm/api/api_client.dart';
import 'package:crm/screens/visits_screen.dart';
import 'package:crm/session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';

String _iso(Duration d) => DateTime.now().add(d).toUtc().toIso8601String();

Map<String, dynamic> _visit(
  String id,
  String lead, {
  required Duration at,
  bool outcomeDue = false,
  bool canManage = true,
  String status = 'SCHEDULED',
}) => {
  'id': id,
  'scheduledFor': _iso(at),
  'scheduledForLocal': '2026-11-24T10:30',
  'location': 'Synthetic tower lobby',
  'status': status,
  'version': 3,
  'assigneeName': 'Synthetic Exec',
  'lead': canManage ? {'id': 'lead-$id', 'fullName': lead} : null,
  'leadName': lead,
  'canManage': canManage,
  'outcomeDue': outcomeDue,
};

void main() {
  late List<(String, Map<String, dynamic>)> posts;
  late Session session;

  setUp(() {
    posts = [];
    final client = MockClient((req) async {
      final path = req.url.path.replaceFirst('/api/v1', '');
      if (req.method == 'GET' && path == '/visits') {
        return http.Response(
          jsonEncode({
            'ok': true,
            'data': {
              'open': [
                _visit(
                  'v1',
                  'Past Lead',
                  at: const Duration(hours: -2),
                  outcomeDue: true,
                ),
                _visit(
                  'v2',
                  'Assigned Only',
                  at: const Duration(days: 3),
                  canManage: false,
                ),
              ],
              'closed': [
                _visit(
                  'v3',
                  'Closed Lead',
                  at: const Duration(days: -4),
                  status: 'ATTENDED',
                ),
              ],
            },
          }),
          200,
        );
      }
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      posts.add((path, body));
      if (body['action'] == 'cancel' && (body['reason'] as String).isEmpty) {
        return http.Response(
          jsonEncode({
            'ok': false,
            'error': {
              'code': 'VALIDATION_FAILED',
              'message': 'Please check the highlighted fields',
              'fieldErrors': {
                'reason': ['Give a reason for cancelling'],
              },
            },
          }),
          422,
        );
      }
      return http.Response(jsonEncode({'ok': true, 'data': {}}), 200);
    });
    session = Session(
      api: ApiClient(httpClient: client, baseUrl: 'https://crm.test')
        ..token = 't',
    );
  });

  testWidgets('groups visits and records an attended visit', (t) async {
    await t.pumpWidget(MaterialApp(home: VisitsScreen(session: session)));
    await t.pumpAndSettle();
    expect(find.text('OUTCOME DUE'), findsOneWidget);
    expect(find.text('UPCOMING'), findsOneWidget);
    expect(find.text('RECENTLY CLOSED'), findsOneWidget);
    expect(find.text('Past Lead'), findsOneWidget);

    await t.tap(find.text('Past Lead'));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(ChoiceChip, 'Attended'));
    await t.pumpAndSettle();
    await t.tap(find.text('High'));
    await t.enterText(
      find.widgetWithText(TextField, 'Next action'),
      'Send the brochure',
    );
    await t.ensureVisible(find.text('Record visit'));
    await t.pumpAndSettle();
    await t.tap(find.text('Record visit'));
    await t.pumpAndSettle();
    expect(posts.single.$1, '/visits/v1');
    expect(posts.single.$2, containsPair('action', 'attended'));
    expect(posts.single.$2, containsPair('interestLevel', 'HIGH'));
    expect(posts.single.$2, containsPair('nextAction', 'Send the brochure'));
    expect(posts.single.$2, containsPair('version', 3));
    expect(find.text('Visit updated'), findsOneWidget);
  });

  testWidgets(
    'shows the server refusal; a visit the caller cannot change is read-only',
    (t) async {
      await t.pumpWidget(MaterialApp(home: VisitsScreen(session: session)));
      await t.pumpAndSettle();
      await t.tap(find.text('Past Lead'));
      await t.pumpAndSettle();
      await t.tap(find.widgetWithText(ChoiceChip, 'Cancel'));
      await t.pumpAndSettle();
      await t.tap(find.text('Cancel visit'));
      await t.pumpAndSettle();
      expect(find.text('Give a reason for cancelling'), findsOneWidget);
      Navigator.of(t.element(find.text('Cancel visit'))).pop();
      await t.pumpAndSettle();

      await t.tap(find.text('Assigned Only'));
      await t.pumpAndSettle();
      expect(find.textContaining('not change it'), findsOneWidget);
      expect(find.text('Reschedule'), findsNothing);
    },
  );
}
