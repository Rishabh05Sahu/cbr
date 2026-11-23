import 'package:intl/intl.dart';
import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import 'lead_detail_screen.dart';

/// Calendar (FR-105): the caller's own open tasks, follow-ups and meetings by day, a week at a
/// time (GET /api/v1/calendar?view=week&date=). Same items as the website's calendar.
class CalendarScreen extends StatefulWidget {
  const CalendarScreen({super.key, required this.session});
  final Session session;

  @override
  State<CalendarScreen> createState() => _CalendarScreenState();
}

class _CalendarScreenState extends State<CalendarScreen> {
  String? _date;
  Map<String, dynamic>? _data;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final d = await widget.session.api.get('/calendar', {
        'view': 'week',
        'date': ?_date,
      }) as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _data = d;
          _date = (d['period'] as Map)['date'] as String;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _shift(int days) {
    final d = DateTime.parse(_date!);
    _date = DateFormat('yyyy-MM-dd')
        .format(DateTime(d.year, d.month, d.day + days));
    _load();
  }

  String _dayTitle(String key, String today) {
    final d = DateTime.parse(key);
    final name = DateFormat('EEEE d MMM').format(d);
    return key == today ? 'Today · $name' : name;
  }

  Widget _item(Map<String, dynamic> t) {
    final lead = t['lead'] as Map<String, dynamic>?;
    final due = DateTime.tryParse(t['dueAt'] as String? ?? '')?.toLocal();
    final title = (t['title'] as String?)?.isNotEmpty == true
        ? t['title'] as String
        : lead != null
        ? 'Follow up ${lead['fullName']}'
        : label(taskTypeLabels, t['type'] as String?);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: AppCard(
        onTap: lead == null
            ? null
            : () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => LeadDetailScreen(
                    session: widget.session,
                    leadId: lead['id'] as String,
                  ),
                ),
              ),
        child: Row(
          children: [
            SizedBox(
              width: 52,
              child: Text(
                due == null ? '' : DateFormat('HH:mm').format(due),
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  Text(
                    [
                      label(taskTypeLabels, t['type'] as String?),
                      if (lead != null && t['title'] != null) lead['fullName'],
                    ].whereType<String>().join(' · '),
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 13,
                    ),
                  ),
                ],
              ),
            ),
            if (t['overlaps'] == true) Pill.warn('Overlap'),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final d = _data;
    Widget body;
    if (d == null) {
      body = _error == null
          ? const Center(child: CircularProgressIndicator())
          : MessageView(message: _error!, onRetry: _load);
    } else {
      final period = d['period'] as Map<String, dynamic>;
      final days = (period['days'] as List).cast<String>();
      final byDay = (d['byDay'] as Map).cast<String, dynamic>();
      final today = d['today'] as String;
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
          children: [
            Row(
              children: [
                IconButton(
                  tooltip: 'Previous week',
                  onPressed: _loading ? null : () => _shift(-7),
                  icon: const Icon(Icons.chevron_left),
                ),
                Expanded(
                  child: Text(
                    '${DateFormat('d MMM').format(DateTime.parse(days.first))} – ${DateFormat('d MMM').format(DateTime.parse(days.last))}',
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                IconButton(
                  tooltip: 'Next week',
                  onPressed: _loading ? null : () => _shift(7),
                  icon: const Icon(Icons.chevron_right),
                ),
              ],
            ),
            if (!days.contains(today))
              Center(
                child: TextButton(
                  onPressed: () {
                    _date = null;
                    _load();
                  },
                  child: const Text('Back to this week'),
                ),
              ),
            for (final key in days)
              if (byDay[key] != null && (byDay[key] as List).isNotEmpty) ...[
                SectionLabel(
                  _dayTitle(key, today),
                  count: (byDay[key] as List).length,
                ),
                for (final t
                    in (byDay[key] as List).cast<Map<String, dynamic>>())
                  _item(t),
              ],
            if (byDay.values.every((v) => (v as List).isEmpty))
              const Padding(
                padding: EdgeInsets.only(top: 60),
                child: MessageView(
                  message: 'Nothing planned this week.',
                  icon: Icons.event_available,
                ),
              ),
            if (d['truncated'] == true)
              const Text(
                'A busy week: only the earliest items are shown.',
                style: TextStyle(color: AppColors.muted, fontSize: 13),
              ),
          ],
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'Calendar',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
        ),
      ),
      body: body,
    );
  }
}
