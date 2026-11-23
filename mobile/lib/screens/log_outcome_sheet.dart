import 'package:material_ui/material_ui.dart';
import 'package:uuid/uuid.dart';

import '../api/api_client.dart';
import '../outbox.dart';
import '../format.dart';
import '../theme.dart';
import 'lead_sheets.dart';
import 'when_picker.dart';

/// FR-083/084 outcome sheet (POST /api/v1/interactions), with the same choices as the website's
/// Log an interaction form (app 1.0.4, owner request 2026-11-23): channel, who made contact, what
/// happened, when, duration, notes, the contact-status confirmation, an optional requirements
/// update, and the follow-up (mark mine done, the next one at a chosen time with a title, or a
/// reschedule with a reason).
///
/// Channels, outcomes and labels come from the server (GET /interactions/defaults), so they always
/// match the website. One idempotency key per opened sheet: pressing Save twice, or retrying on
/// a bad connection, never logs the call twice.
class LogOutcomeSheet extends StatefulWidget {
  const LogOutcomeSheet({
    super.key,
    required this.api,
    required this.lead,
    required this.followUps,
    required this.pendingTap,
    this.outbox,
  });

  final ApiClient api;
  final Map<String, dynamic> lead;
  final dynamic followUps;
  final dynamic pendingTap;

  /// Where the outcome waits when there is no connection (null: show the error instead).
  final Outbox? outbox;

  @override
  State<LogOutcomeSheet> createState() => _LogOutcomeSheetState();
}

/// Requirement fields the sheet can update, with the lead's current value as text.
const _selectFields = {
  'transactionType': 'Looking to',
  'propertyType': 'Property type',
  'purpose': 'Purpose',
  'timeline': 'Timeline',
  'intent': 'Intent',
};
const _textFields = {
  'preferredCity': 'City',
  'preferredLocalities': 'Areas (separate with commas)',
  'budgetMin': 'Budget from (AED)',
  'budgetMax': 'Budget up to (AED)',
  'bhkMin': 'Bedrooms from',
  'bhkMax': 'Bedrooms up to',
};

class _LogOutcomeSheetState extends State<LogOutcomeSheet> {
  final _idempotencyKey = const Uuid().v4();
  final _notes = TextEditingController();
  final _duration = TextEditingController();
  final _statusReason = TextEditingController();
  final _evidence = TextEditingController();
  final _nextTitle = TextEditingController();
  final _rescheduleReason = TextEditingController();
  final Map<String, TextEditingController> _text = {
    for (final k in _textFields.keys) k: TextEditingController(),
  };
  final Map<String, String> _select = {};
  final Map<String, String> _initial = {};

  Map<String, dynamic>? _defaults;
  String? _loadError;
  late String _channel;
  late String _direction;
  String? _outcome;
  late String _when;
  bool _confirmInvalid = false;
  bool _confirmStatus = false;
  String? _statusMethod;
  bool _completeOwn = true;
  bool _setNext = true;
  String? _next;
  bool _saving = false;
  bool _reqOpen = false;
  List<String> _errors = const [];

  Map<String, dynamic> get _lead => widget.lead;
  bool get _dnc => _lead['contactStatus'] == 'DO_NOT_CONTACT';

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

  bool get _closed => _lead['stage'] == 'WON' || _lead['stage'] == 'LOST';

  @override
  void initState() {
    super.initState();
    final tap = widget.pendingTap as Map<String, dynamic>?;
    _channel = tap?['channel'] == 'WHATSAPP_APP'
        ? 'WHATSAPP_APP_MESSAGE'
        : 'PHONE_NATIVE';
    // On a Do-Not-Contact lead only contact the customer started can be logged.
    _direction = _dnc ? 'INBOUND' : 'OUTBOUND';
    _when = tap?['occurredAt'] as String? ?? formatLocal(DateTime.now());
    for (final k in _selectFields.keys) {
      _initial[k] = '${_lead[k] ?? ''}';
      _select[k] = _initial[k]!;
    }
    for (final k in _textFields.keys) {
      final v = _lead[k];
      final s = v is List ? v.join(', ') : '${v ?? ''}';
      _initial[k] = s;
      _text[k]!.text = s;
    }
    _load();
  }

  @override
  void dispose() {
    for (final c in [
      _notes,
      _duration,
      _statusReason,
      _evidence,
      _nextTitle,
      _rescheduleReason,
      ..._text.values,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await widget.api.get(
        '/interactions/defaults',
      ) as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _defaults = d;
        if (widget.pendingTap == null) _when = d['occurredAt'] as String;
        final now = parseLocal(d['occurredAt'] as String);
        _next = formatLocal(DateTime(now.year, now.month, now.day + 1, 10));
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _loadError = e.message);
    }
  }

  // --- what the server sent -------------------------------------------------------------------

  List<Map<String, dynamic>> _maps(dynamic v) =>
      ((v as List?) ?? const []).cast<Map<String, dynamic>>();

  /// Every channel (app 1.0.4); an older server sends the three outbound ones only.
  List<Map<String, dynamic>> get _channels {
    final all = _maps(_defaults?['allChannels']);
    if (all.isNotEmpty) return all;
    return [
      for (final c in _maps(_defaults?['channels']))
        {...c, 'outbound': c['outcomes'], 'inbound': const []},
    ];
  }

  Map<String, dynamic>? get _channelData =>
      _channels.where((c) => c['code'] == _channel).firstOrNull;

  List<Map<String, dynamic>> get _outcomes =>
      _maps(_channelData?[_direction == 'INBOUND' ? 'inbound' : 'outbound']);

  Map<String, dynamic>? get _selected =>
      _outcomes.where((o) => o['code'] == _outcome).firstOrNull;

  /// The contact-status change saving would make (the website's contactStatusEffect).
  String? get _statusChange {
    final to = _selected?['requestsStatus'] as String?;
    final current = _lead['contactStatus'] as String?;
    if (to == null || current == to || current == 'DO_NOT_CONTACT') return null;
    return to;
  }

  String? get _statusUnchanged {
    final to = _selected?['requestsStatus'] as String?;
    final current = _lead['contactStatus'] as String?;
    if (to == null || _statusChange != null) return null;
    if (current == to) {
      return to == 'DO_NOT_CONTACT'
          ? 'This lead is already marked do not contact.'
          : "This lead's number is already marked invalid.";
    }
    return 'This lead stays do not contact. Its number is not marked invalid.';
  }

  // --- save -----------------------------------------------------------------------------------

  Future<void> _save() async {
    if (_outcome == null) {
      setState(() => _errors = ['Choose what happened']);
      return;
    }
    setState(() {
      _saving = true;
      _errors = const [];
    });
    final own = _ownFollowUp;
    final change = _statusChange;
    final followUpOpen = !_closed && change == null;
    final moving = own != null && !_completeOwn;
    final nextDue = followUpOpen && _setNext && (own != null || _canSchedule)
        ? _next
        : null;
    final changed = <String, String>{};
    if (_lead['canUpdate'] == true) {
      for (final k in _selectFields.keys) {
        if (_select[k] != _initial[k]) changed[k] = _select[k]!;
      }
      for (final k in _textFields.keys) {
        final v = _text[k]!.text.trim();
        if (v != _initial[k]!.trim()) changed[k] = v;
      }
    }
    final body = <String, dynamic>{
      'leadId': _lead['id'],
      'idempotencyKey': _idempotencyKey,
      'version': _lead['version'],
      'channel': _channel,
      'direction': _direction,
      'outcome': _outcome,
      'occurredAt': _when,
      'notes': _notes.text,
      if (_channelData?['durationAllowed'] == true &&
          _duration.text.trim().isNotEmpty)
        'durationMinutes': _duration.text.trim(),
      if (_direction == 'OUTBOUND' && _lead['contactStatus'] == 'INVALID')
        'confirmInvalidNumber': _confirmInvalid,
      if (change != null) ...{
        'confirmStatusChange': _confirmStatus,
        'statusReason': _statusReason.text.trim(),
        if (change == 'DO_NOT_CONTACT') 'statusMethod': _statusMethod ?? '',
        if (_evidence.text.trim().isNotEmpty)
          'statusEvidenceRef': _evidence.text.trim(),
      },
      if (changed.isNotEmpty) ...{
        ...changed,
        'requirementFields': changed.keys.join(','),
      },
      if (own != null && followUpOpen) ...{
        'followUpTaskId': own['id'],
        'followUpVersion': own['version'],
        'completeFollowUp': _completeOwn,
      },
      'nextDueAt': ?nextDue,
      if (nextDue != null && moving)
        'rescheduleReason': _rescheduleReason.text.trim(),
      if (nextDue != null && !moving && _nextTitle.text.trim().isNotEmpty)
        'nextTitle': _nextTitle.text.trim(),
    };
    try {
      await widget.api.post('/interactions', body);
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      final outbox = widget.outbox;
      if (e.status == 0 && outbox != null) {
        // No signal: keep it on the phone; the same idempotency key makes the later send safe.
        await outbox.add(body, leadName: '${_lead['fullName'] ?? 'this lead'}');
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'No signal. The outcome is saved on your phone and will be sent automatically.',
            ),
          ),
        );
        Navigator.of(context).pop(false);
        return;
      }
      if (mounted) setState(() => _errors = e.allMessages);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // --- view -----------------------------------------------------------------------------------

  /// A tinted panel. A Material (not a coloured box) so the checkbox rows inside it still paint
  /// their ink.
  Widget _box(Color bg, List<Widget> children) => Padding(
    padding: const EdgeInsets.only(top: 12),
    child: Material(
      color: bg,
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: children,
        ),
      ),
    ),
  );

  Widget _check(bool value, ValueChanged<bool> on, String text) =>
      CheckboxListTile(
        contentPadding: EdgeInsets.zero,
        controlAffinity: ListTileControlAffinity.leading,
        value: value,
        onChanged: (v) => setState(() => on(v ?? false)),
        title: Text(text, style: const TextStyle(fontSize: 14)),
      );

  // --- requirements -------------------------------------------------------------------------

  List<Map<String, dynamic>> _reqOptions(String key) =>
      _maps(((_defaults?['requirementOptions'] as Map?) ?? const {})[key]);

  String _optLabel(String key, String code) =>
      _reqOptions(key)
          .where((o) => o['code'] == code)
          .map((o) => o['label'] as String? ?? code)
          .firstOrNull ??
      code;

  /// The requirement fields whose value differs from the lead's.
  List<String> get _changedRequirements => [
    for (final k in _selectFields.keys)
      if (_select[k] != _initial[k]) k,
    for (final k in _textFields.keys)
      if (_text[k]!.text.trim() != _initial[k]!.trim()) k,
  ];

  /// "Buy · Apartment · Dubai · up to AED 2.5M" from the values now in the form.
  String get _requirementSummary {
    String sel(String k) =>
        _select[k]!.isEmpty ? '' : _optLabel(k, _select[k]!);
    String txt(String k) => _text[k]!.text.trim();
    final from = num.tryParse(txt('budgetMin'));
    final to = num.tryParse(txt('budgetMax'));
    var budget = '';
    if (from != null && to != null) {
      budget = '${aed(from)} – ${aed(to)}';
    } else if (to != null) {
      budget = 'up to ${aed(to)}';
    } else if (from != null) {
      budget = 'from ${aed(from)}';
    }
    final b1 = txt('bhkMin');
    final b2 = txt('bhkMax');
    var beds = '';
    if (b1.isNotEmpty && b2.isNotEmpty && b1 != b2) {
      beds = '$b1–$b2 BR';
    } else if (b2.isNotEmpty) {
      beds = '$b2 BR';
    } else if (b1.isNotEmpty) {
      beds = '$b1+ BR';
    }
    final parts = [
      sel('transactionType'),
      sel('propertyType'),
      txt('preferredCity'),
      budget,
      beds,
      sel('intent'),
    ].where((p) => p.isNotEmpty).toList();
    return parts.isEmpty ? 'Nothing filled in yet' : parts.join(' · ');
  }

  Widget _reqLabel(String text) => Padding(
    padding: const EdgeInsets.only(top: 14, bottom: 8),
    child: Text(
      text,
      style: const TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w600,
        color: AppColors.gray,
      ),
    ),
  );

  /// One short list as tap-to-pick chips; tapping the chosen one clears it.
  Widget _reqChips(String key) {
    final opts = _reqOptions(key);
    if (opts.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _reqLabel(_selectFields[key]!),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final o in opts)
              ChoiceChip(
                label: Text(o['label'] as String? ?? ''),
                selected: _select[key] == o['code'],
                showCheckmark: false,
                // The chosen value must stand out at a glance: solid teal, white text.
                selectedColor: AppColors.teal,
                labelStyle: TextStyle(
                  color: _select[key] == o['code']
                      ? Colors.white
                      : AppColors.text,
                  fontWeight: _select[key] == o['code']
                      ? FontWeight.w600
                      : FontWeight.w400,
                ),
                onSelected: (on) => setState(
                  () => _select[key] = on ? o['code'] as String : '',
                ),
              ),
          ],
        ),
      ],
    );
  }

  Widget _reqField(String key, {String? label, bool number = false}) =>
      TextField(
        controller: _text[key],
        keyboardType: number ? TextInputType.number : TextInputType.text,
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(
          labelText: label ?? _textFields[key],
          isDense: true,
        ),
      );

  Widget _reqPair(String title, String a, String b) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _reqLabel(title),
      Row(
        children: [
          Expanded(child: _reqField(a, label: 'From', number: true)),
          const SizedBox(width: 10),
          Expanded(child: _reqField(b, label: 'Up to', number: true)),
        ],
      ),
    ],
  );

  /// The lead's requirements as a card: a summary and Edit when closed; grouped fields (chips for
  /// the short lists, budget and bedrooms side by side) when open. Only changed fields are sent.
  Widget _requirements() {
    final changed = _changedRequirements.length;
    return Container(
      margin: const EdgeInsets.only(top: 16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: _reqOpen ? AppColors.teal : AppColors.border,
          width: _reqOpen ? 1.5 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: () => setState(() => _reqOpen = !_reqOpen),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 8, 12),
              child: Row(
                children: [
                  Container(
                    width: 36,
                    height: 36,
                    decoration: const BoxDecoration(
                      color: AppColors.tealSoft,
                      shape: BoxShape.circle,
                    ),
                    child: const Icon(
                      Icons.home_work_outlined,
                      size: 20,
                      color: AppColors.teal,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Flexible(
                              child: Text(
                                'Requirements',
                                style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w700,
                                  color: AppColors.text,
                                ),
                              ),
                            ),
                            if (changed > 0) ...[
                              const SizedBox(width: 8),
                              Pill.teal('$changed changed'),
                            ],
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          _requirementSummary,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 13,
                            color: AppColors.muted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  TextButton(
                    onPressed: () => setState(() => _reqOpen = !_reqOpen),
                    child: Text(_reqOpen ? 'Hide' : 'Edit'),
                  ),
                ],
              ),
            ),
          ),
          if (_reqOpen)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Divider(height: 1, color: AppColors.border),
                  _reqChips('transactionType'),
                  _reqChips('propertyType'),
                  _reqLabel('Location'),
                  _reqField('preferredCity'),
                  const SizedBox(height: 10),
                  _reqField('preferredLocalities'),
                  _reqPair('Budget (AED)', 'budgetMin', 'budgetMax'),
                  _reqPair('Bedrooms', 'bhkMin', 'bhkMax'),
                  _reqChips('intent'),
                  _reqChips('timeline'),
                  _reqChips('purpose'),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _followUp() {
    final own = _ownFollowUp;
    if (_closed) {
      return const Padding(
        padding: EdgeInsets.only(top: 12),
        child: Text(
          'Won and lost leads take no follow-ups.',
          style: TextStyle(color: AppColors.muted),
        ),
      );
    }
    if (own == null && !_canSchedule) return const SizedBox.shrink();
    final moving = own != null && !_completeOwn;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionLabel('Follow-up'),
        if (own != null)
          _check(
            _completeOwn,
            (v) => _completeOwn = v,
            'Mark my follow-up for ${dueText(own['dueAt'] as String?)} done',
          ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          value: _setNext,
          onChanged: (v) => setState(() => _setNext = v),
          title: Text(moving ? 'Reschedule my follow-up' : 'Next follow-up'),
        ),
        if (_setNext && _next != null) ...[
          Wrap(
            spacing: 8,
            children: [
              for (final (d, t) in const [
                (1, 'Tomorrow'),
                (2, 'In 2 days'),
                (7, 'Next week'),
              ])
                ActionChip(
                  label: Text(t),
                  onPressed: () => setState(() {
                    final now = parseLocal(_defaults!['occurredAt'] as String);
                    final cur = parseLocal(_next!);
                    _next = formatLocal(
                      DateTime(
                        now.year,
                        now.month,
                        now.day + d,
                        cur.hour,
                        cur.minute,
                      ),
                    );
                  }),
                ),
            ],
          ),
          const SizedBox(height: 8),
          WhenPicker(
            label: moving ? 'Reschedule to' : 'Next follow-up on',
            value: _next!,
            onChanged: (s) => setState(() => _next = s),
          ),
          const SizedBox(height: 10),
          if (moving)
            TextField(
              controller: _rescheduleReason,
              decoration: InputDecoration(
                labelText: own['rescheduleNeedsReason'] == true
                    ? 'Reason for rescheduling (needed)'
                    : 'Reason for rescheduling (optional)',
              ),
            )
          else
            TextField(
              controller: _nextTitle,
              maxLength: 200,
              decoration: const InputDecoration(
                labelText: 'What to follow up on (optional)',
              ),
            ),
        ],
      ],
    );
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
    final directions = _maps(_defaults!['directions']);
    final change = _statusChange;
    final unchanged = _statusUnchanged;
    final moves =
        _selected?['group'] == 'CONNECTED' && _lead['stage'] == 'ASSIGNED';

    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          Text(
            'Log outcome · ${_lead['fullName']}',
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
          if (_dnc)
            const Padding(
              padding: EdgeInsets.only(top: 6),
              child: Text(
                'This lead asked not to be contacted. You can log only contact they started; '
                'it does not permit contacting them.',
                style: TextStyle(color: AppColors.muted, fontSize: 13),
              ),
            ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _channel,
            decoration: const InputDecoration(labelText: 'Channel'),
            items: [
              for (final c in _channels)
                DropdownMenuItem(
                  value: c['code'] as String,
                  child: Text(c['label'] as String? ?? ''),
                ),
            ],
            onChanged: (v) => setState(() {
              _channel = v ?? _channel;
              if (!_outcomes.any((o) => o['code'] == _outcome)) _outcome = null;
            }),
          ),
          if (directions.isNotEmpty && !_dnc) ...[
            const SizedBox(height: 12),
            SegmentedButton<String>(
              segments: [
                for (final d in directions)
                  ButtonSegment(
                    value: d['code'] as String,
                    label: Text(
                      d['label'] as String? ?? '',
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
              ],
              selected: {_direction},
              showSelectedIcon: false,
              onSelectionChanged: (s) => setState(() {
                _direction = s.first;
                if (!_outcomes.any((o) => o['code'] == _outcome)) {
                  _outcome = null;
                }
              }),
            ),
          ],
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
          if (moves)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'Saving moves the lead from Assigned to Contacted.',
                style: TextStyle(fontSize: 13),
              ),
            ),
          const SizedBox(height: 16),
          WhenPicker(
            label: 'When',
            value: _when,
            onChanged: (s) => setState(() => _when = s),
          ),
          if (_channelData?['durationAllowed'] == true) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _duration,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'Duration in minutes (optional)',
              ),
            ),
          ],
          const SizedBox(height: 12),
          TextField(
            controller: _notes,
            minLines: 2,
            maxLines: 5,
            maxLength: 2000,
            decoration: const InputDecoration(labelText: 'Notes (optional)'),
          ),
          if (_direction == 'OUTBOUND' && _lead['contactStatus'] == 'INVALID')
            _check(
              _confirmInvalid,
              (v) => _confirmInvalid = v,
              "This lead's number is marked invalid. I contacted them anyway.",
            ),
          if (change != null)
            _box(AppColors.warnSoft, [
              Text(
                change == 'DO_NOT_CONTACT'
                    ? 'Saving marks this lead do not contact. Every channel is then blocked, '
                          'and only an Owner or Admin can lift it.'
                    : "Saving marks this lead's number invalid. Contacting it then needs a "
                          'confirmation.',
                style: const TextStyle(fontSize: 13),
              ),
              _check(
                _confirmStatus,
                (v) => _confirmStatus = v,
                change == 'DO_NOT_CONTACT'
                    ? 'They asked not to be contacted. Mark the lead do not contact.'
                    : 'The number is wrong or invalid. Mark it invalid.',
              ),
              if (change == 'DO_NOT_CONTACT')
                DropdownButtonFormField<String>(
                  initialValue: _statusMethod,
                  decoration: const InputDecoration(
                    labelText: 'How they asked',
                  ),
                  items: [
                    for (final m in _maps(_defaults!['dncMethods']))
                      DropdownMenuItem(
                        value: m['code'] as String,
                        child: Text(m['label'] as String? ?? ''),
                      ),
                  ],
                  onChanged: (v) => setState(() => _statusMethod = v),
                ),
              const SizedBox(height: 10),
              TextField(
                controller: _statusReason,
                decoration: const InputDecoration(labelText: 'Reason'),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _evidence,
                decoration: const InputDecoration(
                  labelText: 'Evidence reference (optional)',
                ),
              ),
            ]),
          if (unchanged != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(unchanged, style: const TextStyle(fontSize: 13)),
            ),
          if (_lead['canUpdate'] == true) _requirements(),
          if (change == null) _followUp(),
          FormErrors(_errors),
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
                : const Text('Save interaction'),
          ),
        ],
      ),
    );
  }
}
