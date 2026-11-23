import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import 'lead_detail_screen.dart';
import 'notifications_screen.dart';
import 'visit_sheet.dart';

/// FR-150–152 Visits tab (GET /api/v1/visits): the same visits as the website's Visits page,
/// on the caller's leads and assigned to them. Open visits are split into outcome due (the time
/// has passed), today and upcoming, then recently closed. Tapping a visit opens its actions.
class VisitsScreen extends StatefulWidget {
  const VisitsScreen({super.key, required this.session});
  final Session session;

  @override
  State<VisitsScreen> createState() => _VisitsScreenState();
}

class _VisitsScreenState extends State<VisitsScreen> {
  Map<String, dynamic>? _data;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await widget.session.api.get('/visits') as Map<String, dynamic>;
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

  Future<void> _openSheet(Map<String, dynamic> v) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => VisitSheet(api: widget.session.api, visit: v),
    );
    if (saved == true) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Visit updated')));
      }
      _load();
    }
  }

  Future<void> _openLead(String id) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => LeadDetailScreen(session: widget.session, leadId: id),
      ),
    );
    _load();
  }

  Widget _visit(Map<String, dynamic> v, {bool due = false}) {
    final lead = v['lead'] as Map<String, dynamic>?;
    final name = lead?['fullName'] as String? ?? v['leadName'] as String? ?? '';
    final status = v['status'] as String?;
    final open =
        status == 'SCHEDULED' ||
        status == 'CONFIRMED' ||
        status == 'RESCHEDULED';
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        onTap: () => _openSheet(v),
        child: Row(
          children: [
            const Padding(
              padding: EdgeInsets.all(8),
              child: Icon(Icons.place_outlined, color: AppColors.muted),
            ),
            const SizedBox(width: 4),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${dueText(v['scheduledFor'] as String?)} · ${visitStatusLabel(status)}',
                    style: const TextStyle(
                      fontSize: 13,
                      color: AppColors.muted,
                    ),
                  ),
                  Text(
                    v['location'] as String? ?? '',
                    style: const TextStyle(fontSize: 13),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            if (due)
              Pill.warn('Outcome due')
            else if (!open && status == 'ATTENDED')
              Pill.teal('Attended')
            else if (!open)
              Pill(visitStatusLabel(status)),
            if (lead != null)
              IconButton(
                tooltip: 'Open lead',
                icon: const Icon(Icons.chevron_right, color: Color(0xFF98A2B3)),
                onPressed: () => _openLead(lead['id'] as String),
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
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
      final now = DateTime.now();
      final due = <Map<String, dynamic>>[];
      final today = <Map<String, dynamic>>[];
      final upcoming = <Map<String, dynamic>>[];
      for (final v in _list('open')) {
        final at = DateTime.tryParse(v['scheduledFor'] as String? ?? '');
        if (v['outcomeDue'] != true) {
          upcoming.add(v);
        } else if (at != null && !at.isAfter(now)) {
          due.add(v);
        } else {
          today.add(v);
        }
      }
      final closed = _list('closed');
      final empty =
          due.isEmpty && today.isEmpty && upcoming.isEmpty && closed.isEmpty;
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
          children: [
            if (empty)
              const Padding(
                padding: EdgeInsets.only(top: 80),
                child: MessageView(
                  message: 'No site visits yet. Schedule one from a lead on the website.',
                  icon: Icons.place_outlined,
                ),
              ),
            if (due.isNotEmpty) ...[
              SectionLabel(
                'Outcome due',
                countPill: Pill.warn('${due.length}'),
              ),
              for (final v in due) _visit(v, due: true),
            ],
            if (today.isNotEmpty) ...[
              SectionLabel('Today', count: today.length),
              for (final v in today) _visit(v),
            ],
            if (upcoming.isNotEmpty) ...[
              SectionLabel('Upcoming', count: upcoming.length),
              for (final v in upcoming) _visit(v),
            ],
            if (closed.isNotEmpty) ...[
              const SectionLabel('Recently closed'),
              for (final v in closed) _visit(v),
            ],
          ],
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('Site visits'),
        actions: [NotificationBell(session: widget.session)],
      ),
      body: body,
    );
  }
}
