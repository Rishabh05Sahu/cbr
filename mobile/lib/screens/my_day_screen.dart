import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import 'lead_detail_screen.dart';
import 'notifications_screen.dart';
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

  Widget _task(Map<String, dynamic> t, {bool overdue = false}) {
    final lead = t['lead'] as Map<String, dynamic>?;
    final type = label(taskTypeLabels, t['type'] as String?);
    final title = (t['title'] as String?)?.trim();
    final heading = [
      if (title != null && title.isNotEmpty) title else type,
      if (lead != null) lead['fullName'] as String,
    ].join(' · ');
    // Own tasks with no lead, and (owner request 2026-11-23) own tasks on leads the caller may
    // change; the server re-checks the lead and the version either way.
    final canTick =
        t['attending'] != true &&
        ((t['canUpdate'] == true && t['onLead'] != true) ||
            t['canUpdateOnLead'] == true);
    final busy = _completing.contains(t['id']);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        onTap: lead != null ? () => _open(t) : null,
        child: Row(
          children: [
            if (canTick)
              SizedBox(
                width: 40,
                height: 40,
                child: busy
                    ? const Padding(
                        padding: EdgeInsets.all(10),
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : IconButton(
                        tooltip: 'Mark done',
                        icon: const Icon(
                          Icons.check_box_outline_blank,
                          color: Color(0xFF98A2B3),
                        ),
                        onPressed: () => _complete(t),
                      ),
              )
            else
              Padding(
                padding: const EdgeInsets.all(8),
                child: Icon(
                  t['type'] == 'MEETING'
                      ? Icons.groups_outlined
                      : Icons.phone_in_talk_outlined,
                  color: AppColors.muted,
                ),
              ),
            const SizedBox(width: 6),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    heading,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${dueText(t['dueAt'] as String?)} · $type',
                    style: const TextStyle(
                      fontSize: 13,
                      color: AppColors.muted,
                    ),
                  ),
                ],
              ),
            ),
            if (t['priority'] == 'URGENT')
              Pill.red('Urgent')
            else if (t['priority'] == 'HIGH')
              Pill.red('High')
            else if (lead?['intent'] == 'HOT')
              Pill.warn('Hot'),
            if (canTick && !busy)
              IconButton(
                tooltip: 'Reschedule',
                icon: const Icon(Icons.update, color: AppColors.muted),
                onPressed: () => _reschedule(t, overdue: overdue),
              ),
            if (lead != null)
              const Icon(Icons.chevron_right, color: Color(0xFF98A2B3)),
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
            if (empty)
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
