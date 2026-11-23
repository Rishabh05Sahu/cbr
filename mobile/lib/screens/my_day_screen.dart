import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import 'lead_detail_screen.dart';
import 'notifications_screen.dart';
import 'task_sheet.dart';
import 'when_picker.dart';

/// FR-101 My Day: overdue, today, the next 7 days and later (GET /api/v1/my-day).
class MyDayScreen extends StatefulWidget {
  const MyDayScreen({super.key, required this.session});
  final Session session;

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

  Widget _unloggedCard() {
    return AppCard(
      padding: const EdgeInsets.fromLTRB(14, 12, 8, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
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
                  ),
                ),
              ),
            ],
          ),
          for (final c in _unlogged)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text(
                c['leadName'] as String? ?? '',
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              subtitle: Text(
                '${c['channel'] == 'WHATSAPP_APP' ? 'WhatsApp' : 'Call'} at ${(c['occurredAt'] as String? ?? '').length >= 16 ? (c['occurredAt'] as String).substring(11, 16) : ''}',
              ),
              trailing: FilledButton.tonal(
                onPressed: () => _logUnlogged(c),
                child: const Text('Log'),
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
                padding: const EdgeInsets.only(left: 36),
                // Wraps under large text sizes instead of overflowing.
                child: Wrap(
                  children: [
                    TextButton.icon(
                      onPressed: busy ? null : () => _complete(t),
                      icon: busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
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
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
          children: [
            _outboxBanner(),
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
              '${longDate(DateTime.now())} · ${me.orgName}',
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
