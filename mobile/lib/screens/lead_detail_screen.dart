import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import 'assign_sheet.dart';
import 'lead_extras.dart';
import 'lead_sheets.dart';
import 'task_sheet.dart';
import 'log_outcome_sheet.dart';
import 'visit_sheet.dart';

/// The lead screen (GET /api/v1/leads/:id): contact, Call / WhatsApp, the follow-up, visits,
/// requirements and the suggested call script.
///
/// Call flow (FR-080–082): a tap records a call intent on the server and opens the dialer or
/// WhatsApp. When the person comes back to the app, the outcome sheet opens by itself. The app
/// never reads the call log (ADR-0006).
class LeadDetailScreen extends StatefulWidget {
  const LeadDetailScreen({
    super.key,
    required this.session,
    required this.leadId,
    this.openLogOutcome = false,
  });
  final Session session;
  final String leadId;

  /// Open the outcome sheet once the lead has loaded (My Day's "calls with no outcome").
  final bool openLogOutcome;

  @override
  State<LeadDetailScreen> createState() => _LeadDetailScreenState();
}

class _LeadDetailScreenState extends State<LeadDetailScreen> {
  Map<String, dynamic>? _data;
  String? _error;
  Map<String, dynamic>? _revealed;
  List<Map<String, dynamic>>? _history;
  bool _busy = false;
  bool _awaitingReturn = false;
  bool _sheetOpen = false;
  late final AppLifecycleListener _lifecycle;

  ApiClient get _api => widget.session.api;
  Map<String, dynamic> get _lead => _data!['lead'] as Map<String, dynamic>;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(onResume: _onResume);
    _load();
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d =
          await _api.get('/leads/${widget.leadId}') as Map<String, dynamic>;
      if (mounted) {
        final first = _data == null;
        setState(() {
          _data = d;
          _error = null;
        });
        _loadHistory();
        if (first &&
            widget.openLogOutcome &&
            _lead['canLogInteraction'] == true) {
          WidgetsBinding.instance.addPostFrameCallback((_) => _openSheet());
        }
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(
          () => _error = e.status == 404
              ? 'This lead is not available to you.'
              : e.message,
        );
      }
    }
  }

  /// The three newest history entries for the "Recent history" section.
  Future<void> _loadHistory() async {
    if (!widget.session.me!.can('lead.view_activity_timeline')) return;
    try {
      final rows = await _api.get('/leads/${widget.leadId}/timeline') as List;
      if (mounted) {
        setState(() => _history = rows.cast<Map<String, dynamic>>());
      }
    } on ApiException {
      // The rest of the lead screen works without it.
    }
  }

  Future<void> _onResume() async {
    if (!_awaitingReturn) return;
    _awaitingReturn = false;
    await _load();
    if (mounted && _data?['pendingTap'] != null) _openSheet();
  }

  void _toast(String m) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));

  Future<void> _reveal() async {
    setState(() => _busy = true);
    try {
      final r = await _api.post(
        '/leads/${widget.leadId}/reveal-phone',
      ) as Map<String, dynamic>;
      if (mounted) setState(() => _revealed = r);
    } on ApiException catch (e) {
      _toast(e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _contact(
    String channel, {
    bool confirmInvalid = false,
    String text = '',
  }) async {
    setState(() => _busy = true);
    try {
      final r = await _api.post('/leads/${widget.leadId}/call-intents', {
        'channel': channel,
        if (confirmInvalid) 'confirmInvalidNumber': true,
      }) as Map<String, dynamic>;
      _awaitingReturn = true;
      final ok = await launchUrl(
        Uri.parse(withWhatsAppText(r['href'] as String, text)),
        mode: LaunchMode.externalApplication,
      );
      if (!ok) {
        _awaitingReturn = false;
        _toast(
          channel == 'WHATSAPP_APP'
              ? 'WhatsApp is not installed'
              : 'Could not open the dialer',
        );
        await _load();
      }
    } on ApiException catch (e) {
      // FR-065: an Invalid number may still be tried after confirming; Do-Not-Contact never.
      final invalid = e.fieldErrors.containsKey('confirmInvalidNumber');
      if (invalid && mounted && await _confirm(e.allMessages.join('\n'))) {
        if (mounted) setState(() => _busy = false);
        return _contact(channel, confirmInvalid: true, text: text);
      }
      _toast(e.allMessages.join('\n'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<bool> _confirm(String message) async {
    final r = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Number marked invalid'),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(c, true),
            child: const Text('Try anyway'),
          ),
        ],
      ),
    );
    return r ?? false;
  }

  Future<void> _openSheet() async {
    if (_sheetOpen || _data == null) return;
    _sheetOpen = true;
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => LogOutcomeSheet(
        api: _api,
        lead: _lead,
        followUps: _data!['followUps'],
        pendingTap: _data!['pendingTap'],
        outbox: widget.session.outbox,
      ),
    );
    _sheetOpen = false;
    if (saved == true) {
      _toast('Outcome saved');
      await _load();
    }
  }

  Future<void> _modal(Widget sheet, String done) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => sheet,
    );
    if (saved == true) {
      _toast(done);
      await _load();
    }
  }

  String get _nowLocal =>
      _data!['nowLocal'] as String? ?? formatLocal(DateTime.now());

  List<Map<String, dynamic>> _maps(dynamic v) =>
      ((v as List?) ?? const []).cast<Map<String, dynamic>>();

  void _bookVisit() => _modal(
    BookVisitSheet(
      api: _api,
      lead: _lead,
      nowLocal: _nowLocal,
      people: _maps(_data!['visitPeople']),
    ),
    'Visit booked',
  );

  void _addTask() => _modal(
    AddTaskSheet(api: _api, lead: _lead, nowLocal: _nowLocal),
    'Task added',
  );

  void _changeStage() {
    final stage = _data!['stage'] as Map<String, dynamic>?;
    _modal(
      StageSheet(
        api: _api,
        lead: _lead,
        targets: _maps(stage?['targets']),
        lostReasons: _maps(stage?['lostReasons']),
        nowLocal: _nowLocal,
      ),
      'Stage changed',
    );
  }

  /// Quick messages (owner request 2026-11-24): WhatsApp opens with the chosen text.
  Future<void> _whatsApp() async {
    final me = widget.session.me!;
    final visits = _maps((_data!['visits'] as Map?)?['visits']);
    final next = visits
        .where(
          (v) => const {
            'SCHEDULED',
            'CONFIRMED',
            'RESCHEDULED',
          }.contains(v['status']),
        )
        .firstOrNull;
    final name = _lead['fullName'] as String? ?? '';
    final text = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => WhatsAppMessageSheet(
        api: _api,
        leadFirstName: name.trim().split(RegExp(r'\s+')).first,
        messages: quickMessages(
          leadName: name,
          agent: me.name,
          org: me.orgName,
          visit: next,
        ),
      ),
    );
    if (text == null || !mounted) return;
    await _contact('WHATSAPP_APP', text: text);
  }

  void _editContact() =>
      _modal(EditContactSheet(api: _api, lead: _lead), 'Contact details saved');

  void _addTag() => _modal(
    AddTagSheet(
      api: _api,
      leadId: widget.leadId,
      options: _maps(_data!['tagOptions']),
      current: _maps(_data!['tags']),
    ),
    'Tag added',
  );

  void _openHistory() => Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => LeadHistoryScreen(
        api: _api,
        leadId: widget.leadId,
        leadName: _lead['fullName'] as String? ?? '',
      ),
    ),
  );

  Future<void> _openVisit(Map<String, dynamic> v) async {
    await _modal(VisitSheet(api: _api, visit: v), 'Visit updated');
    // Properties can change without closing the sheet with a result.
    await _load();
  }

  // --- sections -------------------------------------------------------------------------------

  Widget _header() {
    final l = _lead;
    final status = l['contactStatus'] as String?;
    return AppCard(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              Pill.teal(label(stageLabels, l['stage'] as String?)),
              if (l['intent'] == 'HOT') Pill.warn('Hot'),
              if (l['intent'] == 'WARM') Pill('Warm'),
              if (l['intent'] == 'COLD') Pill('Cold'),
              if (l['archivedAt'] != null) Pill('Archived'),
              for (final t in _maps(_data!['tags'])) Pill('#${t['name']}'),
              if (_maps(_data!['tagOptions']).isNotEmpty)
                InkWell(
                  borderRadius: BorderRadius.circular(999),
                  onTap: _addTag,
                  child: Pill.teal('+ Tag'),
                ),
            ],
          ),
          if (status == 'DO_NOT_CONTACT' || status == 'INVALID') ...[
            const SizedBox(height: 10),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.redSoft,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                status == 'DO_NOT_CONTACT'
                    ? 'Do not contact. This lead asked not to be contacted.'
                    : 'The number is marked invalid.',
                style: const TextStyle(
                  color: AppColors.red,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
          const SizedBox(height: 12),
          _phoneRow(
            'Phone',
            (_revealed?['primaryPhoneE164'] ?? l['primaryPhoneE164'])
                as String?,
          ),
          if ((_revealed?['alternatePhoneE164'] ?? l['alternatePhoneE164']) !=
              null)
            _phoneRow(
              'Alternate',
              (_revealed?['alternatePhoneE164'] ?? l['alternatePhoneE164'])
                  as String?,
            ),
          if (l['phoneMasked'] == true &&
              l['canRevealPhone'] == true &&
              _revealed == null)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: _busy ? null : _reveal,
                icon: const Icon(Icons.visibility_outlined, size: 18),
                label: const Text('Reveal number'),
              ),
            ),
          if (_revealed != null)
            Text(
              '${_revealed!['remainingToday']} reveals left today',
              style: const TextStyle(fontSize: 12, color: AppColors.muted),
            ),
          if ((l['email'] as String?) != null)
            _kv('Email', l['email'] as String),
          _kv('Source', l['sourceName'] as String? ?? ''),
          if (widget.session.me!.scope('lead.read') != 'OWN')
            _kv('Owner', (l['ownerName'] as String?) ?? 'Unassigned'),
          if (_data!['canEditContact'] == true)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: _editContact,
                icon: const Icon(Icons.edit_outlined, size: 18),
                label: const Text('Edit contact details'),
              ),
            ),
          if (_canAssign)
            Align(
              alignment: Alignment.centerLeft,
              child: Padding(
                padding: const EdgeInsets.only(top: 8),
                child: OutlinedButton.icon(
                  onPressed: _busy ? null : _assign,
                  icon: const Icon(Icons.person_add_alt_1, size: 18),
                  label: Text(l['ownerUserId'] == null ? 'Assign' : 'Reassign'),
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// FR-070: Owner, Admin and Sales Manager (in scope) on an open, writable lead.
  bool get _canAssign {
    final l = _lead;
    return l['canAssign'] == true &&
        l['stage'] != 'WON' &&
        l['stage'] != 'LOST';
  }

  Future<void> _assign() async {
    final l = _lead;
    final ok = await showAssignSheet(
      context,
      api: _api,
      leadIds: [l['id'] as String],
      version: (l['version'] as num).toInt(),
      currentOwnerId: l['ownerUserId'] as String?,
    );
    if (ok && mounted) {
      _toast('Lead assigned');
      await _load();
    }
  }

  Widget _phoneRow(String k, String? v) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: Row(
      children: [
        SizedBox(
          width: 84,
          child: Text(
            k,
            style: const TextStyle(color: AppColors.muted, fontSize: 13),
          ),
        ),
        Text(
          v ?? '—',
          style: const TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.w600,
            letterSpacing: .3,
          ),
        ),
      ],
    ),
  );

  Widget _kv(String k, String v) => Padding(
    padding: const EdgeInsets.only(top: 4),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 84,
          child: Text(
            k,
            style: const TextStyle(color: AppColors.muted, fontSize: 13),
          ),
        ),
        Expanded(child: Text(v, style: const TextStyle(fontSize: 14))),
      ],
    ),
  );

  Widget _actions() {
    final l = _lead;
    final canLog = l['canLogInteraction'] == true;
    final canLaunch =
        canLog && (l['phoneMasked'] != true || l['canRevealPhone'] == true);
    final dnc = l['contactStatus'] == 'DO_NOT_CONTACT';
    final pending = _data!['pendingTap'];
    final canStage = _maps(
      (_data!['stage'] as Map<String, dynamic>?)?['targets'],
    ).any((t) => t['code'] != 'SITE_VISIT_SCHEDULED');
    final canBook =
        (_data!['visits'] as Map<String, dynamic>?)?['canSchedule'] == true;
    return Column(
      children: [
        if (pending != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Material(
              color: AppColors.warnSoft,
              borderRadius: BorderRadius.circular(12),
              child: ListTile(
                leading: const Icon(
                  Icons.phone_callback_outlined,
                  color: AppColors.warn,
                ),
                title: const Text(
                  'How did it go?',
                  style: TextStyle(fontWeight: FontWeight.w600),
                ),
                subtitle: Text(
                  'You tapped ${pending['channel'] == 'WHATSAPP_APP' ? 'WhatsApp' : 'Call'} ${dueText(pending['createdAt'] as String?)}',
                ),
                trailing: FilledButton(
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(80, 40),
                  ),
                  onPressed: _openSheet,
                  child: const Text('Log'),
                ),
              ),
            ),
          ),
        if (canLaunch && !dnc)
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: _busy ? null : () => _contact('PHONE_NATIVE'),
                  icon: const Icon(Icons.call),
                  label: const Text('Call'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size.fromHeight(52),
                  ),
                  onPressed: _busy ? null : _whatsApp,
                  icon: const Icon(Icons.chat_outlined),
                  label: const Text('WhatsApp'),
                ),
              ),
            ],
          ),
        if (canLog)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: _openSheet,
              icon: const Icon(Icons.edit_note),
              label: const Text('Log an outcome without calling'),
            ),
          ),
        if (canStage || canBook)
          Row(
            children: [
              if (canStage)
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _changeStage,
                    icon: const Icon(Icons.swap_horiz),
                    label: const Text('Change stage'),
                  ),
                ),
              if (canStage && canBook) const SizedBox(width: 10),
              if (canBook)
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _bookVisit,
                    icon: const Icon(Icons.add_location_alt_outlined),
                    label: const Text('Book visit'),
                  ),
                ),
            ],
          ),
        if (_canAddTask)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: _addTask,
              icon: const Icon(Icons.add_task),
              label: const Text('Add a task or follow-up'),
            ),
          ),
      ],
    );
  }

  bool get _canAddTask =>
      _lead['canUpdate'] == true &&
      widget.session.me!.can('task.create') &&
      _lead['stage'] != 'WON' &&
      _lead['stage'] != 'LOST';

  Widget _followUps() {
    final f = _data!['followUps'] as Map<String, dynamic>?;
    if (f == null) return const SizedBox.shrink();
    final open = ((f['open'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    final tasks = ((f['tasks'] as List?) ?? const [])
        .cast<Map<String, dynamic>>()
        .where((t) => t['status'] == 'OPEN')
        .toList();
    final all = [...open, ...tasks];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionLabel('Follow-ups and tasks'),
        if (all.isEmpty)
          Text(
            (f['scheduleBlockedReason'] as String?) ??
                'No open follow-up. Schedule one when you log an outcome.',
            style: const TextStyle(color: AppColors.muted),
          ),
        for (final t in all)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: AppCard(
              child: Row(
                children: [
                  Icon(
                    t['overdue'] == true ? Icons.error_outline : Icons.schedule,
                    color: t['overdue'] == true
                        ? AppColors.red
                        : AppColors.muted,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          (t['title'] as String?)?.isNotEmpty == true
                              ? t['title'] as String
                              : label(taskTypeLabels, t['type'] as String?),
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                        Text(
                          [
                            dueText(t['dueAt'] as String?),
                            if (t['assigneeName'] != null) t['assigneeName'],
                          ].join(' · '),
                          style: const TextStyle(
                            fontSize: 13,
                            color: AppColors.muted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (t['overdue'] == true) Pill.red('Overdue'),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _visits() {
    final v = _data!['visits'] as Map<String, dynamic>?;
    if (v == null) return const SizedBox.shrink();
    final list = _maps(v['visits']);
    final canBook = v['canSchedule'] == true;
    if (list.isEmpty && !canBook) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionLabel('Site visits'),
        for (final s in list)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: AppCard(
              onTap: () => _openVisit(s),
              child: Row(
                children: [
                  const Icon(Icons.place_outlined, color: AppColors.muted),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          s['location'] as String? ?? '',
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                        if ((s['properties'] as List?)?.isNotEmpty == true)
                          Text(
                            '${(s['properties'] as List).length} ${(s['properties'] as List).length == 1 ? 'property' : 'properties'} to show',
                            style: const TextStyle(
                              fontSize: 13,
                              color: AppColors.teal,
                            ),
                          ),
                        Text(
                          '${dueText(s['scheduledFor'] as String?)} · ${visitStatusLabel(s['status'] as String?)}',
                          style: const TextStyle(
                            fontSize: 13,
                            color: AppColors.muted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (s['outcomeDue'] == true && s['canManage'] == true)
                    Pill.warn('Outcome due'),
                  const Icon(Icons.chevron_right, color: Color(0xFF98A2B3)),
                ],
              ),
            ),
          ),
        if (canBook)
          OutlinedButton.icon(
            onPressed: _bookVisit,
            icon: const Icon(Icons.add_location_alt_outlined),
            label: const Text('Book a visit'),
          ),
      ],
    );
  }

  Widget _historySection() {
    final rows = _history;
    if (rows == null) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionLabel('Recent history'),
        AppCard(
          padding: const EdgeInsets.fromLTRB(12, 14, 12, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (rows.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(bottom: 10),
                  child: Text(
                    'No history yet.',
                    style: TextStyle(color: AppColors.muted),
                  ),
                ),
              for (var i = 0; i < rows.length && i < 3; i++)
                HistoryTile(rows[i], last: i == 2 || i == rows.length - 1),
              if (rows.length > 3)
                TextButton.icon(
                  onPressed: _openHistory,
                  icon: const Icon(Icons.history),
                  label: Text('See full history (${rows.length})'),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _requirements() {
    final l = _lead;
    final bhk = [l['bhkMin'], l['bhkMax']].whereType<num>().toSet().join('–');
    final budgetMax = num.tryParse('${l['budgetMax'] ?? ''}');
    final budgetMin = num.tryParse('${l['budgetMin'] ?? ''}');
    final rows = <(String, String)>[
      if (l['transactionType'] != null)
        ('Looking to', label(const {}, l['transactionType'] as String)),
      if (l['propertyType'] != null)
        ('Property', label(const {}, l['propertyType'] as String)),
      if (bhk.isNotEmpty) ('Bedrooms', bhk),
      if (budgetMin != null || budgetMax != null)
        (
          'Budget',
          [
            aed(budgetMin),
            aed(budgetMax),
          ].where((s) => s.isNotEmpty).join(' – '),
        ),
      if (l['preferredCity'] != null) ('City', l['preferredCity'] as String),
      if ((l['preferredLocalities'] as List?)?.isNotEmpty == true)
        ('Areas', (l['preferredLocalities'] as List).join(', ')),
      if (l['timeline'] != null)
        ('Timeline', label(const {}, l['timeline'] as String)),
    ];
    if (rows.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionLabel('Requirements'),
        AppCard(
          child: Column(children: [for (final (k, v) in rows) _kv(k, v)]),
        ),
      ],
    );
  }

  Widget _scripts() {
    final scripts = ((_data!['scripts'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    if (scripts.isEmpty) return const SizedBox.shrink();
    final s = scripts.first;
    final c = s['content'] as Map<String, dynamic>? ?? const {};
    String text(String k) => ((c[k] as Map?)?['text'] as String?)?.trim() ?? '';
    final sections = [
      ('Opening', text('opening')),
      ('Questions', text('questions')),
      ('Pitch', text('pitch')),
      ('Closing', text('closing')),
    ].where((e) => e.$2.isNotEmpty);
    final objections = ((c['objections'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: AppCard(
        padding: EdgeInsets.zero,
        child: ExpansionTile(
          shape: const Border(),
          leading: const Icon(
            Icons.description_outlined,
            color: AppColors.teal,
          ),
          title: Text(
            'Script: ${s['name']}',
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          subtitle: const Text('Tap to read while you call'),
          childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          expandedCrossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final (k, v) in sections) ...[
              Text(
                k,
                style: const TextStyle(
                  fontWeight: FontWeight.w700,
                  color: AppColors.teal,
                ),
              ),
              const SizedBox(height: 4),
              Text(v),
              const SizedBox(height: 12),
            ],
            for (final o in objections) ...[
              Text(
                'If they say: ${o['objection']}',
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              Text(((o['response'] as Map?)?['text'] as String?) ?? ''),
              const SizedBox(height: 8),
            ],
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_data == null ? 'Lead' : _lead['fullName'] as String),
      ),
      body: _data == null
          ? (_error == null
                ? const Center(child: CircularProgressIndicator())
                : MessageView(message: _error!, onRetry: _load))
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
                children: [
                  _header(),
                  const SizedBox(height: 12),
                  _actions(),
                  _scripts(),
                  _followUps(),
                  _visits(),
                  _historySection(),
                  _requirements(),
                ],
              ),
            ),
    );
  }
}
