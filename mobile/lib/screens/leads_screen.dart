import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import 'lead_detail_screen.dart';
import 'queue_screen.dart';

/// FR-056 lead list in the caller's scope, with search, quick filters and "load more".
class LeadsScreen extends StatefulWidget {
  const LeadsScreen({super.key, required this.session});
  final Session session;

  @override
  State<LeadsScreen> createState() => _LeadsScreenState();
}

class _Filter {
  const _Filter(this.label, this.query);
  final String label;
  final Map<String, String> query;
}

const _filters = [
  _Filter('All', {}),
  _Filter('Due today', {'due': 'today'}),
  _Filter('Overdue', {'due': 'overdue'}),
  _Filter('Hot', {'intent': 'HOT'}),
  _Filter('New', {'stage': 'NEW'}),
];

class _LeadsScreenState extends State<LeadsScreen> {
  final _search = TextEditingController();
  final _rows = <Map<String, dynamic>>[];
  String? _cursor;
  String? _error;
  bool _loading = false;
  int _filter = 0;

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
    final q = <String, String>{
      ..._filters[_filter].query,
      if (_search.text.trim().isNotEmpty) 'q': _search.text.trim(),
      if (!reset && _cursor != null) 'cursor': _cursor!,
    };
    try {
      final d =
          await widget.session.api.get('/leads', q) as Map<String, dynamic>;
      final errors = d['errors'] as Map<String, dynamic>? ?? const {};
      if (!mounted) return;
      setState(() {
        if (reset) _rows.clear();
        _rows.addAll(
          ((d['rows'] as List?) ?? const []).cast<Map<String, dynamic>>(),
        );
        _cursor = d['nextCursor'] as String?;
        _error = errors.isEmpty
            ? null
            : errors.values.expand((v) => v is List ? v : [v]).join(' ');
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _open(String id) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => LeadDetailScreen(session: widget.session, leadId: id),
      ),
    );
    _load(reset: true);
  }

  Widget _row(Map<String, dynamic> r) {
    final me = widget.session.me!;
    final sub = [
      if ((r['preferredCity'] as String?)?.isNotEmpty == true)
        r['preferredCity'],
      // Executives only see their own leads; others see who owns each one.
      if (me.scope('lead.read') != 'OWN')
        (r['ownerName'] as String?) ?? 'Unassigned',
      r['primaryPhoneE164'],
    ].whereType<String>().join(' · ');
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AppCard(
        onTap: () => _open(r['id'] as String),
        child: Row(
          children: [
            CircleAvatar(
              radius: 20,
              backgroundColor: AppColors.tealSoft,
              child: Text(
                _initials(r['fullName'] as String? ?? ''),
                style: const TextStyle(
                  color: AppColors.teal,
                  fontWeight: FontWeight.w700,
                  fontSize: 14,
                ),
              ),
            ),
            const SizedBox(width: 12),
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
                  const SizedBox(height: 2),
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
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Pill(label(stageLabels, r['stage'] as String?)),
                if (r['intent'] == 'HOT') ...[
                  const SizedBox(height: 4),
                  Pill.warn('Hot'),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  static String _initials(String name) {
    final parts = name
        .trim()
        .split(RegExp(r'\s+'))
        .where((p) => p.isNotEmpty)
        .toList();
    if (parts.isEmpty) return '?';
    return (parts.first[0] + (parts.length > 1 ? parts.last[0] : ''))
        .toUpperCase();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'Leads',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
        ),
        actions: [
          if (widget.session.me!.can('lead.assign'))
            TextButton.icon(
              onPressed: () async {
                await Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => QueueScreen(session: widget.session),
                  ),
                );
                _load(reset: true);
              },
              icon: const Icon(Icons.inbox_outlined, size: 20),
              label: const Text('Unassigned'),
            ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(108),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Column(
              children: [
                TextField(
                  controller: _search,
                  textInputAction: TextInputAction.search,
                  onSubmitted: (_) => _load(reset: true),
                  decoration: InputDecoration(
                    hintText: 'Search name or phone',
                    prefixIcon: const Icon(Icons.search),
                    fillColor: AppColors.graySoft,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide.none,
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide.none,
                    ),
                    contentPadding: EdgeInsets.zero,
                    suffixIcon: _search.text.isEmpty
                        ? null
                        : IconButton(
                            tooltip: 'Clear search',
                            icon: const Icon(Icons.close),
                            onPressed: () {
                              _search.clear();
                              _load(reset: true);
                            },
                          ),
                  ),
                ),
                const SizedBox(height: 8),
                SizedBox(
                  height: 40,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: _filters.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 8),
                    itemBuilder: (_, i) => ChoiceChip(
                      label: Text(_filters[i].label),
                      selected: _filter == i,
                      onSelected: (_) {
                        setState(() => _filter = i);
                        _load(reset: true);
                      },
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
      body: RefreshIndicator(
        onRefresh: () => _load(reset: true),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
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
                  message: 'No leads match.',
                  icon: Icons.search_off,
                ),
              ),
            for (final r in _rows) _row(r),
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
    );
  }
}
