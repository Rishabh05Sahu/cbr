// Renders the outcome sheet's requirements section on a phone, closed and open, to
// test/screens/goldens/log_requirements_*.png.
import 'dart:convert';

import 'package:crm/api/api_client.dart';
import 'package:crm/screens/log_outcome_sheet.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';

import 'look.dart';

List<Map<String, String>> _opts(Map<String, String> m) => [
  for (final e in m.entries) {'code': e.key, 'label': e.value},
];

final _defaults = {
  'occurredAt': '2026-11-24T15:00',
  'occurredMin': '2026-11-17T15:01',
  'timeZone': 'Asia/Dubai',
  'allChannels': [
    {
      'code': 'PHONE_NATIVE',
      'label': 'Phone call',
      'durationAllowed': true,
      'outbound': [
        {'code': 'NO_ANSWER', 'label': 'No answer', 'group': 'NOT_CONNECTED'},
        {
          'code': 'CONNECTED_INTERESTED',
          'label': 'Interested',
          'group': 'CONNECTED',
        },
      ],
      'inbound': const [],
    },
  ],
  'directions': [
    {'code': 'OUTBOUND', 'label': 'We contacted them'},
    {'code': 'INBOUND', 'label': 'They contacted us'},
  ],
  'dncMethods': const [],
  'requirementOptions': {
    'transactionType': _opts({
      'BUY': 'Buy',
      'RENT': 'Rent',
      'SELL': 'Sell (owner)',
    }),
    'propertyType': _opts({
      'APARTMENT': 'Apartment',
      'VILLA': 'Villa',
      'OFFICE': 'Office',
      'PLOT': 'Plot',
    }),
    'purpose': _opts({'SELF_USE': 'Self use', 'INVESTMENT': 'Investment'}),
    'timeline': _opts({
      'IMMEDIATE': 'Immediate',
      'WITHIN_1M': 'Within 1 month',
      '1_3M': '1–3 months',
    }),
    'intent': _opts({'HOT': 'Hot', 'WARM': 'Warm', 'COLD': 'Cold'}),
  },
};

void main() {
  for (final open in [false, true]) {
    testWidgets('requirements section, open: $open', (t) async {
      await phone(t, height: open ? 1500 : 1100);
      final api = ApiClient(
        httpClient: MockClient(
          (req) async => http.Response.bytes(
            utf8.encode(jsonEncode({'ok': true, 'data': _defaults})),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          ),
        ),
        baseUrl: 'https://crm.test',
      )..token = 't';
      await t.pumpWidget(
        MaterialApp(
          theme: lookTheme(),
          debugShowCheckedModeBanner: false,
          home: Scaffold(
            body: LogOutcomeSheet(
              api: api,
              lead: const {
                'id': 'l1',
                'fullName': 'Priya Sharma',
                'version': 3,
                'stage': 'CONTACTED',
                'contactStatus': 'OK',
                'canUpdate': true,
                'transactionType': 'BUY',
                'propertyType': 'APARTMENT',
                'preferredCity': 'Dubai',
                'budgetMax': '2500000',
                'intent': 'WARM',
              },
              followUps: const {'open': [], 'canSchedule': true},
              pendingTap: null,
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      final header = find.textContaining('equirements');
      await t.scrollUntilVisible(
        header,
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await t.pumpAndSettle();
      if (open) {
        await t.tap(header);
        await t.pumpAndSettle();
      }
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile(
          'goldens/log_requirements_${open ? 'open' : 'closed'}.png',
        ),
      );
    });
  }
}
