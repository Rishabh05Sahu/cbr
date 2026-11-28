import 'package:intl/intl.dart';
import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import 'lead_detail_screen.dart';
import 'lead_extras.dart';
import 'notifications_screen.dart';
import 'task_sheet.dart';
import 'when_picker.dart';

/// FR-101 My Day: overdue, today, the next 7 days and later (GET /api/v1/my-day).
class MyDayScreen extends StatefulWidget {
  const MyDayScreen({super.key, required this.session, this.clock});
  final Session session;

  /// The date in the header; screenshot tests fix it so the picture does not change daily.
  final DateTime Function()? clock;

  @override
  State<MyDayScreen> createState() => _MyDayScreenState();
}

class _MyDayScreenState extends State<MyDayScreen> {
  Map<String, dynamic>? _data;
  List<Map<String, dynamic>> _unlogged = const [];
  String? _error;
  bool _showLater = false;
  final Set<String> _completing = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await widget.session.api.get('/my-day') as Map<String, dynamic>;
      await _loadUnlogged();
      if (mounted) {
        setState(() {
          _data = d;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  /// Calls tapped today with no outcome logged (GET /api/v1/unlogged-calls).
  Future<void> _loadUnlogged() async {
    if (!widget.session.me!.can('interaction.create')) return;
    await widget.session.outbox.flush().catchError((_) => 0);
    try {
      final d = await widget.session.api.get(
        '/unlogged-calls',
      ) as Map<String, dynamic>;
      final queued = widget.session.outbox.pending;
      if (mounted) {
        setState(
          () => _unlogged = queued > 0
              ? const [] // Saved offline and not sent yet: they would show here wrongly.
              : ((d['rows'] as List?) ?? const []).cast<Map<String, dynamic>>(),
        );
      }
    } on ApiException {
      // Not worth an error on My Day.
    }
  }

  Future<void> _logUnlogged(Map<String, dynamic> c) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => LeadDetailScreen(
          session: widget.session,
          leadId: c['leadId'] as String,
          openLogOutcome: true,
        ),
      ),
    );
    await _load();
  }

  Future<void> _addTask() async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => AddTaskSheet(
        api: widget.session.api,
        nowLocal: formatLocal(DateTime.now()),
      ),
    );
    if (saved == true) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Task added')));
      }
      await _load();
    }
  }

  /// Overdue / Today / Next 7 days at a glance (owner request 2026-11-24: a cleaner My Day).
  Widget _summary(int overdue, int today, int upcoming) {
    Widget tile(String label, int n, {bool alert = false}) => Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
        decoration: BoxDecoration(
          color: alert && n > 0 ? AppColors.redSoft : AppColors.card,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: alert && n > 0 ? const Color(0xFFF3B8B3) : AppColors.border,
          ),
        ),
        child: Column(
          children: [
            Text(
              '$n',
              style: TextStyle(
                fontSize: 22,
                fontWeight: FontWeight.w700,
                color: alert && n > 0 ? AppColors.red : AppColors.text,
              ),
            ),
            Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12,
                color: alert && n > 0 ? AppColors.red : AppColors.muted,
              ),
            ),
          ],
        ),
      ),
    );
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 12),
      child: Row(
        children: [
          tile('Overdue', overdue, alert: true),
          const SizedBox(width: 8),
          tile('Today', today),
          const SizedBox(width: 8),
          tile('Next 7 days', upcoming),
        ],
      ),
    );
  }

  /// "Today 11:33 pm" from the call's org-local time ("2026-11-23T23:33").
  String _callTime(String? local) {
    if (local == null || local.length < 16) return '';
    final t = parseLocal(local);
    final now = DateTime.now();
    final days = DateTime(
      now.year,
      now.month,
      now.day,
    ).difference(DateTime(t.year, t.month, t.day)).inDays;
    final clock = DateFormat('h:mm a').format(t).toLowerCase();
    if (days == 0) return 'Today $clock';
    if (days == 1) return 'Yesterday $clock';
    return '${DateFormat('EEE d MMM').format(t)}, $clock';
  }

  /// Calls tapped but not logged yet. Each row gives the name its own full width; the Log
  /// button has a fixed size (the theme's FilledButton is full-width, which squeezed the name into
  /// one letter per line inside a ListTile on phones: owner report 2026-11-24).
  Widget _unloggedCard() {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: AppColors.warnSoft,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFF4C7A1)),
      ),
      padding: const EdgeInsets.fromLTRB(14, 12, 12, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Icon(Icons.warning_amber_rounded, color: AppColors.warn),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _unlogged.length == 1
                      ? '1 call with no outcome'
                      : '${_unlogged.length} calls with no outcome',
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 15,
                    color: AppColors.warn,
                  ),
                ),
              ),
            ],
          ),
          const Padding(
            padding: EdgeInsets.only(top: 2, left: 32, bottom: 4),
            child: Text(
              'Log what happened so your follow-ups stay right.',
              style: TextStyle(fontSize: 13, color: AppColors.gray),
            ),
          ),
          for (final c in _unlogged)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                children: [
                  Container(
                    width: 36,
                    height: 36,
                    decoration: const BoxDecoration(
                      color: Colors.white,
                      shape: BoxShape.circle,
                    ),
                    child: Icon(
                      c['channel'] == 'WHATSAPP_APP'
                          ? Icons.chat_outlined
                          : Icons.call_outlined,
                      size: 18,
                      color: AppColors.warn,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          c['leadName'] as String? ?? '',
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 15,
                            color: AppColors.text,
                          ),
                        ),
                        Text(
                          '${c['channel'] == 'WHATSAPP_APP' ? 'WhatsApp' : 'Phone call'} · ${_callTime(c['occurredAt'] as String?)}',
                          style: const TextStyle(
                            fontSize: 13,
                            color: AppColors.muted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(72, 40),
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      textStyle: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    onPressed: () => _logUnlogged(c),
                    child: const Text('Log'),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _outboxBanner() {
    final o = widget.session.outbox;
    return ListenableBuilder(
      listenable: o,
      builder: (context, _) {
        final lines = <String>[
          if (o.pending > 0)
            o.pending == 1
                ? '1 outcome saved on this phone, waiting for signal.'
                : '${o.pending} outcomes saved on this phone, waiting for signal.',
          if (o.failed.isNotEmpty)
            'Could not save the outcome for ${o.failed.join(', ')}. Please log it again.',
        ];
        if (lines.isEmpty) return const SizedBox.shrink();
        return Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Material(
            color: o.failed.isNotEmpty ? AppColors.redSoft : AppColors.warnSoft,
            borderRadius: BorderRadius.circular(12),
            child: ListTile(
              leading: Icon(
                o.failed.isNotEmpty
                    ? Icons.error_outline
                    : Icons.cloud_upload_outlined,
              ),
              title: Text(
                lines.join('\n'),
                style: const TextStyle(fontSize: 13),
              ),
              trailing: o.failed.isNotEmpty
                  ? IconButton(
                      icon: const Icon(Icons.close),
                      onPressed: () => setState(o.failed.clear),
                    )
                  : TextButton(
                      onPressed: () async {
                        await o.flush();
                        await _load();
                      },
                      child: const Text('Send now'),
                    ),
            ),
          ),
        );
      },
    );
  }

  List<Map<String, dynamic>> _list(String key) =>
      ((_data?[key] as List?) ?? const []).cast<Map<String, dynamic>>();

  Future<void> _complete(Map<String, dynamic> t) async {
    final id = t['id'] as String;
    setState(() => _completing.add(id));
    try {
      await widget.session.api.post('/tasks/$id/complete', {
        'version': t['version'],
      });
      await _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _completing.remove(id));
    }
  }

  /// FR-102 from My Day (POST /api/v1/tasks/:id/reschedule): a new org-local time, and a reason
  /// when the server says one is needed (overdue, or moved more than twice).
  Future<void> _reschedule(
    Map<String, dynamic> t, {
    required bool overdue,
  }) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => _RescheduleSheet(
        api: widget.session.api,
        task: t,
        needsReason: overdue || t['rescheduleNeedsReason'] == true,
      ),
    );
    if (saved == true) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Rescheduled')));
      }
      _load();
    }
  }

  /// One-tap call from a card; back in the app, My Day reloads so the call shows under calls
  /// with no outcome, ready to log.
  bool _calling = false;
  late final AppLifecycleListener _lifecycle = AppLifecycleListener(
    onResume: () {
      if (_calling) {
        _calling = false;
        _load();
      }
    },
  );

  Future<void> _call(String leadId) async {
    _lifecycle; // start listening before the dialer opens
    _calling = true;
    await quickCall(context, widget.session.api, leadId);
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  Future<void> _open(Map<String, dynamic> t) async {
    final lead = t['lead'] as Map<String, dynamic>?;
    if (lead == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => LeadDetailScreen(
          session: widget.session,
          leadId: lead['id'] as String,
        ),
      ),
    );
    _load();
  }

  /// One task card. The lead's name and what to do get the full width (never squeezed beside
  /// buttons); time and tags sit under them, and Done / Reschedule get their own row.
  Widget _task(Map<String, dynamic> t, {bool overdue = false}) {
    final lead = t['lead'] as Map<String, dynamic>?;
    final typeCode = t['type'] as String?;
    final type = label(taskTypeLabels, typeCode);
    final title = (t['title'] as String?)?.trim();
    final hasTitle = title != null && title.isNotEmpty;
    final name = lead?['fullName'] as String?;
    // Own tasks with no lead, and (owner request 2026-11-23) own tasks on leads the caller may
    // change; the server re-checks the lead and the version either way.
    final canTick =
        t['attending'] != true &&
        ((t['canUpdate'] == true && t['onLead'] != true) ||
            t['canUpdateOnLead'] == true);
    final busy = _completing.contains(t['id']);
    final icon = switch (typeCode) {
      'MEETING' => Icons.groups_outlined,
      'DOCUMENT' => Icons.description_outlined,
      'CALL' => Icons.call_outlined,
      'OTHER' => Icons.task_alt,
      _ => Icons.phone_in_talk_outlined,
    };
    final tags = <Widget>[
      if (t['priority'] == 'URGENT') Pill.red('Urgent'),
      if (t['priority'] == 'HIGH') Pill.red('High'),
      if (lead?['intent'] == 'HOT') Pill.warn('Hot'),
      if (t['attending'] == true) Pill('Invited'),
    ];
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        onTap: lead != null ? () => _open(t) : null,
        padding: const EdgeInsets.fromLTRB(14, 12, 8, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: overdue ? AppColors.redSoft : AppColors.tealSoft,
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    icon,
                    size: 20,
                    color: overdue ? AppColors.red : AppColors.teal,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name ?? (hasTitle ? title : type),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          color: AppColors.text,
                        ),
                      ),
                      if (name != null || hasTitle) ...[
                        const SizedBox(height: 2),
                        Text(
                          name != null && hasTitle ? '$type · $title' : type,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 14,
                            color: AppColors.muted,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                if (lead != null)
                  const Padding(
                    padding: EdgeInsets.only(top: 6),
                    child: Icon(Icons.chevron_right, color: Color(0xFF98A2B3)),
                  ),
              ],
            ),
            const SizedBox(height: 10),
            Padding(
              padding: const EdgeInsets.only(left: 48),
              child: Wrap(
                spacing: 8,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        Icons.schedule,
                        size: 16,
                        color: overdue ? AppColors.red : AppColors.muted,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        dueText(t['dueAt'] as String?),
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: overdue ? FontWeight.w600 : null,
                          color: overdue ? AppColors.red : AppColors.muted,
                        ),
                      ),
                    ],
                  ),
                  ...tags,
                ],
              ),
            ),
            if (canTick) ...[
              const SizedBox(height: 6),
              const Divider(height: 1, color: AppColors.border),
              Padding(
                padding: const EdgeInsets.only(left: 30),
                // Wraps under large text sizes instead of overflowing. Compact buttons so Call,
                // Done and Reschedule fit one line at 360 dp.
                child: TextButtonTheme(
                  data: TextButtonThemeData(
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      visualDensity: VisualDensity.compact,
                    ),
                  ),
                  child: Wrap(
                    children: [
                      if (lead != null)
                        TextButton.icon(
                          onPressed: () => _call(lead['id'] as String),
                          icon: const Icon(Icons.call_outlined, size: 20),
                          label: const Text('Call'),
                        ),
                      TextButton.icon(
                        onPressed: busy ? null : () => _complete(t),
                        icon: busy
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.check_circle_outline, size: 20),
                        label: const Text('Done'),
                      ),
                      TextButton.icon(
                        onPressed: busy
                            ? null
                            : () => _reschedule(t, overdue: overdue),
                        icon: const Icon(Icons.update, size: 20),
                        label: const Text('Reschedule'),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final me = widget.session.me!;
    Widget body;
    if (_data == null && _error == null) {
      body = const Center(child: CircularProgressIndicator());
    } else if (_data == null) {
      body = MessageView(
        message: _error!,
        onRetry: _load,
        icon: Icons.cloud_off,
      );
    } else {
      final overdue = _list('overdue');
      final today = _list('today');
      final upcoming = _list('upcoming');
      final later = _list('later');
      final empty =
          overdue.isEmpty && today.isEmpty && upcoming.isEmpty && later.isEmpty;
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          // Room at the bottom so the + Task button never covers the last card.
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 96),
          children: [
            _outboxBanner(),
            if (!empty) _summary(overdue.length, today.length, upcoming.length),
            if (_unlogged.isNotEmpty) _unloggedCard(),
            if (empty && _unlogged.isEmpty)
              const Padding(
                padding: EdgeInsets.only(top: 80),
                child: MessageView(
                  message: 'Nothing due. Enjoy the clear day.',
                  icon: Icons.task_alt,
                ),
              ),
            if (overdue.isNotEmpty) ...[
              SectionLabel('Overdue', countPill: Pill.red('${overdue.length}')),
              for (final t in overdue) _task(t, overdue: true),
            ],
            if (today.isNotEmpty) ...[
              SectionLabel('Today', count: today.length),
              for (final t in today) _task(t),
            ],
            if (upcoming.isNotEmpty) ...[
              SectionLabel('Next 7 days', count: upcoming.length),
              for (final t in upcoming) _task(t),
            ],
            if (later.isNotEmpty) ...[
              if (_showLater) ...[
                SectionLabel('Later', count: later.length),
                for (final t in later) _task(t),
              ] else
                TextButton(
                  onPressed: () => setState(() => _showLater = true),
                  child: Text('Show ${later.length} later'),
                ),
            ],
            if (_data?['truncated'] == true)
              const Text(
                'Showing the earliest tasks only. See all on the website.',
                style: TextStyle(color: AppColors.muted, fontSize: 13),
              ),
          ],
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 68,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'My Day',
              style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
            ),
            Text(
              '${longDate((widget.clock ?? DateTime.now)())} · ${me.orgName}',
              style: const TextStyle(
                fontSize: 13,
                color: AppColors.muted,
                fontWeight: FontWeight.w400,
              ),
            ),
          ],
        ),
        actions: [NotificationBell(session: widget.session)],
      ),
      body: body,
      floatingActionButton: me.can('task.create')
          ? FloatingActionButton.extended(
              heroTag: 'my-day-add',
              onPressed: _addTask,
              icon: const Icon(Icons.add_task),
              label: const Text('Task'),
            )
          : null,
    );
  }
}

class _RescheduleSheet extends StatefulWidget {
  const _RescheduleSheet({
    required this.api,
    required this.task,
    required this.needsReason,
  });

  final ApiClient api;
  final Map<String, dynamic> task;
  final bool needsReason;

  @override
  State<_RescheduleSheet> createState() => _RescheduleSheetState();
}

class _RescheduleSheetState extends State<_RescheduleSheet> {
  late String _when;
  final _reason = TextEditingController();
  bool _saving = false;
  List<String> _errors = const [];

  @override
  void initState() {
    super.initState();
    final local = widget.task['dueAtLocal'] as String?;
    // Start one day later than the current time, the usual move.
    final d = local != null ? parseLocal(local) : DateTime.now();
    _when = formatLocal(DateTime(d.year, d.month, d.day + 1, d.hour, d.minute));
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _errors = const [];
    });
    try {
      await widget.api.post('/tasks/${widget.task['id']}/reschedule', {
        'dueAt': _when,
        'reason': _reason.text.trim(),
        'version': widget.task['version'],
      });
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _errors = e.allMessages);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.task;
    final lead = t['lead'] as Map<String, dynamic>?;
    final type = label(taskTypeLabels, t['type'] as String?);
    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          Text(
            'Reschedule $type${lead != null ? ' · ${lead['fullName']}' : ''}',
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 6),
          Text(
            'Now due ${dueText(t['dueAt'] as String?)}',
            style: const TextStyle(color: AppColors.muted),
          ),
          const SizedBox(height: 16),
          WhenPicker(
            label: 'New date and time',
            value: _when,
            onChanged: (s) => setState(() => _when = s),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _reason,
            decoration: InputDecoration(
              labelText: widget.needsReason ? 'Reason' : 'Reason (optional)',
            ),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_saving ? 'Saving…' : 'Save new time'),
          ),
          if (_errors.isNotEmpty) ...[
            const SizedBox(height: 12),
            for (final e in _errors)
              Text(e, style: const TextStyle(color: AppColors.red)),
          ],
        ],
      ),
    );
  }
}
