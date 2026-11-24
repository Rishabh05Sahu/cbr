import 'dart:async';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';
import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import 'lead_sheets.dart' show FormErrors;

// Import leads (FR-040–FR-052, FR-170), Owners and Admins: the website's import flow on the
// phone. Pick a .csv or .xlsx, upload it straight to private storage with a one-object signed
// permission (never with the CRM token), let the server check it, choose a worksheet, map the
// columns, check every row, attest and import. Every step is re-checked by the server; the
// screen only shows what the server reports.

/// Status labels in the website's wording (src/app/(app)/app/leads/import/status.ts).
const Map<String, String> importStatusLabels = {
  'AWAITING_UPLOAD': 'Waiting for upload',
  'UPLOADED': 'Uploaded',
  'ANALYSING': 'Reading file',
  'NEEDS_MAPPING': 'Map columns',
  'VALIDATING': 'Checking rows',
  'READY': 'Ready to import',
  'IMPORTING': 'Importing',
  'PAUSED': 'Paused',
  'COMPLETED': 'Completed',
  'COMPLETED_WITH_ERRORS': 'Completed with problems',
  'FAILED': 'Failed',
  'CANCELLED': 'Cancelled',
  'EXPIRED': 'Expired',
};

const _terminal = {
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
};

/// The worker is busy: the screen keeps asking the server for news.
const _workingStatuses = {'UPLOADED', 'ANALYSING', 'VALIDATING', 'IMPORTING'};

Pill importStatusPill(String? status) {
  final text = label(importStatusLabels, status);
  if (status == 'COMPLETED') return Pill.teal(text);
  if (const {
    'FAILED',
    'PAUSED',
    'COMPLETED_WITH_ERRORS',
    'EXPIRED',
  }.contains(status)) {
    return Pill.warn(text);
  }
  return Pill(text);
}

final _n = NumberFormat.decimalPattern('en_IN');
String _num(Object? v) => _n.format((v as num?) ?? 0);

/// Canonical content types (src/modules/imports/file-check.ts CONTENT_TYPES).
const importContentTypes = {
  'csv': 'text/csv',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/// Upload size used until the server says otherwise (IMPORT_MAX_BYTES default).
const defaultImportMaxBytes = 20 * 1024 * 1024;

String? importExtension(String name) {
  final m = RegExp(
    r'\.([a-z0-9]{1,8})$',
    caseSensitive: false,
  ).firstMatch(name);
  return m?.group(1)?.toLowerCase();
}

/// The website's checks on the chosen file before anything is uploaded (checkDeclaredFile, with
/// its messages). The server checks again, and checks the bytes after the upload.
String? checkImportFile(String name, int size, int maxBytes) {
  if (name.trim().isEmpty) {
    return 'The file name is not usable. Rename the file and try again.';
  }
  final ext = importExtension(name);
  if (const {'xlsm', 'xls', 'xlsb', 'xltm'}.contains(ext)) {
    return 'Macro-enabled and old Excel formats (.xlsm, .xls, .xlsb) are not accepted. Save as .xlsx or CSV.';
  }
  if (ext != 'csv' && ext != 'xlsx') {
    return 'Only .csv and .xlsx files can be imported.';
  }
  if (size <= 0) return 'The file is empty.';
  if (size > maxBytes) {
    return 'The file is larger than the allowed upload size.';
  }
  return null;
}

String _sizeText(int bytes) {
  if (bytes >= 1024 * 1024) {
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
  if (bytes >= 1024) return '${(bytes / 1024).toStringAsFixed(0)} KB';
  return '$bytes bytes';
}

/// A file chosen on the phone. [read] loads its bytes only once the checks have passed.
class ImportFile {
  const ImportFile({
    required this.name,
    required this.size,
    required this.read,
  });
  final String name;
  final int size;
  final Future<Uint8List> Function() read;
}

typedef ImportFilePicker = Future<ImportFile?> Function();

/// Android's document picker, limited to .csv and .xlsx. No storage permission is needed.
Future<ImportFile?> pickImportFile() async {
  final f = await FilePicker.pickFile(
    type: FileType.custom,
    allowedExtensions: const ['csv', 'xlsx'],
  );
  if (f == null) return null;
  final size = f.lengthSync() ?? await f.length() ?? 0;
  return ImportFile(name: f.name, size: size, read: f.readAsBytes);
}

class StorageUploadException implements Exception {
  StorageUploadException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Streams the bytes in chunks so the screen can show progress as the connection takes them.
class _ProgressUpload extends http.BaseRequest {
  _ProgressUpload(super.method, super.url, this.bytes, this.onProgress);
  final Uint8List bytes;
  final void Function(double) onProgress;

  @override
  http.ByteStream finalize() {
    super.finalize();
    return http.ByteStream(_chunks());
  }

  Stream<List<int>> _chunks() async* {
    const chunk = 64 * 1024;
    for (var i = 0; i < bytes.length; i += chunk) {
      final end = i + chunk < bytes.length ? i + chunk : bytes.length;
      yield Uint8List.sublistView(bytes, i, end);
      onProgress(end / bytes.length);
    }
  }
}

/// PUTs the file to the signed storage URL with exactly the headers the server returned. The
/// CRM's bearer token is never sent here.
Future<void> putToStorage(
  http.Client client,
  Map<String, dynamic> upload,
  Uint8List bytes,
  void Function(double) onProgress,
) async {
  final req = _ProgressUpload(
    'PUT',
    Uri.parse(upload['url'] as String),
    bytes,
    onProgress,
  );
  final headers = (upload['headers'] as Map?) ?? const {};
  headers.forEach((k, v) {
    if ('$k'.toLowerCase() != 'authorization') req.headers['$k'] = '$v';
  });
  req.contentLength = bytes.length;
  final http.StreamedResponse res;
  try {
    res = await client.send(req).timeout(const Duration(minutes: 5));
    await res.stream.drain<void>();
  } catch (_) {
    throw StorageUploadException(
      'The upload could not reach storage. Check your connection.',
    );
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw StorageUploadException(
      'The upload was refused (HTTP ${res.statusCode}). Try again.',
    );
  }
}

enum _Phase { idle, starting, uploading, verifying }

class ImportScreen extends StatefulWidget {
  const ImportScreen({
    super.key,
    required this.session,
    this.pickFile = pickImportFile,
    this.storageClient,
    this.pollInterval = const Duration(seconds: 2),
  });

  final Session session;
  final ImportFilePicker pickFile;

  /// For the storage PUT only (tests); a fresh client otherwise.
  final http.Client? storageClient;
  final Duration pollInterval;

  @override
  State<ImportScreen> createState() => _ImportScreenState();
}

class _ImportScreenState extends State<ImportScreen> {
  ApiClient get _api => widget.session.api;

  // Start: recent imports and limits.
  Map<String, dynamic>? _home;
  String? _homeError;

  // Upload.
  ImportFile? _file;
  _Phase _phase = _Phase.idle;
  double _progress = 0;

  // One import.
  String? _jobId;
  Map<String, dynamic>? _data;
  Timer? _poll;
  final _scroll = ScrollController();
  bool _busy = false;
  List<String> _errors = const [];

  // Forms, reset whenever the import's version changes.
  int? _formVersion;
  Map<String, int> _mapping = {};
  String _source = '';
  String _policy = 'ATTACH';
  String _assign = '';
  bool _dryRun = false;
  String? _sheet;
  bool _attest = false;
  bool _ack = false;
  bool _showMapping = false;
  bool _confirmCancel = false;

  Map<String, dynamic> get _job =>
      (_data?['import'] as Map?)?.cast<String, dynamic>() ?? const {};
  String? get _status => _job['status'] as String?;
  int get _maxBytes =>
      (_home?['maxBytes'] as num?)?.toInt() ?? defaultImportMaxBytes;

  @override
  void initState() {
    super.initState();
    _loadHome();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadHome() async {
    try {
      final d = await _api.get('/imports') as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _home = d;
          _homeError = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _homeError = e.message);
    }
  }

  // --- Upload -----------------------------------------------------------------------------------

  Future<void> _choose() async {
    final f = await widget.pickFile();
    if (f == null || !mounted) return;
    final problem = checkImportFile(f.name, f.size, _maxBytes);
    setState(() {
      _file = problem == null ? f : null;
      _errors = problem == null ? const [] : [problem];
    });
  }

  Future<void> _upload() async {
    final f = _file;
    if (f == null || _phase != _Phase.idle) return;
    setState(() {
      _errors = const [];
      _phase = _Phase.starting;
      _progress = 0;
    });
    String? started;
    var stored = false;
    final client = widget.storageClient ?? http.Client();
    try {
      final bytes = await f.read();
      final problem = checkImportFile(f.name, bytes.length, _maxBytes);
      if (problem != null) throw StorageUploadException(problem);
      final s = await _api.post('/imports', {
        'fileName': f.name,
        'size': bytes.length,
        'type': importContentTypes[importExtension(f.name)] ?? '',
      }) as Map<String, dynamic>;
      started = s['importId'] as String;
      if (mounted) setState(() => _phase = _Phase.uploading);
      await putToStorage(
        client,
        (s['upload'] as Map).cast<String, dynamic>(),
        bytes,
        (p) {
          if (mounted) setState(() => _progress = p);
        },
      );
      stored = true;
      if (mounted) setState(() => _phase = _Phase.verifying);
      await _api.post('/imports/$started/confirm-upload');
      if (!mounted) return;
      setState(() {
        _phase = _Phase.idle;
        _file = null;
        _jobId = started;
      });
      await _loadJob();
    } on ApiException catch (e) {
      _uploadFailed(e.allMessages);
    } on StorageUploadException catch (e) {
      _uploadFailed([e.message]);
      // The file never reached storage: free the upload slot (best effort).
      if (started != null && !stored) {
        unawaited(
          _api.post('/imports/$started/cancel').then((_) {}, onError: (_) {}),
        );
      }
    } catch (_) {
      _uploadFailed(['The upload failed. Try again.']);
    } finally {
      if (widget.storageClient == null) client.close();
    }
  }

  void _uploadFailed(List<String> errors) {
    if (!mounted) return;
    setState(() {
      _errors = errors;
      _phase = _Phase.idle;
      _progress = 0;
    });
  }

  // --- One import -------------------------------------------------------------------------------

  Future<void> _open(String id) async {
    setState(() {
      _jobId = id;
      _data = null;
      _errors = const [];
      _formVersion = null;
    });
    await _loadJob();
  }

  Future<void> _loadJob() async {
    _poll?.cancel();
    final id = _jobId;
    if (id == null) return;
    try {
      final d = await _api.get('/imports/$id') as Map<String, dynamic>;
      if (!mounted || _jobId != id) return;
      final before = _status;
      setState(() {
        _data = d;
        _resetForms();
      });
      // A new step: show it from the top (status, counts and the result first).
      if (before != _status) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_scroll.hasClients) _scroll.jumpTo(0);
        });
      }
    } on ApiException catch (e) {
      if (!mounted || _jobId != id) return;
      setState(() => _errors = e.allMessages);
    }
    if (mounted && _jobId == id && _shouldPoll) {
      _poll = Timer(widget.pollInterval, _loadJob);
    }
  }

  bool get _shouldPoll => _data != null && _workingStatuses.contains(_status);

  void _resetForms() {
    final v = (_job['version'] as num?)?.toInt();
    if (v == _formVersion) return;
    _formVersion = v;
    final m = (_job['mapping'] as Map?) ?? const {};
    _mapping = {
      for (final e in m.entries)
        if (e.value is num) '${e.key}': (e.value as num).toInt(),
    };
    _source = _job['defaultSourceId'] as String? ?? '';
    _policy = _job['duplicatePolicy'] as String? ?? 'ATTACH';
    final a = (_job['assignment'] as Map?) ?? const {};
    final targets = (_data?['options']?['targets'] as Map?) ?? const {};
    _assign = a['mode'] == 'target'
        ? '${a['target'] ?? ''}'
        : a['mode'] == 'round_robin'
        ? 'rr:${a['teamId']}'
        : targets['orgQueue'] == true
        ? 'none'
        : '';
    _dryRun = _job['dryRun'] == true;
    final sheets = (_job['sheetNames'] as List?)?.cast<String>() ?? const [];
    _sheet =
        _job['sheetName'] as String? ?? (sheets.isEmpty ? null : sheets.first);
    _attest = false;
    _ack = false;
    _showMapping = false;
    _confirmCancel = false;
  }

  /// Runs one command, then shows whatever the server now reports.
  Future<void> _step(String path, [Map<String, dynamic>? body]) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _errors = const [];
    });
    try {
      await _api.post('/imports/$_jobId$path', body);
      _formVersion = null; // done: start the next step from the server's state
    } on ApiException catch (e) {
      // Refused: keep what the person chose so they can fix it.
      if (mounted) setState(() => _errors = e.allMessages);
    }
    await _loadJob();
    if (mounted) setState(() => _busy = false);
  }

  void _startOver() {
    _poll?.cancel();
    setState(() {
      _jobId = null;
      _data = null;
      _errors = const [];
      _formVersion = null;
    });
    _loadHome();
  }

  Map<String, dynamic> get _assignment => _assign == 'none' || _assign == ''
      ? {'mode': 'none'}
      : _assign.startsWith('rr:')
      ? {'mode': 'round_robin', 'teamId': _assign.substring(3)}
      : {'mode': 'target', 'target': _assign};

  // --- UI ---------------------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: _jobId == null,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _startOver();
      },
      child: Scaffold(
        appBar: AppBar(title: const Text('Import leads')),
        body: SafeArea(child: _jobId == null ? _start() : _jobView()),
      ),
    );
  }

  Widget _start() {
    if (_home == null && _homeError != null) {
      return MessageView(message: _homeError!, onRetry: _loadHome);
    }
    if (_home == null) return const Center(child: CircularProgressIndicator());
    final storage = _home!['storageConfigured'] != false;
    final recent = ((_home!['imports'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    final busy = _phase != _Phase.idle;
    final f = _file;
    return RefreshIndicator(
      onRefresh: _loadHome,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'Bring leads in from a portal or spreadsheet export (.xlsx or .csv).',
            style: TextStyle(color: AppColors.muted),
          ),
          const SectionLabel('New import'),
          AppCard(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (!storage)
                  const _Notice(
                    'File storage is not configured on this server, so files cannot be uploaded yet.',
                  ),
                OutlinedButton.icon(
                  key: const Key('import-choose'),
                  onPressed: busy || !storage ? null : _choose,
                  icon: const Icon(Icons.attach_file),
                  label: Text(
                    f == null ? 'Choose a file' : 'Choose another file',
                  ),
                ),
                if (f != null) ...[
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      const Icon(
                        Icons.description_outlined,
                        color: AppColors.teal,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          f.name,
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                      ),
                      Text(
                        _sizeText(f.size),
                        style: const TextStyle(color: AppColors.muted),
                      ),
                    ],
                  ),
                ],
                FormErrors(_errors),
                if (_phase == _Phase.uploading) ...[
                  const SizedBox(height: 12),
                  LinearProgressIndicator(value: _progress),
                  const SizedBox(height: 4),
                  Text(
                    'Uploading… ${(_progress * 100).round()}%',
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.muted,
                    ),
                  ),
                ],
                if (_phase == _Phase.verifying) ...[
                  const SizedBox(height: 12),
                  const Text(
                    'Checking the stored file…',
                    style: TextStyle(color: AppColors.muted),
                  ),
                ],
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: f == null || busy || !storage ? null : _upload,
                  child: Text(busy ? 'Working…' : 'Upload and check'),
                ),
                const SizedBox(height: 8),
                Text(
                  '.xlsx or .csv (CSV saved as "CSV UTF-8"), up to '
                  '${(_maxBytes / (1024 * 1024)).round()} MB. The first non-empty row holds '
                  'the column names. Macro-enabled, old Excel and password-protected files are '
                  'refused.',
                  style: const TextStyle(fontSize: 12, color: AppColors.muted),
                ),
              ],
            ),
          ),
          SectionLabel('Recent imports', count: recent.length),
          if (recent.isEmpty)
            const Text(
              'No imports yet.',
              style: TextStyle(color: AppColors.muted),
            )
          else
            for (final i in recent)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: AppCard(
                  onTap: busy ? null : () => _open(i['id'] as String),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              i['fileName'] as String? ?? '',
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              '${_num(i['total'])} rows · ${_num(i['created'])} new / '
                              '${_num(i['attached'])} added · ${i['createdByName'] ?? ''}',
                              style: const TextStyle(
                                fontSize: 12,
                                color: AppColors.muted,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 8),
                      importStatusPill(i['status'] as String?),
                    ],
                  ),
                ),
              ),
        ],
      ),
    );
  }

  Widget _jobView() {
    if (_data == null) {
      if (_errors.isNotEmpty) {
        return MessageView(message: _errors.join(' '), onRetry: _loadJob);
      }
      return const Center(child: CircularProgressIndicator());
    }
    final j = _job;
    final status = _status;
    final c = (j['counts'] as Map?)?.cast<String, dynamic>() ?? const {};
    final uploader = j['isUploader'] == true;
    final by = j['createdByName'] as String? ?? 'the uploader';
    final errorMessage = j['errorMessage'] as String?;
    final options = (_data!['options'] as Map?)?.cast<String, dynamic>();
    return RefreshIndicator(
      onRefresh: _loadJob,
      child: ListView(
        controller: _scroll,
        padding: const EdgeInsets.all(16),
        children: [
          AppCard(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        j['fileName'] as String? ?? '',
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    importStatusPill(status),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  'Started by $by',
                  style: const TextStyle(fontSize: 12, color: AppColors.muted),
                ),
                if (_workingStatuses.contains(status)) ...[
                  const SizedBox(height: 12),
                  Text(
                    _workingText(status),
                    style: const TextStyle(color: AppColors.muted),
                  ),
                ],
                if (status == 'IMPORTING' &&
                    ((c['total'] as num?) ?? 0) > 0) ...[
                  const SizedBox(height: 8),
                  LinearProgressIndicator(
                    value:
                        ((c['processed'] as num?) ?? 0) / (c['total'] as num),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${_num(c['processed'])} of ${_num(c['total'])} rows processed',
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.muted,
                    ),
                  ),
                ],
                if (errorMessage != null) ...[
                  const SizedBox(height: 12),
                  _Notice(errorMessage, error: status != 'PAUSED'),
                ],
                if (status == 'AWAITING_UPLOAD') ...[
                  const SizedBox(height: 12),
                  const _Notice(
                    'The file has not been confirmed as uploaded. Upload it again, or cancel this import.',
                  ),
                ],
                if (status == 'PAUSED' && !uploader) ...[
                  const SizedBox(height: 12),
                  Text(
                    'Only $by can resume this import once their access is restored. You can '
                    'cancel it; leads already imported are kept.',
                    style: const TextStyle(color: AppColors.muted),
                  ),
                ],
                ..._counts(j, c),
                FormErrors(_errors),
                ..._jobButtons(status, uploader),
              ],
            ),
          ),
          if (status == 'NEEDS_MAPPING') ...[
            const SectionLabel('Map your columns'),
            if (!uploader)
              Text(
                'Only $by can map this file.',
                style: const TextStyle(color: AppColors.muted),
              )
            else if (options != null)
              ..._mappingSection(j, options),
          ],
          if (status == 'READY') ...[
            const SectionLabel('Ready to import'),
            const Text(
              'Every row has been checked. Nothing has been written to your leads yet.',
              style: TextStyle(color: AppColors.muted),
            ),
            const SizedBox(height: 8),
            if (!uploader)
              Text(
                'Only $by can start this import.',
                style: const TextStyle(color: AppColors.muted),
              )
            else if (((c['valid'] as num?) ?? 0) == 0)
              const _Notice(
                'No row can be imported. Fix the file or the mapping and try again.',
              )
            else
              _confirmPanel(j, c),
            if (uploader && options != null) ...[
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: () => setState(() => _showMapping = !_showMapping),
                child: Text(
                  _showMapping ? 'Hide the mapping' : 'Change the mapping',
                ),
              ),
              if (_showMapping) ..._mappingSection(j, options),
            ],
          ],
          ..._issues(),
          if (_terminal.contains(status)) ...[
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _startOver,
              child: const Text('Import another file'),
            ),
          ],
        ],
      ),
    );
  }

  String _workingText(String? status) => switch (status) {
    'UPLOADED' || 'ANALYSING' => 'Reading the file… this updates by itself.',
    'VALIDATING' => 'Checking every row… this updates by itself.',
    'IMPORTING' => 'Importing… this updates by itself.',
    _ => 'Working… this updates by itself.',
  };

  /// The website's counts (Counts in [id]/page.tsx).
  List<Widget> _counts(Map<String, dynamic> j, Map<String, dynamic> c) {
    final status = _status;
    final rows = <(String, Object?)>[];
    final total = (c['total'] as num?) ?? 0;
    if (status == 'NEEDS_MAPPING') {
      rows.add(('Rows found', c['total']));
    } else if (total > 0 &&
        !const {
          'AWAITING_UPLOAD',
          'UPLOADED',
          'ANALYSING',
          'VALIDATING',
        }.contains(status)) {
      rows.addAll([
        ('Rows in file', c['total']),
        ('Valid', c['valid']),
        ('With problems', c['invalid']),
        ('Same phone earlier in file', c['duplicateInFile']),
        ('Empty', c['empty']),
      ]);
      if (status == 'READY' || (j['dryRun'] == true && status == 'COMPLETED')) {
        rows.add(('Match an open lead', c['existingDuplicates']));
      }
      if (j['attestedAt'] != null) {
        rows.addAll([
          ('New leads created', c['created']),
          ('Added to existing leads', c['attached']),
          ('Skipped (existing lead)', c['skipped']),
          ('Could not be imported', c['failed']),
        ]);
      }
    }
    if (rows.isEmpty) return const [];
    return [
      const SizedBox(height: 12),
      for (final (l, v) in rows)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            children: [
              Expanded(
                child: Text(l, style: const TextStyle(color: AppColors.muted)),
              ),
              Text(
                _num(v),
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ],
          ),
        ),
      if (j['dryRun'] == true && status == 'COMPLETED')
        const Padding(
          padding: EdgeInsets.only(top: 4),
          child: Text(
            'Dry run: no leads were created or changed.',
            style: TextStyle(color: AppColors.muted),
          ),
        ),
    ];
  }

  List<Widget> _jobButtons(String? status, bool uploader) {
    final canCancel = !_terminal.contains(status);
    final canResume = status == 'PAUSED' && uploader;
    if (!canCancel && !canResume) return const [];
    return [
      const SizedBox(height: 12),
      if (canResume)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: FilledButton(
            onPressed: _busy ? null : () => _step('/resume'),
            child: const Text('Resume import'),
          ),
        ),
      if (canCancel && !_confirmCancel)
        OutlinedButton(
          onPressed: _busy ? null : () => setState(() => _confirmCancel = true),
          child: const Text('Cancel import'),
        ),
      if (canCancel && _confirmCancel) ...[
        const Text(
          'Cancel this import? Leads already imported are kept.',
          style: TextStyle(color: AppColors.muted),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: FilledButton(
                style: FilledButton.styleFrom(backgroundColor: AppColors.red),
                onPressed: _busy ? null : () => _step('/cancel'),
                child: const Text('Yes, cancel'),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: OutlinedButton(
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(52),
                ),
                onPressed: _busy
                    ? null
                    : () => setState(() => _confirmCancel = false),
                child: const Text('Keep it'),
              ),
            ),
          ],
        ),
      ],
    ];
  }

  List<Widget> _mappingSection(
    Map<String, dynamic> j,
    Map<String, dynamic> options,
  ) {
    final headers = ((j['headers'] as List?) ?? const [])
        .map((h) => '$h')
        .toList();
    final sheets = ((j['sheetNames'] as List?) ?? const []).cast<String>();
    final fields = ((options['fields'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    final sources = ((options['sources'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    final targets =
        (options['targets'] as Map?)?.cast<String, dynamic>() ?? const {};
    final people = ((targets['people'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    final teams = ((targets['teams'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    final missing = [
      for (final f in fields)
        if (f['required'] == true && !_mapping.containsKey(f['field']))
          f['label'] as String? ?? '',
    ];
    final version = j['version'];

    String? fieldFor(int column) {
      for (final e in _mapping.entries) {
        if (e.value == column) return e.key;
      }
      return null;
    }

    return [
      if (sheets.length > 1)
        AppCard(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              DropdownButtonFormField<String>(
                key: ValueKey('sheet-$version'),
                initialValue: _sheet,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Worksheet'),
                items: [
                  for (final s in sheets)
                    DropdownMenuItem(value: s, child: Text(s)),
                ],
                onChanged: (v) => setState(() => _sheet = v),
              ),
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: _busy || _sheet == j['sheetName']
                    ? null
                    : () => _step('/sheet', {
                        'sheet': _sheet,
                        'version': version,
                      }),
                child: const Text('Read this sheet'),
              ),
            ],
          ),
        ),
      const SizedBox(height: 8),
      const Text(
        'Choose which lead field each column of your file holds. Suggestions come from the '
        'column headings. Fields marked * are required.',
        style: TextStyle(color: AppColors.muted),
      ),
      const SizedBox(height: 8),
      for (var i = 0; i < headers.length; i++)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  headers[i].isEmpty
                      ? '(column ${i + 1}, no heading)'
                      : headers[i],
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  key: ValueKey('map-$i-${fieldFor(i)}-$version'),
                  initialValue: fieldFor(i) ?? '',
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Lead field'),
                  items: [
                    const DropdownMenuItem(
                      value: '',
                      child: Text('Not imported'),
                    ),
                    for (final f in fields)
                      DropdownMenuItem(
                        value: f['field'] as String,
                        child: Text(
                          '${f['label']}${f['required'] == true ? ' *' : ''}',
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                  onChanged: (v) => setState(() {
                    _mapping.removeWhere((_, col) => col == i);
                    if (v != null && v.isNotEmpty) _mapping[v] = i;
                  }),
                ),
              ],
            ),
          ),
        ),
      if (missing.isNotEmpty) _Notice('Still to map: ${missing.join(', ')}'),
      const SizedBox(height: 8),
      AppCard(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DropdownButtonFormField<String>(
              key: ValueKey('source-$version'),
              initialValue: sources.any((s) => s['id'] == _source)
                  ? _source
                  : '',
              isExpanded: true,
              decoration: const InputDecoration(
                labelText: 'Lead source when the row has none',
              ),
              items: [
                const DropdownMenuItem(value: '', child: Text('Unknown')),
                for (final s in sources)
                  DropdownMenuItem(
                    value: s['id'] as String,
                    child: Text(s['name'] as String? ?? ''),
                  ),
              ],
              onChanged: (v) => setState(() => _source = v ?? ''),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              key: ValueKey('policy-$version'),
              initialValue: _policy,
              isExpanded: true,
              decoration: const InputDecoration(
                labelText: 'When the phone matches an open lead',
              ),
              items: const [
                DropdownMenuItem(
                  value: 'ATTACH',
                  child: Text(
                    'Add the enquiry to that lead and tell its owner',
                  ),
                ),
                DropdownMenuItem(value: 'SKIP', child: Text('Skip the row')),
              ],
              onChanged: (v) => setState(() => _policy = v ?? 'ATTACH'),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              key: ValueKey('assign-$version'),
              initialValue: _assign,
              isExpanded: true,
              decoration: const InputDecoration(
                labelText: 'Who owns the new leads',
              ),
              items: [
                if (targets['orgQueue'] == true)
                  const DropdownMenuItem(
                    value: 'none',
                    child: Text('Nobody yet (unassigned queue)'),
                  )
                else
                  const DropdownMenuItem(value: '', child: Text('Choose…')),
                for (final p in people)
                  DropdownMenuItem(
                    value: 'user:${p['userId']}',
                    child: Text(p['name'] as String? ?? ''),
                  ),
                for (final t in teams)
                  DropdownMenuItem(
                    value: 'team:${t['id']}',
                    child: Text('Team queue: ${t['name']}'),
                  ),
                for (final t in teams)
                  DropdownMenuItem(
                    value: 'rr:${t['id']}',
                    child: Text('In turn within: ${t['name']}'),
                  ),
              ],
              onChanged: (v) => setState(() => _assign = v ?? ''),
            ),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              value: _dryRun,
              onChanged: (v) => setState(() => _dryRun = v ?? false),
              title: const Text(
                'Dry run only: check every row and show the results, but never import',
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 12),
      FilledButton(
        key: const Key('import-check-rows'),
        onPressed: _busy
            ? null
            : () => _step('/mapping', {
                'mapping': _mapping,
                'defaultSourceId': _source,
                'duplicatePolicy': _policy,
                'assignment': _assignment,
                'dryRun': _dryRun,
                'version': version,
              }),
        child: Text(_busy ? 'Starting checks…' : 'Check rows'),
      ),
    ];
  }

  Widget _confirmPanel(Map<String, dynamic> j, Map<String, dynamic> c) {
    final duplicateFile = j['duplicateOfJob'] != null;
    final text = _data?['attestationText'] as String? ?? '';
    return AppCard(
      padding: const EdgeInsets.all(8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (duplicateFile)
            CheckboxListTile(
              key: const Key('import-ack'),
              controlAffinity: ListTileControlAffinity.leading,
              value: _ack,
              onChanged: (v) => setState(() => _ack = v ?? false),
              title: const Text(
                'This exact file was imported before. Import it again anyway.',
              ),
            ),
          CheckboxListTile(
            key: const Key('import-attest'),
            controlAffinity: ListTileControlAffinity.leading,
            value: _attest,
            onChanged: (v) => setState(() => _attest = v ?? false),
            title: Text(text),
          ),
          Padding(
            padding: const EdgeInsets.all(8),
            child: FilledButton(
              key: const Key('import-confirm'),
              onPressed: _busy || !_attest || (duplicateFile && !_ack)
                  ? null
                  : () => _step('/confirm', {
                      'attest': true,
                      'acknowledgeDuplicateFile': _ack,
                      'version': j['version'],
                    }),
              child: Text(
                _busy ? 'Starting…' : 'Import ${_num(c['valid'])} rows',
              ),
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _issues() {
    final issues = (_data?['issues'] as Map?)?.cast<String, dynamic>();
    if (issues == null) return const [];
    final total = (issues['total'] as num?)?.toInt() ?? 0;
    final items = ((issues['items'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    return [
      SectionLabel('Problems and duplicates', count: total),
      if (total == 0)
        const Text('No row problems.', style: TextStyle(color: AppColors.muted))
      else ...[
        for (final i in items)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Row ${i['row']}${i['column'] != null ? ' · ${i['column']}' : ''}',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 2),
                  Text(i['message'] as String? ?? ''),
                  if (i['relatedRow'] != null)
                    Text(
                      'Same phone as row ${i['relatedRow']}',
                      style: const TextStyle(
                        fontSize: 12,
                        color: AppColors.muted,
                      ),
                    ),
                  if (i['outcome'] == 'DUPLICATE_ATTACHED' ||
                      i['outcome'] == 'DUPLICATE_SKIPPED')
                    Text(
                      i['outcome'] == 'DUPLICATE_SKIPPED'
                          ? 'Skipped; existing lead'
                          : 'Existing lead',
                      style: const TextStyle(
                        fontSize: 12,
                        color: AppColors.muted,
                      ),
                    ),
                ],
              ),
            ),
          ),
        if (total > items.length)
          Text(
            'Showing the first ${_num(items.length)} of ${_num(total)}. Download all of them '
            'as CSV from the import page on the website.',
            style: const TextStyle(fontSize: 12, color: AppColors.muted),
          ),
      ],
    ];
  }
}

/// A tinted message box (warning or error).
class _Notice extends StatelessWidget {
  const _Notice(this.text, {this.error = false});
  final String text;
  final bool error;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: error ? AppColors.redSoft : AppColors.warnSoft,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(
        text,
        style: TextStyle(color: error ? AppColors.red : AppColors.warn),
      ),
    );
  }
}
