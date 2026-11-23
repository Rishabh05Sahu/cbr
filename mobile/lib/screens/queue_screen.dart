import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import 'assign_sheet.dart';
import 'lead_detail_screen.dart';

/// FR-072 unassigned queue: leads without an owner that the caller may assign (the whole org
/// for Owner/Admin, the teams they lead for a Sales Manager), oldest first. Tick leads, then
/// assign them to a person or share them out round-robin. The same list query as the website
/// (owner=none), so scope and paging are the server's.
class QueueScreen extends StatefulWidget {
  const QueueScreen({super.key, required this.session});
  final Session session;

  @override
  State<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends State<QueueScreen> {
  final _rows = <Map<String, dynamic>>[];
  final _selected = <String>{};
  String? _cursor;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _load(reset: true);
  }

  Future<void> _load({bool reset = false}) async {
    if (_loading) return;
    setState(() {
      _loading = true;
      if (reset) _error = null;
    });
    try {
      final d = await widget.session.api.get('/leads', {
        'owner': 'none',
        'sort': 'oldest',
        if (!reset && _cursor != null) 'cursor': _cursor!,
      }) as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        if (reset) {
          _rows.clear();
          _selected.clear();
        }
        _rows.addAll(
          ((d['rows'] as List?) ?? const []).cast<Map<String, dynamic>>(),
        );
        _cursor = d['nextCursor'] as String?;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _age(String? iso) {
    final t = DateTime.tryParse(iso ?? '');
    if (t == null) return '';
    final h = DateTime.now().difference(t).inHours;
    return h < 24 ? '$h h' : '${h ~/ 24} d';
  }

  Future<void> _assign() async {
    final ok = await showAssignSheet(
      context,
      api: widget.session.api,
      leadIds: _selected.toList(),
    );
    if (ok && mounted) {
      final n = _selected.length;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('$n ${n == 1 ? 'lead' : 'leads'} assigned')),
      );
      _load(reset: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final all = _rows.isNotEmpty && _selected.length == _rows.length;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Unassigned queue'),
        actions: [
          if (_rows.isNotEmpty)
            TextButton(
              onPressed: () => setState(() {
                if (all) {
                  _selected.clear();
                } else {
                  _selected.addAll(_rows.map((r) => r['id'] as String));
                }
              }),
              child: Text(all ? 'Clear' : 'Select all'),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => _load(reset: true),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 100),
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(
                  _error!,
                  style: const TextStyle(color: AppColors.red),
                ),
              ),
            if (_rows.isEmpty && !_loading && _error == null)
              const Padding(
                padding: EdgeInsets.only(top: 60),
                child: MessageView(
                  message: 'No unassigned leads. Every lead has an owner.',
                  icon: Icons.inbox_outlined,
                ),
              ),
            for (final r in _rows)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: AppCard(
                  padding: const EdgeInsets.fromLTRB(4, 8, 12, 8),
                  onTap: () => setState(() {
                    final id = r['id'] as String;
                    _selected.contains(id)
                        ? _selected.remove(id)
                        : _selected.add(id);
                  }),
                  child: Row(
                    children: [
                      Checkbox(
                        value: _selected.contains(r['id']),
                        onChanged: (v) => setState(() {
                          final id = r['id'] as String;
                          v == true ? _selected.add(id) : _selected.remove(id);
                        }),
                      ),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              r['fullName'] as String? ?? '',
                              style: const TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            Text(
                              [
                                if (r['teamName'] != null) r['teamName'],
                                if ((r['preferredCity'] as String?)
                                        ?.isNotEmpty ==
                                    true)
                                  r['preferredCity'],
                                'waiting ${_age(r['createdAt'] as String?)}',
                              ].join(' · '),
                              style: const TextStyle(
                                fontSize: 13,
                                color: AppColors.muted,
                              ),
                            ),
                          ],
                        ),
                      ),
                      Pill(label(stageLabels, r['stage'] as String?)),
                      IconButton(
                        tooltip: 'Open lead',
                        icon: const Icon(
                          Icons.chevron_right,
                          color: Color(0xFF98A2B3),
                        ),
                        onPressed: () async {
                          await Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder: (_) => LeadDetailScreen(
                                session: widget.session,
                                leadId: r['id'] as String,
                              ),
                            ),
                          );
                          _load(reset: true);
                        },
                      ),
                    ],
                  ),
                ),
              ),
            if (_loading)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_cursor != null)
              OutlinedButton(
                onPressed: () => _load(),
                child: const Text('Load more'),
              ),
          ],
        ),
      ),
      bottomNavigationBar: _selected.isEmpty
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: FilledButton.icon(
                  onPressed: _assign,
                  icon: const Icon(Icons.person_add_alt_1),
                  label: Text('Assign ${_selected.length} selected'),
                ),
              ),
            ),
    );
  }
}

/// The Team tab for Owner, Admin and Sales Manager: the unassigned queue, and the team
/// dashboard on the website until it is built in the app.
class TeamScreen extends StatelessWidget {
  const TeamScreen({
    super.key,
    required this.session,
    required this.openWebsite,
  });
  final Session session;
  final Future<void> Function(String path) openWebsite;

  @override
  Widget build(BuildContext context) {
    final me = session.me!;
    Widget tile(
      IconData icon,
      String title,
      String sub,
      VoidCallback onTap, {
      bool web = false,
    }) => Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        onTap: onTap,
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: AppColors.tealSoft,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Icon(icon, color: AppColors.teal),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    sub,
                    style: const TextStyle(
                      fontSize: 13,
                      color: AppColors.muted,
                    ),
                  ),
                ],
              ),
            ),
            Icon(
              web ? Icons.open_in_new : Icons.chevron_right,
              color: const Color(0xFF98A2B3),
            ),
          ],
        ),
      ),
    );
    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'Team',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (me.can('lead.assign'))
            tile(
              Icons.inbox_outlined,
              'Unassigned queue',
              me.scope('lead.assign') == 'ORG'
                  ? 'Leads without an owner, across the organisation'
                  : 'Leads without an owner in the teams you lead',
              () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => QueueScreen(session: session),
                ),
              ),
            ),
          if (me.can('report.read'))
            tile(
              Icons.bar_chart,
              'Team dashboard',
              'Calls, conversions and response times (website)',
              () => openWebsite('/app/dashboard'),
              web: true,
            ),
          if (me.can('user.read'))
            tile(
              Icons.groups_outlined,
              'People',
              'Members, roles and invitations (website)',
              () => openWebsite('/app/settings/members'),
              web: true,
            ),
        ],
      ),
    );
  }
}
