import 'dart:convert';

import 'package:crm/api/api_client.dart';
import 'package:crm/screens/lead_sheets.dart';
import 'package:crm/screens/log_outcome_sheet.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';

Map<String, dynamic> _o(String code, String label, String group) => {
  'code': code,
  'label': label,
  'group': group,
  'requestsStatus': code == 'CONNECTED_DO_NOT_CALL' ? 'DO_NOT_CONTACT' : null,
};

final _defaults = {
  'occurredAt': '2026-11-23T15:00',
  'occurredMin': '2026-11-16T15:01',
  'timeZone': 'Asia/Dubai',
  'allChannels': [
    {
      'code': 'PHONE_NATIVE',
      'label': 'Phone call',
      'durationAllowed': true,
      'outbound': [
        _o('NO_ANSWER', 'No answer', 'NOT_CONNECTED'),
        _o('CONNECTED_INTERESTED', 'Interested', 'CONNECTED'),
        _o('CONNECTED_DO_NOT_CALL', 'Do not call', 'CONNECTED'),
      ],
      'inbound': [_o('CONNECTED_INTERESTED', 'Interested', 'CONNECTED')],
    },
    {
      'code': 'EMAIL',
      'label': 'Email',
      'durationAllowed': false,
      'outbound': [_o('MESSAGE_SENT', 'Message sent', 'OTHER')],
      'inbound': [_o('MESSAGE_SENT', 'Message sent', 'OTHER')],
    },
  ],
  'directions': [
    {'code': 'OUTBOUND', 'label': 'We contacted them'},
    {'code': 'INBOUND', 'label': 'They contacted us'},
  ],
  'dncMethods': [
    {'code': 'VERBAL', 'label': 'Verbal'},
  ],
  'requirementOptions': {
    'intent': [
      {'code': 'HOT', 'label': 'Hot'},
      {'code': 'WARM', 'label': 'Warm'},
    ],
  },
};

final _lead = {
  'id': 'lead-1',
  'fullName': 'Synthetic Lead',
  'version': 4,
  'stage': 'CONTACTED',
  'contactStatus': 'OK',
  'canUpdate': true,
  'intent': 'WARM',
  'preferredCity': 'Dubai',
};

/// A fake server: answers GET /interactions/defaults and records every POST.
(ApiClient, List<(String, Map<String, dynamic>)>) _api() {
  final posts = <(String, Map<String, dynamic>)>[];
  final client = MockClient((req) async {
    final path = req.url.path.replaceFirst('/api/v1', '');
    if (req.method == 'GET' && path == '/interactions/defaults') {
      return http.Response(jsonEncode({'ok': true, 'data': _defaults}), 200);
    }
    posts.add((path, jsonDecode(req.body) as Map<String, dynamic>));
    return http.Response(jsonEncode({'ok': true, 'data': {}}), 200);
  });
  return (
    ApiClient(httpClient: client, baseUrl: 'https://crm.test')..token = 't',
    posts,
  );
}

Future<void> _show(WidgetTester t, Widget sheet) async {
  t.view.physicalSize = const Size(1080, 2400);
  t.view.devicePixelRatio = 2.5;
  addTearDown(t.view.reset);
  await t.pumpWidget(MaterialApp(home: Scaffold(body: sheet)));
  await t.pumpAndSettle();
}

Future<void> _tapText(WidgetTester t, String text) async {
  // Sheets are lazy lists: scroll until the text is built, then onto the screen.
  if (find.text(text).evaluate().isEmpty) {
    await t.scrollUntilVisible(
      find.text(text),
      200,
      scrollable: find.byType(Scrollable).first,
    );
  }
  final f = find.text(text).last;
  await t.ensureVisible(f);
  await t.pumpAndSettle();
  await t.tap(f);
  await t.pumpAndSettle();
}

void main() {
  testWidgets(
    'logs an outcome like the website: duration, title, requirements',
    (t) async {
      final (api, posts) = _api();
      await _show(
        t,
        LogOutcomeSheet(
          api: api,
          lead: _lead,
          followUps: {'open': const [], 'canSchedule': true},
          pendingTap: null,
        ),
      );
      expect(find.text('We contacted them'), findsOneWidget);
      await _tapText(t, 'Interested');
      await t.enterText(
        find.widgetWithText(TextField, 'Duration in minutes (optional)'),
        '12',
      );
      await t.enterText(
        find.widgetWithText(TextField, 'What to follow up on (optional)'),
        'Send floor plans',
      );
      await _tapText(t, 'Edit');
      await t.enterText(find.widgetWithText(TextField, 'City'), 'Abu Dhabi');
      await _tapText(t, 'Save interaction');

      final (path, body) = posts.single;
      expect(path, '/interactions');
      expect(body['channel'], 'PHONE_NATIVE');
      expect(body['direction'], 'OUTBOUND');
      expect(body['outcome'], 'CONNECTED_INTERESTED');
      expect(body['occurredAt'], '2026-11-23T15:00');
      expect(body['durationMinutes'], '12');
      expect(body['nextDueAt'], '2026-11-24T10:00');
      expect(body['nextTitle'], 'Send floor plans');
      // Only the changed requirement is sent, and named.
      expect(body['preferredCity'], 'Abu Dhabi');
      expect(body['requirementFields'], 'preferredCity');
      expect(body.containsKey('intent'), isFalse);
    },
  );

  testWidgets(
    'inbound contact, and Do not call asks for the confirmation and method',
    (t) async {
      final (api, posts) = _api();
      await _show(
        t,
        LogOutcomeSheet(
          api: api,
          lead: _lead,
          followUps: {'open': const [], 'canSchedule': true},
          pendingTap: null,
        ),
      );
      await _tapText(t, 'Do not call');
      expect(
        find.textContaining('Saving marks this lead do not contact'),
        findsOneWidget,
      );
      expect(find.text('How they asked'), findsOneWidget);
      // No follow-up while the lead is being marked do not contact.
      expect(find.text('Next follow-up'), findsNothing);

      await _tapText(t, 'They contacted us');
      expect(find.text('Do not call'), findsNothing);
      await _tapText(t, 'Interested');
      await _tapText(t, 'Save interaction');
      expect(posts.single.$2['direction'], 'INBOUND');
    },
  );

  testWidgets('books a visit for a salesperson at the chosen time', (t) async {
    final (api, posts) = _api();
    await _show(
      t,
      BookVisitSheet(
        api: api,
        lead: _lead,
        nowLocal: '2026-11-23T15:00',
        people: const [
          {'userId': 'u-2', 'name': 'Synthetic Exec'},
        ],
      ),
    );
    await t.enterText(
      find.widgetWithText(TextField, 'Meeting point'),
      'Marina tower lobby',
    );
    await _tapText(t, 'Me');
    await _tapText(t, 'Synthetic Exec');
    await _tapText(t, 'Book visit');
    expect(posts.single.$1, '/leads/lead-1/visits');
    expect(posts.single.$2, {
      'scheduledFor': '2026-11-24T11:00',
      'location': 'Marina tower lobby',
      'assigneeUserId': 'u-2',
    });
  });

  testWidgets(
    'changes stage to Lost with a reason; Site visit scheduled is not offered',
    (t) async {
      final (api, posts) = _api();
      await _show(
        t,
        StageSheet(
          api: api,
          lead: _lead,
          nowLocal: '2026-11-23T15:00',
          targets: const [
            {'code': 'QUALIFIED', 'label': 'Qualified'},
            {'code': 'SITE_VISIT_SCHEDULED', 'label': 'Site visit scheduled'},
            {'code': 'LOST', 'label': 'Lost'},
          ],
          lostReasons: const [
            {'code': 'BUDGET_MISMATCH', 'label': 'Budget mismatch'},
          ],
        ),
      );
      expect(
        find.widgetWithText(ChoiceChip, 'Site visit scheduled'),
        findsNothing,
      );
      await _tapText(t, 'Lost');
      await _tapText(t, 'Lost reason');
      await _tapText(t, 'Budget mismatch');
      await _tapText(t, 'Change stage');
      expect(posts.single.$1, '/leads/lead-1/stage');
      expect(posts.single.$2, containsPair('toStage', 'LOST'));
      expect(posts.single.$2, containsPair('reasonCode', 'BUDGET_MISMATCH'));
      expect(posts.single.$2, containsPair('version', 4));
    },
  );
}
