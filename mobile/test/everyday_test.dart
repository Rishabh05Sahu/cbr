import 'dart:convert';

import 'package:crm/api/api_client.dart';
import 'package:crm/outbox.dart';
import 'package:crm/screens/new_lead_screen.dart';
import 'package:crm/screens/properties_screen.dart';
import 'package:crm/screens/task_sheet.dart';
import 'package:crm/session.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:image/image.dart' as img;
import 'package:material_ui/material_ui.dart';

ApiClient _api(Future<http.Response> Function(http.Request) handler) =>
    ApiClient(httpClient: MockClient(handler), baseUrl: 'https://crm.test')
      ..token = 't';

http.Response _ok(Object data) =>
    http.Response(jsonEncode({'ok': true, 'data': data}), 200);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  group('offline outbox', () {
    test(
      'keeps outcomes while offline and sends them later with the same key',
      () async {
        var online = false;
        final sent = <Map<String, dynamic>>[];
        final api = _api((req) async {
          if (!online) throw Exception('no route to host');
          sent.add(jsonDecode(req.body) as Map<String, dynamic>);
          return _ok({'id': 'i1'});
        });
        final box = Outbox(api);
        await box.add({
          'leadId': 'L1',
          'idempotencyKey': 'k-1',
          'outcome': 'NO_ANSWER',
        }, leadName: 'Rahul');
        expect(box.pending, 1);
        expect(await box.flush(), 0);
        expect(box.pending, 1, reason: 'still offline: kept');

        // A new Outbox (the app restarted) still has it.
        final again = Outbox(api);
        await again.load();
        expect(again.pending, 1);

        online = true;
        expect(await again.flush(), 1);
        expect(again.pending, 0);
        expect(sent.single['idempotencyKey'], 'k-1');
      },
    );

    test('an outcome the server refuses is dropped and reported', () async {
      final api = _api(
        (req) async => http.Response(
          jsonEncode({
            'ok': false,
            'error': {'code': 'CONFLICT', 'message': 'The lead changed'},
          }),
          409,
        ),
      );
      final box = Outbox(api);
      await box.add({'idempotencyKey': 'k-2'}, leadName: 'Sara');
      await box.flush();
      expect(box.pending, 0);
      expect(box.failed, ['Sara']);
      await box.clear();
      expect(box.failed, isEmpty);
    });
  });

  test('photos are resized, the thumbnail made, and EXIF dropped', () {
    final big = img.Image(width: 4000, height: 3000);
    big.exif.imageIfd['Make'] = 'TestCam';
    final prepared = preparePhoto(img.encodeJpg(big))!;
    final full = img.decodeJpg(prepared.full)!;
    final thumb = img.decodeJpg(prepared.thumb)!;
    expect([full.width, full.height], [2048, 1536]);
    expect([thumb.width, thumb.height], [480, 360]);
    expect(full.exif.imageIfd['Make'], isNull);
    expect(preparePhoto(utf8.encode('not an image')), isNull);
  });

  testWidgets('Add task sends the type, title and due time for the lead', (
    t,
  ) async {
    final posts = <Map<String, dynamic>>[];
    final api = _api((req) async {
      if (req.method == 'GET') return _ok({'people': []});
      posts.add(jsonDecode(req.body) as Map<String, dynamic>);
      return _ok({'id': 'task-1'});
    });
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AddTaskSheet(
            api: api,
            nowLocal: '2026-11-23T15:00',
            lead: const {'id': 'lead-1', 'fullName': 'Rahul Khan'},
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
    await t.tap(find.text('Call'));
    await t.enterText(find.byKey(const Key('task-title')), 'Send brochure');
    await t.ensureVisible(find.text('Add task'));
    await t.tap(find.text('Add task'));
    await t.pumpAndSettle();
    expect(posts.single, {
      'leadId': 'lead-1',
      'type': 'CALL',
      'title': 'Send brochure',
      'dueAt': '2026-11-24T10:00',
      'priority': 'NORMAL',
    });
  });

  testWidgets('New lead: a known number offers to open the existing lead', (
    t,
  ) async {
    final session = Session(
      api: _api((req) async {
        if (req.url.path.endsWith('/lead-sources')) return _ok({'sources': []});
        return _ok({
          'status': 'duplicate',
          'leadId': 'lead-9',
          'canAttach': true,
          'archived': false,
        });
      }),
    );
    await t.pumpWidget(MaterialApp(home: NewLeadScreen(session: session)));
    await t.pumpAndSettle();
    await t.enterText(find.byKey(const Key('lead-name')), 'Walk In');
    await t.enterText(find.byKey(const Key('lead-phone')), '0501234567');
    await t.scrollUntilVisible(
      find.text('Add lead'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await t.tap(find.text('Add lead'));
    await t.pumpAndSettle();
    expect(find.text('This number is already a lead'), findsOneWidget);
    expect(find.text('Open the lead'), findsOneWidget);
  });
}
