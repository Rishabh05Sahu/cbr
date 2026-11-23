import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../session.dart';
import '../theme.dart';

const _periods = {
  'today': 'Today',
  'yesterday': 'Yesterday',
  'this_week': 'This week',
  'last_week': 'Last week',
  'this_month': 'This month',
  'last_month': 'Last month',
};

/// Dashboard (FR-130–133): the same figures as the website, in the caller's report scope — own
/// for executives, their teams for managers, the organisation for Owner and Admin.
class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key, required this.session});
  final Session session;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  String _period = 'this_week';
  String _team = '';
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
      final d = await widget.session.api.get('/dashboard', {
        'period': _period,
        if (_team.isNotEmpty) 'team': _team,
      }) as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _data = d;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  static String value(Map<String, dynamic> t) {
    if (t['unavailable'] != null) return '—';
    final r = t['ratio'] as Map<String, dynamic>?;
    if (r != null) {
      final den = (r['denominator'] as num?) ?? 0;
      if (den == 0) return '—';
      final pct = ((r['numerator'] as num) / den * 100).round();
      return '$pct%';
    }
    final h = t['medianAgeHours'] as num?;
    if (h != null) return '${h.round()} h';
    return '${t['count'] ?? '—'}';
  }

  Widget _tile(Map<String, dynamic> t) {
    final r = t['ratio'] as Map<String, dynamic>?;
    final low = r?['lowSample'] == true;
    return Tooltip(
      message:
          (t['unavailable'] as String?) ?? (t['description'] as String? ?? ''),
      triggerMode: TooltipTriggerMode.tap,
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.white,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              t['name'] as String? ?? '',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: AppColors.muted, fontSize: 12.5),
            ),
            Text(
              value(t),
              style: TextStyle(
                fontSize: 22,
                fontWeight: FontWeight.w700,
                color: low ? AppColors.muted : AppColors.text,
              ),
            ),
            if (r != null)
              Text(
                low
                    ? 'Low sample (${r['numerator']}/${r['denominator']})'
                    : '${r['numerator']} of ${r['denominator']}',
                style: const TextStyle(color: AppColors.muted, fontSize: 11.5),
              ),
          ],
        ),
      ),
    );
  }

  Widget _grid(List<Map<String, dynamic>> tiles) => GridView.count(
    crossAxisCount: 2,
    shrinkWrap: true,
    physics: const NeverScrollableScrollPhysics(),
    mainAxisSpacing: 10,
    crossAxisSpacing: 10,
    childAspectRatio: 1.55,
    children: [for (final t in tiles) _tile(t)],
  );

  @override
  Widget build(BuildContext context) {
    final d = _data;
    Widget body;
    if (d == null) {
      body = _error == null
          ? const Center(child: CircularProgressIndicator())
          : MessageView(message: _error!, onRetry: _load);
    } else {
      final kpis = (d['kpis'] as List).cast<Map<String, dynamic>>();
      final ops = (d['operational'] as List).cast<Map<String, dynamic>>();
      final stages = (d['stages'] as List).cast<Map<String, dynamic>>();
      final members = (d['members'] as List?)?.cast<Map<String, dynamic>>();
      final teams = ((d['options'] as Map?)?['teams'] as List? ?? const [])
          .cast<Map<String, dynamic>>();
      final scope = switch (d['scope']) {
        'OWN' => 'Your figures',
        'TEAM' => 'Your teams',
        _ => 'Whole organisation',
      };
      final countKpis = kpis.where((k) => k['ratio'] == null).take(3).toList();
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
          children: [
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final e in _periods.entries)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        label: Text(e.value),
                        selected: _period == e.key,
                        onSelected: _loading
                            ? null
                            : (_) {
                                setState(() => _period = e.key);
                                _load();
                              },
                      ),
                    ),
                ],
              ),
            ),
            if (teams.length > 1) ...[
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                initialValue: _team,
                decoration: const InputDecoration(labelText: 'Team'),
                items: [
                  const DropdownMenuItem(value: '', child: Text('All')),
                  for (final t in teams)
                    DropdownMenuItem(
                      value: t['id'] as String,
                      child: Text(t['name'] as String? ?? ''),
                    ),
                ],
                onChanged: (v) {
                  setState(() => _team = v ?? '');
                  _load();
                },
              ),
            ],
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                '$scope · tap a figure for what it means',
                style: const TextStyle(color: AppColors.muted, fontSize: 13),
              ),
            ),
            if (d['error'] != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  d['error'] as String,
                  style: const TextStyle(color: AppColors.red),
                ),
              ),
            const SectionLabel('Key figures'),
            _grid(kpis),
            if (ops.isNotEmpty) ...[
              const SectionLabel('Right now'),
              _grid(ops),
            ],
            if (stages.isNotEmpty) ...[
              const SectionLabel('Leads by stage'),
              AppCard(
                child: Column(
                  children: [
                    for (final s in stages)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 3),
                        child: Row(
                          children: [
                            Expanded(child: Text(s['label'] as String? ?? '')),
                            Text(
                              '${s['count']}',
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ],
            if (members != null && members.isNotEmpty) ...[
              const SectionLabel('By person'),
              for (final m in members)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: AppCard(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          m['name'] as String? ?? '',
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 4),
                        Wrap(
                          spacing: 12,
                          runSpacing: 4,
                          children: [
                            for (final k in countKpis)
                              Text(
                                '${k['name']}: ${(m['counts'] as Map?)?[k['id']] ?? 0}',
                                style: const TextStyle(
                                  color: AppColors.muted,
                                  fontSize: 13,
                                ),
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ],
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('Dashboard')),
      body: body,
    );
  }
}
