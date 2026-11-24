import 'dart:convert';

import 'package:crm/api/api_client.dart';
import 'package:crm/screens/lead_extras.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';

(ApiClient, List<(String, Map<String, dynamic>)>) _api([Object? getData]) {
  final posts = <(String, Map<String, dynamic>)>[];
  final client = MockClient((req) async {
    final path = req.url.path.replaceFirst('/api/v1', '');
    if (req.method == 'GET') {
      return http.Response.bytes(
        utf8.encode(jsonEncode({'ok': true, 'data': getData})),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    }
    posts.add((path, jsonDecode(req.body) as Map<String, dynamic>));
    return http.Response(jsonEncode({'ok': true, 'data': {}}), 200);
  });
  return (
    ApiClient(httpClient: client, baseUrl: 'https://crm.test')..token = 't',
    posts,
  );
}

Future<void> _show(WidgetTester t, Widget w) async {
  t.view.physicalSize = const Size(1080, 2400);
  t.view.devicePixelRatio = 2.5;
  addTearDown(t.view.reset);
  await t.pumpWidget(MaterialApp(home: Scaffold(body: w)));
  await t.pumpAndSettle();
}

void main() {
  test('quick messages use the first name, agent and organisation', () {
    final m = quickMessages(
      leadName: 'Priya Sharma',
      agent: 'Rahul',
      org: 'Northstar Realty',
      visit: {
        'scheduledFor': DateTime.now()
            .add(const Duration(days: 3))
            .toUtc()
            .toIso8601String(),
        'location': 'Marina tower lobby',
      },
    );
    expect(m.map((x) => x.label), [
      'Introduction',
      'Missed call',
      'Visit details',
      'Follow-up',
      'Thank you',
    ]);
    expect(
      m.first.text,
      startsWith('Hi Priya, this is Rahul from Northstar Realty.'),
    );
    expect(m[2].text, contains('Marina tower lobby'));
    // Without an open visit there is no visit message.
    expect(
      quickMessages(leadName: 'Sara', agent: 'A', org: 'O').map((x) => x.label),
      isNot(contains('Visit details')),
    );
  });

  test('the WhatsApp link keeps the number and adds the text, encoded', () {
    expect(
      withWhatsAppText('https://wa.me/971501234567', 'Hi Priya & co?'),
      'https://wa.me/971501234567?text=Hi+Priya+%26+co%3F',
    );
    expect(
      withWhatsAppText('https://wa.me/971501234567', ''),
      'https://wa.me/971501234567',
    );
  });

  test('a property becomes one line and a message', () {
    final p = {
      'title': 'Marina view 2 BR',
      'code': 'P-00012',
      'bhk': 2,
      'propertyType': 'APARTMENT',
      'locality': 'Dubai Marina',
      'city': 'Dubai',
      'price': '1800000',
    };
    expect(propertyLine(p), '2 BR Apartment · Dubai Marina, Dubai · AED 1.8M');
    final msg = propertyMessage(p, greeting: 'Hi Priya,');
    expect(msg, contains('*Marina view 2 BR* (P-00012)'));
    expect(msg, contains('arrange a visit'));
  });

  testWidgets('edit contact sends the changed details, never the main number', (
    t,
  ) async {
    final (api, posts) = _api();
    await _show(
      t,
      EditContactSheet(
        api: api,
        lead: const {
          'id': 'l1',
          'version': 4,
          'fullName': 'Priya',
          'primaryPhoneE164': '+971500000001',
          'email': null,
          'phoneMasked': false,
        },
      ),
    );
    await t.enterText(find.widgetWithText(TextField, 'Name'), 'Priya Sharma');
    await t.enterText(
      find.widgetWithText(TextField, 'Alternate number (optional)'),
      '+971 50 123 4567',
    );
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    expect(posts.single.$1, '/leads/l1/contact');
    expect(posts.single.$2, {
      'version': 4,
      'fullName': 'Priya Sharma',
      'alternatePhone': '+971 50 123 4567',
      'email': '',
      'preferredLanguage': '',
      'preferredContactMethod': '',
    });
  });

  testWidgets(
    'with numbers masked, the alternate number is neither shown nor sent',
    (t) async {
      final (api, posts) = _api();
      await _show(
        t,
        EditContactSheet(
          api: api,
          lead: const {
            'id': 'l1',
            'version': 2,
            'fullName': 'Priya',
            'primaryPhoneE164': '+97150•••••01',
            'phoneMasked': true,
          },
        ),
      );
      expect(find.text('Alternate number (optional)'), findsNothing);
      await t.tap(find.text('Save'));
      await t.pumpAndSettle();
      expect(posts.single.$2.containsKey('alternatePhone'), isFalse);
    },
  );

  testWidgets('add tag offers only tags the lead does not have', (t) async {
    final (api, posts) = _api();
    await _show(
      t,
      AddTagSheet(
        api: api,
        leadId: 'l1',
        options: const [
          {'id': 't1', 'name': 'Marina'},
          {'id': 't2', 'name': 'Investor'},
        ],
        current: const [
          {'id': 't1', 'name': 'Marina'},
        ],
      ),
    );
    expect(find.text('#Marina'), findsNothing);
    await t.tap(find.text('#Investor'));
    await t.pumpAndSettle();
    expect(posts.single.$1, '/leads/l1/tags');
    expect(posts.single.$2, {'tagId': 't2'});
  });

  testWidgets('history shows the sentence, the notes and who', (t) async {
    final (api, _) = _api([
      {
        'id': 'e1',
        'type': 'INTERACTION',
        'actorName': 'Rahul',
        'occurredAt': DateTime.now().toUtc().toIso8601String(),
        'fromMergedLeadId': null,
        'line': {
          'kind': 'call',
          'text': 'Phone call · We contacted them · Interested',
          'detail': 'Wants a 2 BR in Marina',
        },
      },
    ]);
    await t.pumpWidget(
      MaterialApp(
        home: LeadHistoryScreen(api: api, leadId: 'l1', leadName: 'Priya'),
      ),
    );
    await t.pumpAndSettle();
    expect(
      find.text('Phone call · We contacted them · Interested'),
      findsOneWidget,
    );
    expect(find.text('Wants a 2 BR in Marina'), findsOneWidget);
    expect(find.textContaining('Rahul'), findsOneWidget);
  });
}
