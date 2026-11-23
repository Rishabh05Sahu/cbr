import 'package:intl/intl.dart';
import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../session.dart';
import '../theme.dart';
import 'auth_screens.dart';
import 'lead_detail_screen.dart';

final _leadLink = RegExp(r'^/app/leads/([0-9a-f-]{36})$');

/// "2m", "3h", "Yesterday", "12 Nov".
String ago(DateTime t, [DateTime? now]) {
  final n = now ?? DateTime.now();
  final d = n.difference(t);
  if (d.inMinutes < 1) return 'Just now';
  if (d.inMinutes < 60) return '${d.inMinutes}m';
  if (d.inHours < 24) return '${d.inHours}h';
  if (d.inDays < 2) return 'Yesterday';
  if (d.inDays < 7) return DateFormat('EEEE').format(t);
  return DateFormat('d MMM').format(t);
}

/// FR-118 notification centre: the caller's own notifications, newest first. Tapping one marks it
/// read and opens the lead in the app (other links open the same page on the website).
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key, required this.session});
  final Session session;

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  final List<Map<String, dynamic>> _rows = [];
  String? _cursor;
  String? _error;
  bool _loading = false;
  bool _loaded = false;

  ApiClient get _api => widget.session.api;

  @override
  void initState() {
    super.initState();
    _load(reset: true);
    // A badge change elsewhere (the minute poll) means new rows: reload the first page.
    widget.session.unread.addListener(_onUnread);
  }

  @override
  void dispose() {
    widget.session.unread.removeListener(_onUnread);
    super.dispose();
  }

  int _seenUnread = -1;
  void _onUnread() {
    final now = widget.session.unread.value;
    final localUnread = _rows.where((r) => r['readAt'] == null).length;
    if (now > localUnread && now != _seenUnread && !_loading) {
      _load(reset: true);
    }
  }

  Future<void> _load({bool reset = false}) async {
    if (_loading) return;
    setState(() => _loading = true);
    try {
      final d = await _api.get('/notifications', {
        if (!reset && _cursor != null) 'cursor': _cursor!,
      }) as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        if (reset) _rows.clear();
        _rows.addAll((d['rows'] as List).cast<Map<String, dynamic>>());
        _cursor = d['nextCursor'] as String?;
        _error = null;
        _loaded = true;
      });
      _setUnread((d['unread'] as num?)?.toInt() ?? 0);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _setUnread(int n) {
    _seenUnread = n;
    widget.session.unread.value = n;
  }

  Future<void> _markAll() async {
    try {
      await _api.post('/notifications/read-all');
      final now = DateTime.now().toUtc().toIso8601String();
      setState(() {
        for (final r in _rows) {
          r['readAt'] ??= now;
        }
      });
      _setUnread(0);
    } on ApiException catch (e) {
      _snack(e.message);
    }
  }

  Future<void> _open(Map<String, dynamic> n) async {
    if (n['readAt'] == null) {
      setState(() => n['readAt'] = DateTime.now().toUtc().toIso8601String());
      try {
        final d = await _api.post(
          '/notifications/${n['id']}/read',
        ) as Map<String, dynamic>;
        _setUnread((d['unread'] as num?)?.toInt() ?? 0);
      } on ApiException {
        // Marking read is best effort; the next load shows the true state.
      }
    }
    final link = n['link'] as String?;
    if (link == null || !mounted) return;
    final lead = _leadLink.firstMatch(link);
    if (lead != null) {
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              LeadDetailScreen(session: widget.session, leadId: lead.group(1)!),
        ),
      );
    } else if (link == '/app/my-day') {
      _snack('Open My Day to see this task.');
    } else {
      await openWebsite(link);
    }
  }

  void _snack(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  static IconData _icon(String type) => switch (type) {
    'LEAD_ASSIGNED' ||
    'LEADS_ASSIGNED_DIGEST' => Icons.person_add_alt_1_outlined,
    'LEADS_REASSIGNED_AWAY' => Icons.person_remove_outlined,
    'LEAD_RETURNING_ENQUIRY' => Icons.replay_outlined,
    'IMPORT_FINISHED' => Icons.upload_file_outlined,
    'VISIT_REMINDER' => Icons.place_outlined,
    'MEETING' || 'MEETING_INVITED' => Icons.event_outlined,
    'TASK_ASSIGNED' || 'TASK_REMINDER' => Icons.alarm_outlined,
    _ => Icons.notifications_none,
  };

  Widget _row(Map<String, dynamic> n) {
    final unread = n['readAt'] == null;
    final created = DateTime.tryParse(n['createdAt'] as String? ?? '');
    final body = (n['body'] as String?) ?? '';
    return InkWell(
      onTap: () => _open(n),
      child: Container(
        color: unread ? AppColors.tealSoft.withValues(alpha: 0.55) : null,
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(
              _icon(n['type'] as String? ?? ''),
              color: unread ? AppColors.teal : AppColors.muted,
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    n['title'] as String? ?? '',
                    style: TextStyle(
                      fontWeight: unread ? FontWeight.w700 : FontWeight.w500,
                      fontSize: 15,
                    ),
                  ),
                  if (body.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(body, style: const TextStyle(color: AppColors.muted)),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                if (created != null)
                  Text(
                    ago(created.toLocal()),
                    style: const TextStyle(
                      color: AppColors.muted,
                      fontSize: 12,
                    ),
                  ),
                if (unread)
                  Container(
                    margin: const EdgeInsets.only(top: 6),
                    width: 9,
                    height: 9,
                    decoration: const BoxDecoration(
                      color: AppColors.teal,
                      shape: BoxShape.circle,
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    Widget body;
    if (!_loaded && _error != null) {
      body = MessageView(message: _error!, onRetry: () => _load(reset: true));
    } else if (!_loaded) {
      body = const Center(child: CircularProgressIndicator());
    } else {
      body = RefreshIndicator(
        onRefresh: () => _load(reset: true),
        child: _rows.isEmpty
            ? ListView(
                children: const [
                  SizedBox(height: 120),
                  MessageView(
                    message: 'No notifications yet.',
                    icon: Icons.notifications_none,
                  ),
                ],
              )
            : ListView.separated(
                itemCount: _rows.length + (_cursor != null ? 1 : 0),
                separatorBuilder: (_, _) =>
                    const Divider(height: 1, color: AppColors.border),
                itemBuilder: (_, i) {
                  if (i < _rows.length) return _row(_rows[i]);
                  return Padding(
                    padding: const EdgeInsets.all(16),
                    child: OutlinedButton(
                      onPressed: _loading ? null : () => _load(),
                      child: const Text('Load more'),
                    ),
                  );
                },
              ),
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'Notifications',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
        ),
        actions: [
          ValueListenableBuilder<int>(
            valueListenable: widget.session.unread,
            builder: (_, n, _) => n == 0
                ? const SizedBox.shrink()
                : TextButton(
                    onPressed: _markAll,
                    child: const Text('Mark all read'),
                  ),
          ),
        ],
      ),
      body: Container(color: Colors.white, child: body),
    );
  }
}

/// The bell in the app bar of My Day and Leads, with the unread badge.
class NotificationBell extends StatelessWidget {
  const NotificationBell({super.key, required this.session});
  final Session session;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: session.unread,
      builder: (context, n, _) => IconButton(
        tooltip: n == 0 ? 'Notifications' : '$n unread notifications',
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => NotificationsScreen(session: session),
          ),
        ),
        icon: Badge(
          isLabelVisible: n > 0,
          label: Text(n > 99 ? '99+' : '$n'),
          backgroundColor: AppColors.red,
          child: const Icon(Icons.notifications_none),
        ),
      ),
    );
  }
}
