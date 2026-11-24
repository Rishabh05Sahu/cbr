import 'dart:convert';

import 'package:crm/api/api_client.dart';
import 'package:crm/screens/team_performance_screen.dart';
import 'package:crm/session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';

Map<String, dynamic> _ratio(int n, int d) => {
  'numerator': n,
  'denominator': d,
  'lowSample': d < 20,
};

Map<String, dynamic> member(
  String id,
  String name, {
  int calls = 0,
  int whatsapp = 0,
  int taps = 0,
  int connected = 0,
  int scheduled = 0,
  int completed = 0,
  int due = 0,
  Map<String, dynamic>? logging,
  Map<String, dynamic>? onTime,
}) => {
  'userId': id,
  'name': name,
  'counts': {
    if (taps > 0) 'k04': taps,
    'k04-whatsapp': whatsapp,
    if (calls > 0) 'k05-phone': calls,
    'k05-whatsapp': whatsapp,
    'k02': 3,
    'k07': connected,
    'k11': scheduled,
    'k12': completed,
    'k18': due,
  },
  'ratios': {'k08b': ?logging, 'k19b': ?onTime},
};

/// A synthetic team: sorted by name as the server sends it.
List<Map<String, dynamic>> syntheticTeam() => [
  member(
    'u1',
    'Aisha Al Mansoori',
    calls: 14,
    whatsapp: 9,
    taps: 22,
    connected: 11,
    scheduled: 3,
    completed: 2,
    due: 25,
    logging: _ratio(19, 31),
    onTime: _ratio(21, 25),
  ),
  member(
    'u2',
    'Bilal Qureshi',
    calls: 31,
    whatsapp: 4,
    taps: 40,
    connected: 18,
    scheduled: 1,
    completed: 0,
    due: 12,
    logging: _ratio(30, 44),
    onTime: _ratio(5, 12),
  ),
  member(
    'u3',
    'Chen Wei',
    whatsapp: 2,
    taps: 6,
    due: 4,
    logging: _ratio(0, 6),
    onTime: _ratio(4, 4),
  ),
  member(
    'u4',
    'Divya Raghunathan-Menon',
    calls: 7,
    whatsapp: 12,
    taps: 9,
    connected: 6,
    scheduled: 5,
    completed: 4,
    due: 0,
    logging: _ratio(8, 9),
  ),
];

Map<String, dynamic> dashboard(List<Map<String, dynamic>>? members) => {
  'scope': 'ORG',
  'filters': {
    'period': {'kind': 'this_week', 'first': '2026-11-23', 'end': '2026-11-30'},
    'teamId': null,
    'userId': null,
    'sourceId': null,
  },
  'error': null,
  'options': {
    'teams': [
      {'id': 't1', 'name': 'Marina sales'},
      {'id': 't2', 'name': 'Downtown sales'},
    ],
    'users': const [],
    'sources': const [],
  },
  'timeZone': 'Asia/Dubai',
  'kpis': const [],
  'operational': const [],
  'stages': const [],
  'members': members,
};

/// A session whose API answers GET /dashboard with [members]; [queries] records each call.
Session fakeSession(
  List<Map<String, dynamic>>? members, {
  List<Map<String, String>>? queries,
}) {
  final api = ApiClient(
    httpClient: MockClient((req) async {
      queries?.add(req.url.queryParameters);
      return http.Response.bytes(
        utf8.encode(jsonEncode({'ok': true, 'data': dashboard(members)})),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
    }),
    baseUrl: 'https://crm.test',
  )..token = 't';
  return Session(api: api);
}

List<String> _names(WidgetTester t, List<String> all) {
  final ys = {for (final n in all) n: t.getTopLeft(find.text(n).first).dy};
  return all.toList()..sort((a, b) => ys[a]!.compareTo(ys[b]!));
}

void main() {
  test('sortMembers orders by calls, visits and timeliness', () {
    final m = [for (final r in syntheticTeam()) MemberStats(r)];
    List<String> by(TeamSort s) => [for (final x in sortMembers(m, s)) x.id];
    expect(by(TeamSort.calls), ['u2', 'u1', 'u4', 'u3']);
    expect(by(TeamSort.visits), ['u4', 'u1', 'u2', 'u3']);
    // Chen 100 %, Aisha 84 %, Bilal 42 %, Divya has no follow-ups due (last).
    expect(by(TeamSort.timeliness), ['u3', 'u1', 'u2', 'u4']);
  });

  testWidgets('sorts by calls, re-sorts on the toggle, highlights zero calls', (
    t,
  ) async {
    t.view.physicalSize = const Size(1080, 6000);
    t.view.devicePixelRatio = 3;
    addTearDown(t.view.reset);
    final queries = <Map<String, String>>[];
    await t.pumpWidget(
      MaterialApp(
        home: TeamPerformanceScreen(
          session: fakeSession(syntheticTeam(), queries: queries),
        ),
      ),
    );
    await t.pumpAndSettle();
    expect(queries.single['period'], 'this_week');

    const all = [
      'Aisha Al Mansoori',
      'Bilal Qureshi',
      'Chen Wei',
      'Divya Raghunathan-Menon',
    ];
    expect(_names(t, all), [
      'Bilal Qureshi',
      'Aisha Al Mansoori',
      'Divya Raghunathan-Menon',
      'Chen Wei',
    ]);

    // Team totals: 14 + 31 + 0 + 7 calls logged.
    expect(find.text('52'), findsOneWidget);

    // Only Chen logged no calls: amber pill and border.
    expect(find.text('No calls logged'), findsOneWidget);
    expect(find.text('1 with no calls'), findsOneWidget);
    final chen = t.widget<Material>(find.byKey(const ValueKey('person-u3')));
    final bilal = t.widget<Material>(find.byKey(const ValueKey('person-u2')));
    Color side(Material m) => (m.shape! as RoundedRectangleBorder).side.color;
    expect(side(chen), isNot(side(bilal)));
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('person-u3')),
        matching: find.text('No calls logged'),
      ),
      findsOneWidget,
    );

    // Low sample marked by the server.
    expect(find.text('Low sample'), findsWidgets);

    await t.tap(find.text('Visits'));
    await t.pumpAndSettle();
    expect(_names(t, all), [
      'Divya Raghunathan-Menon',
      'Aisha Al Mansoori',
      'Bilal Qureshi',
      'Chen Wei',
    ]);

    await t.tap(find.text('On time'));
    await t.pumpAndSettle();
    expect(_names(t, all).first, 'Chen Wei');

    // Period chips reload with the chosen code.
    await t.ensureVisible(find.text('This month'));
    await t.pumpAndSettle();
    await t.tap(find.text('This month'));
    await t.pumpAndSettle();
    expect(queries.last['period'], 'this_month');
  });

  testWidgets('a tap opens the person sheet with descriptions', (t) async {
    t.view.physicalSize = const Size(1080, 6000);
    t.view.devicePixelRatio = 3;
    addTearDown(t.view.reset);
    await t.pumpWidget(
      MaterialApp(
        home: TeamPerformanceScreen(session: fakeSession(syntheticTeam())),
      ),
    );
    await t.pumpAndSettle();
    await t.tap(find.text('Chen Wei'));
    await t.pumpAndSettle();
    expect(find.text('No calls logged in this period'), findsOneWidget);
    expect(find.text('Follow-up timeliness'), findsOneWidget);
    expect(
      find.textContaining('completed within 1 hour of the due time'),
      findsOneWidget,
    );
  });

  testWidgets('empty team and executive scope show a message', (t) async {
    await t.pumpWidget(
      MaterialApp(home: TeamPerformanceScreen(session: fakeSession(const []))),
    );
    await t.pumpAndSettle();
    expect(find.text('No one in this team yet.'), findsOneWidget);

    await t.pumpWidget(
      MaterialApp(
        key: UniqueKey(),
        home: TeamPerformanceScreen(session: fakeSession(null)),
      ),
    );
    await t.pumpAndSettle();
    expect(
      find.text('Team figures are for managers and owners.'),
      findsOneWidget,
    );
  });

  testWidgets('an error shows a retry', (t) async {
    final api = ApiClient(
      httpClient: MockClient(
        (req) async => http.Response.bytes(
          utf8.encode(
            jsonEncode({
              'ok': false,
              'error': {'code': 'FORBIDDEN', 'message': 'Not allowed'},
            }),
          ),
          403,
          headers: {'content-type': 'application/json; charset=utf-8'},
        ),
      ),
      baseUrl: 'https://crm.test',
    )..token = 't';
    await t.pumpWidget(
      MaterialApp(
        home: TeamPerformanceScreen(session: Session(api: api)),
      ),
    );
    await t.pumpAndSettle();
    expect(find.text('Try again'), findsOneWidget);
  });
}
