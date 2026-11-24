import 'dart:convert';
import 'dart:typed_data';

import 'package:crm/api/api_client.dart';
import 'package:crm/screens/import_screen.dart';
import 'package:crm/session.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';

http.Response _ok(Object data) =>
    http.Response(jsonEncode({'ok': true, 'data': data}), 200);

http.Response _refused(int status, String code, String message) =>
    http.Response(
      jsonEncode({
        'ok': false,
        'error': {'code': code, 'message': message},
      }),
      status,
    );

final _csv = Uint8List.fromList(
  utf8.encode('Name,Phone\nAsha Test,+971500000001\nRavi Test,+971500000002\n'),
);

ImportFile _file(String name, Uint8List bytes) =>
    ImportFile(name: name, size: bytes.length, read: () async => bytes);

Map<String, dynamic> _job(String status, int version, [Map? extra]) => {
  'id': 'imp-1',
  'status': status,
  'version': version,
  'fileName': 'leads.csv',
  'isUploader': true,
  'createdByName': 'Owner Test',
  'sheetNames': ['Sheet1'],
  'sheetName': null,
  'headers': ['Name', 'Phone'],
  'mapping': {'fullName': 0},
  'defaultSourceId': null,
  'duplicatePolicy': 'ATTACH',
  'assignment': {'mode': 'none'},
  'dryRun': false,
  'counts': {
    'total': 3,
    'empty': 0,
    'valid': 0,
    'invalid': 0,
    'duplicateInFile': 0,
    'created': 0,
    'attached': 0,
    'skipped': 0,
    'failed': 0,
    'processed': 0,
    'existingDuplicates': 0,
  },
  'errorMessage': null,
  'duplicateOfJob': null,
  'attestedAt': null,
  ...?extra,
};

const _options = {
  'fields': [
    {'field': 'fullName', 'label': 'Customer name', 'required': true},
    {'field': 'primaryPhone', 'label': 'Phone', 'required': true},
    {'field': 'email', 'label': 'Email', 'required': false},
  ],
  'sources': [],
  'targets': {'people': [], 'teams': [], 'orgQueue': true},
};

const _attestation =
    'I confirm these contacts were collected lawfully for property enquiries, that they may be contacted about them, and that I am allowed to import them into this organisation.';

Future<void> _pump(
  WidgetTester t,
  ApiClient api,
  ImportFile file,
  http.Client storage,
) async {
  // A phone-width screen tall enough to show a whole step at once.
  t.view.physicalSize = const Size(400, 3000);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  await t.pumpWidget(
    MaterialApp(
      home: ImportScreen(
        session: Session(api: api),
        pickFile: () async => file,
        storageClient: storage,
        pollInterval: const Duration(milliseconds: 10),
      ),
    ),
  );
  await t.pumpAndSettle();
}

Future<void> _tap(WidgetTester t, Finder f) async {
  await t.ensureVisible(f);
  await t.pumpAndSettle();
  await t.tap(f);
  await t.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets(
    'uploads to storage without the token, maps, checks rows, attests and imports',
    (t) async {
      final posts = <String, Map<String, dynamic>>{};
      var phase = 'upload';
      final api = ApiClient(
        baseUrl: 'https://crm.test',
        httpClient: MockClient((req) async {
          expect(req.headers['authorization'], 'Bearer t');
          final path = req.url.path;
          if (req.method == 'POST') {
            posts[path] = jsonDecode(req.body) as Map<String, dynamic>;
            if (path == '/api/v1/imports') {
              return _ok({
                'importId': 'imp-1',
                'upload': {
                  'url': 'https://storage.test/upload/sign/k?token=signed',
                  'method': 'PUT',
                  'headers': {'content-type': 'text/csv', 'x-upsert': 'false'},
                },
                'expiresAt': '2026-11-24T12:00:00.000Z',
              });
            }
            if (path.endsWith('/confirm-upload')) {
              return _ok({'status': 'UPLOADED'});
            }
            if (path.endsWith('/mapping')) {
              phase = 'validate';
              return _ok({'saved': true});
            }
            if (path.endsWith('/confirm')) {
              phase = 'import';
              return _ok({'started': true});
            }
          }
          if (path == '/api/v1/imports') {
            return _ok({
              'imports': [],
              'maxBytes': 20971520,
              'storageConfigured': true,
            });
          }
          if (path == '/api/v1/imports/imp-1') {
            final Map<String, dynamic> d;
            final counts = {
              'total': 3,
              'empty': 0,
              'valid': 2,
              'invalid': 1,
              'duplicateInFile': 0,
              'created': 2,
              'attached': 0,
              'skipped': 0,
              'failed': 0,
              'processed': 3,
              'existingDuplicates': 0,
            };
            final issues = {
              'total': 1,
              'items': [
                {
                  'row': 4,
                  'column': 'Phone',
                  'outcome': 'INVALID',
                  'message': 'The phone number has the wrong number of digits.',
                  'relatedRow': null,
                },
              ],
            };
            switch (phase) {
              case 'upload':
                phase = 'mapping';
                d = {
                  'import': _job('ANALYSING', 2),
                  'issues': null,
                  'options': null,
                };
              case 'mapping':
                d = {
                  'import': _job('NEEDS_MAPPING', 3),
                  'issues': null,
                  'options': _options,
                };
              case 'validate':
                phase = 'ready';
                d = {
                  'import': _job('VALIDATING', 4),
                  'issues': null,
                  'options': null,
                };
              case 'ready':
                d = {
                  'import': _job('READY', 5, {
                    'mapping': {'fullName': 0, 'primaryPhone': 1},
                    'counts': {...counts, 'created': 0},
                    'duplicateOfJob': {
                      'id': 'imp-0',
                      'createdAt': '2026-11-20T10:00:00Z',
                    },
                  }),
                  'issues': issues,
                  'options': _options,
                };
              case 'import':
                phase = 'done';
                d = {
                  'import': _job('IMPORTING', 6, {'counts': counts}),
                  'issues': issues,
                  'options': null,
                };
              default:
                d = {
                  'import': _job('COMPLETED_WITH_ERRORS', 7, {
                    'counts': counts,
                    'attestedAt': '2026-11-24T10:00:00Z',
                  }),
                  'issues': issues,
                  'options': null,
                };
            }
            return _ok({...d, 'attestationText': _attestation});
          }
          return _refused(404, 'NOT_FOUND', 'Not found');
        }),
      )..token = 't';

      http.Request? put;
      final storage = MockClient((req) async {
        put = req;
        return http.Response('{"Key":"k"}', 200);
      });

      await _pump(t, api, _file('leads.csv', _csv), storage);
      await _tap(t, find.byKey(const Key('import-choose')));
      expect(find.text('leads.csv'), findsOneWidget);

      await _tap(t, find.text('Upload and check'));
      expect(posts['/api/v1/imports'], {
        'fileName': 'leads.csv',
        'size': _csv.length,
        'type': 'text/csv',
      });
      // The file went straight to storage with the signed headers and never the CRM token.
      expect(put!.method, 'PUT');
      expect(put!.url.host, 'storage.test');
      expect(put!.headers.containsKey('authorization'), isFalse);
      expect(put!.headers['content-type'], startsWith('text/csv'));
      expect(put!.headers['x-upsert'], 'false');
      expect(put!.bodyBytes, _csv);
      expect(posts.containsKey('/api/v1/imports/imp-1/confirm-upload'), isTrue);

      // Mapping: Name was suggested; Phone still has to be mapped.
      expect(find.text('Map columns'), findsOneWidget);
      expect(find.text('Still to map: Phone'), findsOneWidget);
      await _tap(t, find.text('Not imported'));
      await t.tap(find.text('Phone *').last);
      await t.pumpAndSettle();
      expect(find.text('Still to map: Phone'), findsNothing);

      await _tap(t, find.byKey(const Key('import-check-rows')));
      expect(posts['/api/v1/imports/imp-1/mapping'], {
        'mapping': {'fullName': 0, 'primaryPhone': 1},
        'defaultSourceId': '',
        'duplicatePolicy': 'ATTACH',
        'assignment': {'mode': 'none'},
        'dryRun': false,
        'version': 3,
      });

      // Check rows: counts and the first problem (row number and message, no cell values).
      expect(find.text('READY TO IMPORT'), findsOneWidget);
      expect(find.text('Row 4 · Phone'), findsOneWidget);
      expect(
        find.text('The phone number has the wrong number of digits.'),
        findsOneWidget,
      );
      expect(find.text(_attestation), findsOneWidget);
      final importButton = find.byKey(const Key('import-confirm'));
      expect(t.widget<FilledButton>(importButton).onPressed, isNull);

      await _tap(t, find.text(_attestation));
      expect(
        t.widget<FilledButton>(importButton).onPressed,
        isNull,
        reason: 'the same file was imported before: the extra tick is needed',
      );
      await _tap(
        t,
        find.text(
          'This exact file was imported before. Import it again anyway.',
        ),
      );
      expect(find.text('Import 2 rows'), findsOneWidget);
      await _tap(t, importButton);
      expect(posts['/api/v1/imports/imp-1/confirm'], {
        'attest': true,
        'acknowledgeDuplicateFile': true,
        'version': 5,
      });

      // Polled until finished: the result summary.
      expect(find.text('Completed with problems'), findsOneWidget);
      expect(find.text('New leads created'), findsOneWidget);
      expect(find.text('Import another file'), findsOneWidget);
      expect(find.text('Cancel import'), findsNothing);
    },
  );

  testWidgets(
    'refusals: a legacy Excel file is stopped on the phone, a server refusal is shown',
    (t) async {
      final calls = <String>[];
      final api = ApiClient(
        baseUrl: 'https://crm.test',
        httpClient: MockClient((req) async {
          calls.add('${req.method} ${req.url.path}');
          if (req.method == 'GET') {
            return _ok({
              'imports': [],
              'maxBytes': 20971520,
              'storageConfigured': true,
            });
          }
          return _refused(
            422,
            'RULE_VIOLATION',
            'Finish or cancel your other uploads before starting another one',
          );
        }),
      )..token = 't';
      var stored = false;
      final storage = MockClient((req) async {
        stored = true;
        return http.Response('', 200);
      });

      var file = _file('old.xls', _csv);
      await t.pumpWidget(
        MaterialApp(
          home: ImportScreen(
            session: Session(api: api),
            pickFile: () async => file,
            storageClient: storage,
          ),
        ),
      );
      await t.pumpAndSettle();
      await _tap(t, find.byKey(const Key('import-choose')));
      expect(
        find.text(
          'Macro-enabled and old Excel formats (.xlsm, .xls, .xlsb) are not accepted. Save as .xlsx or CSV.',
        ),
        findsOneWidget,
      );
      expect(calls, ['GET /api/v1/imports']);

      file = _file('leads.csv', _csv);
      await _tap(t, find.byKey(const Key('import-choose')));
      await _tap(t, find.text('Upload and check'));
      expect(
        find.text(
          'Finish or cancel your other uploads before starting another one',
        ),
        findsOneWidget,
      );
      expect(stored, isFalse);
      expect(find.text('Upload and check'), findsOneWidget);
    },
  );
}
