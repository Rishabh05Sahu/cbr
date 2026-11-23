import 'dart:convert';

import 'package:crm/api/api_client.dart';
import 'package:crm/screens/assign_sheet.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';

const _targets = {
  'people': [
    {'userId': 'u-amit', 'name': 'Amit Sharma'},
    {'userId': 'u-priya', 'name': 'Priya Nair'},
  ],
  'teams': [
    {'id': 't-marina', 'name': 'Marina'},
  ],
  'orgQueue': true,
};

/// A fake server: answers /assignment-targets and records every POST.
(ApiClient, List<(String, Map<String, dynamic>)>) _fake({
  Map<String, dynamic>? error,
}) {
  final posts = <(String, Map<String, dynamic>)>[];
  final client = MockClient((req) async {
    final path = req.url.path.replaceFirst('/api/v1', '');
    expect(req.headers['authorization'], 'Bearer t0ken');
    if (req.method == 'GET' && path == '/assignment-targets') {
      return http.Response(jsonEncode({'ok': true, 'data': _targets}), 200);
    }
    posts.add((path, jsonDecode(req.body) as Map<String, dynamic>));
    if (error != null)
      return http.Response(jsonEncode({'ok': false, 'error': error}), 422);
    return http.Response(jsonEncode({'ok': true, 'data': {}}), 200);
  });
  final api = ApiClient(httpClient: client, baseUrl: 'https://crm.test')
    ..token = 't0ken';
  return (api, posts);
}

Future<void> _pump(WidgetTester t, Widget sheet) async {
  await t.pumpWidget(MaterialApp(home: Scaffold(body: sheet)));
  await t.pumpAndSettle();
}

void main() {
  testWidgets(
    'reassigning one lead needs a reason, then sends target, version and reason',
    (t) async {
      final (api, posts) = _fake();
      await _pump(
        t,
        AssignSheet(
          api: api,
          leadIds: const ['lead-1'],
          version: 4,
          currentOwnerId: 'u-amit',
        ),
      );
      expect(find.text('Reassign lead'), findsOneWidget);
      // The present owner is not offered.
      expect(find.text('Amit Sharma'), findsNothing);
      await t.tap(find.text('Priya Nair'));
      await t.pump();
      await t.tap(find.text('Assign'));
      await t.pump();
      expect(find.text('Give a reason for reassigning'), findsOneWidget);
      expect(posts, isEmpty);

      await t.enterText(find.byType(TextField), 'Speaks Arabic');
      await t.tap(find.text('Assign'));
      await t.pumpAndSettle();
      expect(posts, hasLength(1));
      expect(posts.single.$1, '/leads/lead-1/assign');
      expect(posts.single.$2, {
        'target': 'user:u-priya',
        'version': 4,
        'reason': 'Speaks Arabic',
      });
    },
  );

  testWidgets('queue: several leads go round-robin to a team', (t) async {
    final (api, posts) = _fake();
    await _pump(t, AssignSheet(api: api, leadIds: const ['a', 'b', 'c']));
    expect(find.text('Assign 3 leads'), findsOneWidget);
    await t.tap(find.text('Round-robin'));
    await t.pumpAndSettle();
    // The only team is preselected.
    await t.tap(find.text('Share out'));
    await t.pumpAndSettle();
    expect(posts.single.$1, '/leads/round-robin');
    expect(posts.single.$2, {
      'leadIds': ['a', 'b', 'c'],
      'teamId': 't-marina',
    });
  });

  testWidgets('queue: pick a person for the selected leads', (t) async {
    final (api, posts) = _fake();
    await _pump(t, AssignSheet(api: api, leadIds: const ['a', 'b']));
    await t.tap(find.text('Amit Sharma'));
    await t.pump();
    await t.tap(find.text('Assign'));
    await t.pumpAndSettle();
    expect(posts.single.$1, '/leads/assign');
    expect(posts.single.$2, {
      'leadIds': ['a', 'b'],
      'target': 'user:u-amit',
    });
  });

  testWidgets("the server's refusal is shown in the sheet", (t) async {
    final (api, _) = _fake(
      error: {
        'code': 'VALIDATION_FAILED',
        'message': 'Please check the highlighted fields',
        'fieldErrors': {
          'target': ['Choose someone in a team you manage'],
        },
      },
    );
    await _pump(t, AssignSheet(api: api, leadIds: const ['a']));
    await t.tap(find.text('Priya Nair'));
    await t.pump();
    await t.tap(find.text('Assign'));
    await t.pumpAndSettle();
    expect(find.text('Choose someone in a team you manage'), findsOneWidget);
  });
}
