import 'package:material_ui/material_ui.dart';
import 'package:uuid/uuid.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../theme.dart';

/// FR-083/084 outcome sheet (POST /api/v1/interactions).
///
/// Outcomes and their labels come from the server (GET /interactions/defaults), so they always
/// match the website. One idempotency key per opened sheet: pressing Save twice, or retrying on
/// a bad connection, never logs the call twice.
class LogOutcomeSheet extends StatefulWidget {
  const LogOutcomeSheet({
    super.key,
    required this.api,
    required this.lead,
    required this.followUps,
    required this.pendingTap,
  });

  final ApiClient api;
  final Map<String, dynamic> lead;
  final dynamic followUps;
  final dynamic pendingTap;

  @override
  State<LogOutcomeSheet> createState() => _LogOutcomeSheetState();
}

class _LogOutcomeSheetState extends State<LogOutcomeSheet> {
  final _idempotencyKey = const Uuid().v4();
  final _notes = TextEditingController();
  final _reason = TextEditingController();
  Map<String, dynamic>? _defaults;
  String? _loadError;
  late String _channel;
  String? _outcome;
  bool _confirmStatus = false;
  bool _completeOwn = true;
  bool _scheduleNext = true;
  int _nextInDays = 1;
  bool _saving = false;
  List<String> _errors = const [];

  Map<String, dynamic>? get _ownFollowUp {
    final f = widget.followUps as Map<String, dynamic>?;
    final open = ((f?['open'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    for (final t in open) {
      if (t['canUpdate'] == true) return t;
    }
    return null;
  }

  bool get _canSchedule =>
      (widget.followUps as Map<String, dynamic>?)?['canSchedule'] == true;

  @override
  void initState() {
    super.initState();
    final tap = widget.pendingTap as Map<String, dynamic>?;
    _channel = tap?['channel'] == 'WHATSAPP_APP'
        ? 'WHATSAPP_APP_MESSAGE'
        : 'PHONE_NATIVE';
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await widget.api.get(
        '/interactions/defaults',
      ) as Map<String, dynamic>;
      if (mounted) setState(() => _defaults = d);
    } on ApiException catch (e) {
      if (mounted) setState(() => _loadError = e.message);
    }
  }

  List<Map<String, dynamic>> get _outcomes {
    final channels = ((_defaults?['channels'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    final c = channels.where((c) => c['code'] == _channel).firstOrNull;
    return ((c?['outcomes'] as List?) ?? const []).cast<Map<String, dynamic>>();
  }

  Map<String, dynamic>? get _selected =>
      _outcomes.where((o) => o['code'] == _outcome).firstOrNull;

  /// The next follow-up, at 10:00 org time, [_nextInDays] days after the server's "now".
  String _nextDueAt() {
    final now = parseLocal(_defaults!['occurredAt'] as String);
    final d = DateTime(now.year, now.month, now.day + _nextInDays, 10);
    return formatLocal(d);
  }

  Future<void> _save() async {
    if (_outcome == null) {
      setState(() => _errors = ['Choose what happened']);
      return;
    }
    setState(() {
      _saving = true;
      _errors = const [];
    });
    final tap = widget.pendingTap as Map<String, dynamic>?;
    final own = _ownFollowUp;
    final requests = _selected?['requestsStatus'];
    final closed =
        widget.lead['stage'] == 'WON' || widget.lead['stage'] == 'LOST';
    // Same rules as the web sheet: completing one's own follow-up and/or setting the next one;
    // with the own follow-up kept open, the next date moves it (a reschedule).
    final nextDue =
        _scheduleNext &&
            !closed &&
            requests == null &&
            (own != null || _canSchedule)
        ? _nextDueAt()
        : null;
    final rescheduling = own != null && !_completeOwn && nextDue != null;
    final body = <String, dynamic>{
      'leadId': widget.lead['id'],
      'idempotencyKey': _idempotencyKey,
      'version': widget.lead['version'],
      'channel': _channel,
      'direction': 'OUTBOUND',
      'outcome': _outcome,
      'occurredAt': tap?['occurredAt'] ?? _defaults!['occurredAt'],
      'notes': _notes.text,
      if (requests != null) 'confirmStatusChange': _confirmStatus,
      if (requests != null && _reason.text.trim().isNotEmpty)
        'statusReason': _reason.text.trim(),
      // They told us on this call: a verbal request (DNC_METHODS).
      if (requests == 'DO_NOT_CONTACT') 'statusMethod': 'VERBAL',
      if (own != null) ...{
        'followUpTaskId': own['id'],
        'followUpVersion': own['version'],
        'completeFollowUp': _completeOwn && requests == null,
      },
      'nextDueAt': ?nextDue,
      if (rescheduling && own['rescheduleNeedsReason'] == true)
        'rescheduleReason': 'Moved after a call',
    };
    try {
      await widget.api.post('/interactions', body);
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _errors = e.allMessages);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_defaults == null) {
      return SizedBox(
        height: 240,
        child: _loadError == null
            ? const Center(child: CircularProgressIndicator())
            : MessageView(message: _loadError!, onRetry: _load),
      );
    }
    final channels = ((_defaults!['channels'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final o in _outcomes) {
      groups.putIfAbsent(o['group'] as String, () => []).add(o);
    }
    const groupTitles = {
      'CONNECTED': 'Spoke to them',
      'NOT_CONNECTED': 'Did not connect',
      'INVALID': 'Number problem',
      'OTHER': 'Other',
    };
    final requests = _selected?['requestsStatus'];
    final own = _ownFollowUp;
    final closed =
        widget.lead['stage'] == 'WON' || widget.lead['stage'] == 'LOST';

    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          Text(
            'Log outcome · ${widget.lead['fullName']}',
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 12),
          SegmentedButton<String>(
            segments: [
              for (final c in channels)
                ButtonSegment(
                  value: c['code'] as String,
                  label: Text(
                    c['label'] as String,
                    style: const TextStyle(fontSize: 12),
                  ),
                ),
            ],
            selected: {_channel},
            showSelectedIcon: false,
            onSelectionChanged: (s) => setState(() {
              _channel = s.first;
              if (!_outcomes.any((o) => o['code'] == _outcome)) _outcome = null;
            }),
          ),
          for (final g in ['CONNECTED', 'NOT_CONNECTED', 'INVALID', 'OTHER'])
            if (groups[g] != null) ...[
              SectionLabel(groupTitles[g]!),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final o in groups[g]!)
                    ChoiceChip(
                      label: Text(o['label'] as String),
                      selected: _outcome == o['code'],
                      onSelected: (_) => setState(() {
                        _outcome = o['code'] as String;
                        _confirmStatus = false;
                      }),
                    ),
                ],
              ),
            ],
          if (requests != null) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.warnSoft,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    value: _confirmStatus,
                    onChanged: (v) =>
                        setState(() => _confirmStatus = v ?? false),
                    title: Text(
                      requests == 'DO_NOT_CONTACT'
                          ? 'This lead asked not to be contacted. Mark the lead Do not contact.'
                          : "The number is invalid. Mark the lead's number invalid.",
                      style: const TextStyle(fontSize: 14),
                    ),
                  ),
                  TextField(
                    controller: _reason,
                    decoration: const InputDecoration(labelText: 'Reason'),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 16),
          TextField(
            controller: _notes,
            minLines: 2,
            maxLines: 5,
            decoration: const InputDecoration(labelText: 'Notes (optional)'),
          ),
          if (!closed && requests == null) ...[
            const SizedBox(height: 8),
            if (own != null)
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _completeOwn,
                onChanged: (v) => setState(() => _completeOwn = v),
                title: const Text('Mark my follow-up done'),
                subtitle: Text(dueText(own['dueAt'] as String?)),
              ),
            if (own != null || _canSchedule)
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _scheduleNext,
                onChanged: (v) => setState(() => _scheduleNext = v),
                title: Text(
                  own != null && !_completeOwn
                      ? 'Move my follow-up'
                      : 'Next follow-up',
                ),
              ),
            if (_scheduleNext && (own != null || _canSchedule))
              Wrap(
                spacing: 8,
                children: [
                  for (final (d, t) in const [
                    (1, 'Tomorrow'),
                    (2, 'In 2 days'),
                    (3, 'In 3 days'),
                    (7, 'Next week'),
                  ])
                    ChoiceChip(
                      label: Text('$t 10 am'),
                      selected: _nextInDays == d,
                      onSelected: (_) => setState(() => _nextInDays = d),
                    ),
                ],
              ),
          ],
          if (_errors.isNotEmpty) ...[
            const SizedBox(height: 12),
            for (final e in _errors)
              Text(e, style: const TextStyle(color: AppColors.red)),
          ],
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.5,
                      color: Colors.white,
                    ),
                  )
                : const Text('Save'),
          ),
        ],
      ),
    );
  }
}
