import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../session.dart';
import '../theme.dart';

/// Report periods offered by GET /api/v1/dashboard (src/modules/reporting/periods.ts).
const _periods = {
  'today': 'Today',
  'yesterday': 'Yesterday',
  'this_week': 'This week',
  'last_week': 'Last week',
  'this_month': 'This month',
  'last_month': 'Last month',
};

/// Short names and plain descriptions for the per-person figures (the full definitions are in
/// src/modules/reporting/definitions.ts).
const _metrics = <String, (String, String)>{
  'k05-phone': (
    'Calls logged',
    'Phone calls (outbound and inbound) the person logged in the period.',
  ),
  'k05-whatsapp': (
    'WhatsApp logged',
    'WhatsApp calls and messages the person logged in the period.',
  ),
  'k04': (
    'Call taps',
    "Taps on a lead's Call button. A tap opens the dialer; it is not a call.",
  ),
  'k04-whatsapp': (
    'WhatsApp taps',
    "Taps on a lead's WhatsApp button. A tap opens the chat; it is not a message.",
  ),
  'k07': (
    'Connected',
    'Logged interactions where the customer was reached (self-reported).',
  ),
  'k02': ('Leads assigned', 'Leads assigned to the person in the period.'),
  'k11': (
    'Visits scheduled',
    'Site visits the person scheduled in the period.',
  ),
  'k12': (
    'Visits completed',
    'Site visits attended in the period, credited to the salesperson.',
  ),
  'k18': ('Follow-ups due', 'Follow-ups due in the period, open or completed.'),
  'k08b': (
    'Outcome logging rate',
    'Call and WhatsApp taps followed by a logged outcome on that lead within 2 hours.',
  ),
  'k19b': (
    'Follow-up timeliness',
    'Follow-ups due in the period that were completed within 1 hour of the due time.',
  ),
  'k20': (
    'Task completion rate',
    'Tasks due in the period that are done (tasks no longer relevant are left out).',
  ),
  'k13': (
    'Lead-to-visit conversion',
    'Leads with a completed site visit within the cohort window of entering.',
  ),
};

const _countOrder = [
  'k05-phone',
  'k05-whatsapp',
  'k04',
  'k04-whatsapp',
  'k07',
  'k02',
  'k11',
  'k12',
  'k18',
];
const _ratioOrder = ['k08b', 'k19b', 'k20', 'k13'];

enum TeamSort { calls, visits, timeliness }

/// One person's row from the dashboard's `members` table.
class MemberStats {
  MemberStats(this.raw);
  final Map<String, dynamic> raw;

  String get id => raw['userId'] as String? ?? '';
  String get name => raw['name'] as String? ?? '';
  int count(String id) => ((raw['counts'] as Map?)?[id] as num?)?.toInt() ?? 0;
  Map<String, dynamic>? ratio(String id) =>
      (raw['ratios'] as Map?)?[id] as Map<String, dynamic>?;

  /// Ratio as 0–1, or null when there is nothing to divide by.
  double? rate(String id) {
    final r = ratio(id);
    final den = (r?['denominator'] as num?) ?? 0;
    if (r == null || den == 0) return null;
    return ((r['numerator'] as num?) ?? 0) / den;
  }

  int get callsLogged => count('k05-phone');

  /// The member's role from the server (OWNER, ADMIN, SALES_MANAGER, SALES_EXECUTIVE), if sent.
  String? get role => raw['role'] as String?;

  /// Only salespeople are flagged for logging no calls: Owners, Admins and managers usually do
  /// not call. An unknown role (older server) is treated as a salesperson.
  bool get idle =>
      callsLogged == 0 &&
      !const {'OWNER', 'ADMIN', 'SALES_MANAGER'}.contains(role);
}

/// Orders people for the chosen sort (largest first; ties and missing rates by name).
List<MemberStats> sortMembers(List<MemberStats> list, TeamSort sort) {
  int byName(MemberStats a, MemberStats b) =>
      a.name.toLowerCase().compareTo(b.name.toLowerCase());
  final out = [...list];
  out.sort((a, b) {
    final c = switch (sort) {
      TeamSort.calls => b.callsLogged.compareTo(a.callsLogged),
      TeamSort.visits =>
        b.count('k12') != a.count('k12')
            ? b.count('k12').compareTo(a.count('k12'))
            : b.count('k11').compareTo(a.count('k11')),
      TeamSort.timeliness => switch ((a.rate('k19b'), b.rate('k19b'))) {
        (null, null) => 0,
        (null, _) => 1,
        (_, null) => -1,
        (final x?, final y?) => y.compareTo(x),
      },
    };
    return c != 0 ? c : byName(a, b);
  });
  return out;
}

/// Team performance for Owners, Admins (organisation) and managers (their teams): per-person
/// activity from GET /api/v1/dashboard, with people who logged no calls highlighted.
class TeamPerformanceScreen extends StatefulWidget {
  const TeamPerformanceScreen({super.key, required this.session});
  final Session session;

  @override
  State<TeamPerformanceScreen> createState() => _TeamPerformanceScreenState();
}

class _TeamPerformanceScreenState extends State<TeamPerformanceScreen> {
  String _period = 'this_week';
  String _team = '';
  TeamSort _sort = TeamSort.calls;
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

  void _openPerson(MemberStats m) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      backgroundColor: Colors.white,
      builder: (context) => _PersonSheet(member: m),
    );
  }

  Widget _filters(List<Map<String, dynamic>> teams) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
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
        const SizedBox(height: 10),
        DropdownButtonFormField<String>(
          initialValue: _team,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Team'),
          items: [
            const DropdownMenuItem(value: '', child: Text('All teams')),
            for (final t in teams)
              DropdownMenuItem(
                value: t['id'] as String,
                child: Text(
                  t['name'] as String? ?? '',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
          ],
          onChanged: _loading
              ? null
              : (v) {
                  setState(() => _team = v ?? '');
                  _load();
                },
        ),
      ],
    ],
  );

  Widget _sortChips() => Wrap(
    spacing: 6,
    runSpacing: 6,
    crossAxisAlignment: WrapCrossAlignment.center,
    children: [
      const Tooltip(
        message: 'Sort by',
        child: Icon(Icons.sort, size: 20, color: AppColors.muted),
      ),
      for (final (s, label) in const [
        (TeamSort.calls, 'Calls'),
        (TeamSort.visits, 'Visits'),
        (TeamSort.timeliness, 'On time'),
      ])
        ChoiceChip(
          label: Text(label),
          selected: _sort == s,
          visualDensity: VisualDensity.compact,
          onSelected: (_) => setState(() => _sort = s),
        ),
    ],
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
      final rawMembers = (d['members'] as List?)?.cast<Map<String, dynamic>>();
      final teams = ((d['options'] as Map?)?['teams'] as List? ?? const [])
          .cast<Map<String, dynamic>>();
      final scope = switch (d['scope']) {
        'TEAM' => 'Your teams',
        'ORG' => 'Whole organisation',
        _ => 'Your figures',
      };
      final members = sortMembers([
        for (final m in rawMembers ?? const <Map<String, dynamic>>[])
          MemberStats(m),
      ], _sort);
      final idle = members.where((m) => m.idle).length;
      int sum(String id) => members.fold(0, (a, m) => a + m.count(id));

      final children = <Widget>[
        _filters(teams),
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text(
            '$scope · ${_periods[_period] ?? ''}',
            style: const TextStyle(color: AppColors.muted, fontSize: 13),
          ),
        ),
        if (_error != null || d['error'] != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              (_error ?? d['error']) as String,
              style: const TextStyle(color: AppColors.red),
            ),
          ),
      ];
      if (rawMembers == null) {
        children.add(
          const Padding(
            padding: EdgeInsets.only(top: 48),
            child: MessageView(
              icon: Icons.lock_outline,
              message: 'Team figures are for managers and owners.',
            ),
          ),
        );
      } else if (members.isEmpty) {
        children.add(
          const Padding(
            padding: EdgeInsets.only(top: 48),
            child: MessageView(
              icon: Icons.groups_outlined,
              message: 'No one in this team yet.',
            ),
          ),
        );
      } else {
        children.addAll([
          const SectionLabel('Team totals'),
          AppCard(
            child: _StatGrid(
              columns: 3,
              stats: [
                ('${sum('k05-phone')}', 'Calls logged'),
                ('${sum('k05-whatsapp')}', 'WhatsApp'),
                ('${sum('k07')}', 'Connected'),
                ('${sum('k12')}', 'Visits done'),
                ('${sum('k18')}', 'Follow-ups due'),
              ],
            ),
          ),
          SectionLabel(
            'People',
            count: members.length,
            countPill: idle > 0 ? Pill.warn('$idle with no calls') : null,
          ),
          _sortChips(),
          const SizedBox(height: 10),
          for (final m in members)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: _PersonCard(member: m, onTap: () => _openPerson(m)),
            ),
        ]);
      }
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          children: children,
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: const Text('Team performance'),
        bottom: _loading && d != null
            ? const PreferredSize(
                preferredSize: Size.fromHeight(2),
                child: LinearProgressIndicator(minHeight: 2),
              )
            : null,
      ),
      body: body,
    );
  }
}

/// Numbers over labels, [columns] to a row. Labels wrap rather than squeeze.
class _StatGrid extends StatelessWidget {
  const _StatGrid({required this.stats, this.columns = 3});
  final List<(String, String)> stats;
  final int columns;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, c) {
        const gap = 8.0;
        final w = (c.maxWidth - gap * (columns - 1)) / columns;
        return Wrap(
          spacing: gap,
          runSpacing: 10,
          children: [
            for (final (value, label) in stats)
              SizedBox(
                width: w,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      value,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w700,
                        color: AppColors.text,
                        height: 1.2,
                      ),
                    ),
                    Text(
                      label,
                      style: const TextStyle(
                        fontSize: 12.5,
                        color: AppColors.muted,
                        height: 1.25,
                      ),
                    ),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }
}

/// A percentage bar with "n of d", greyed with a "Low sample" pill when the server marks it.
class _RatioBar extends StatelessWidget {
  const _RatioBar({required this.label, required this.ratio});
  final String label;
  final Map<String, dynamic>? ratio;

  @override
  Widget build(BuildContext context) {
    final n = (ratio?['numerator'] as num?) ?? 0;
    final den = (ratio?['denominator'] as num?) ?? 0;
    final empty = den == 0;
    final low = !empty && ratio?['lowSample'] == true;
    final value = empty ? 0.0 : (n / den).clamp(0.0, 1.0).toDouble();
    final color = empty || low ? const Color(0xFF98A2B3) : AppColors.teal;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 2,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              label,
              style: const TextStyle(fontSize: 13, color: AppColors.gray),
            ),
            Text(
              empty ? '—' : '${(value * 100).round()}%',
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: low ? AppColors.muted : AppColors.text,
              ),
            ),
            Text(
              empty ? 'No data' : '$n of $den',
              style: const TextStyle(fontSize: 12, color: AppColors.muted),
            ),
            if (low) const Pill('Low sample'),
          ],
        ),
        const SizedBox(height: 5),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: value,
            minHeight: 6,
            color: color,
            backgroundColor: AppColors.graySoft,
          ),
        ),
      ],
    );
  }
}

class _PersonCard extends StatelessWidget {
  const _PersonCard({required this.member, required this.onTap});
  final MemberStats member;
  final VoidCallback onTap;

  static const amberBorder = Color(0xFFF5B27A);
  static const amberBg = Color(0xFFFFFAF5);

  @override
  Widget build(BuildContext context) {
    final m = member;
    final idle = m.idle;
    return Material(
      key: ValueKey('person-${m.id}'),
      color: idle ? amberBg : AppColors.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(
          color: idle ? amberBorder : AppColors.border,
          width: idle ? 1.5 : 1,
        ),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Wrap(
                      spacing: 8,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          m.name,
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: AppColors.text,
                          ),
                        ),
                        if (idle) Pill.warn('No calls logged'),
                      ],
                    ),
                  ),
                  const Icon(Icons.chevron_right, color: AppColors.muted),
                ],
              ),
              const SizedBox(height: 10),
              _StatGrid(
                stats: [
                  ('${m.callsLogged}', 'Calls logged'),
                  ('${m.count('k05-whatsapp')}', 'WhatsApp'),
                  ('${m.count('k04')}', 'Call taps'),
                  ('${m.count('k07')}', 'Connected'),
                  (
                    '${m.count('k11')} / ${m.count('k12')}',
                    'Visits set / done',
                  ),
                  ('${m.count('k18')}', 'Follow-ups due'),
                ],
              ),
              const SizedBox(height: 12),
              _RatioBar(label: 'Outcome logging', ratio: m.ratio('k08b')),
              const SizedBox(height: 10),
              _RatioBar(label: 'Follow-ups on time', ratio: m.ratio('k19b')),
            ],
          ),
        ),
      ),
    );
  }
}

class _PersonSheet extends StatelessWidget {
  const _PersonSheet({required this.member});
  final MemberStats member;

  @override
  Widget build(BuildContext context) {
    final m = member;
    Widget row(String id, String value, {Widget? extra}) {
      final (name, desc) = _metrics[id] ?? (id, '');
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    name,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: AppColors.text,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  value,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                    color: AppColors.text,
                  ),
                ),
              ],
            ),
            if (extra != null) ...[const SizedBox(height: 4), extra],
            if (desc.isNotEmpty) ...[
              const SizedBox(height: 2),
              Text(
                desc,
                style: const TextStyle(fontSize: 12.5, color: AppColors.muted),
              ),
            ],
          ],
        ),
      );
    }

    String ratioText(String id) {
      final r = m.ratio(id);
      final rate = m.rate(id);
      if (r == null || rate == null) return '—';
      return '${(rate * 100).round()}%';
    }

    Widget? ratioExtra(String id) {
      final r = m.ratio(id);
      final den = (r?['denominator'] as num?) ?? 0;
      if (r == null || den == 0) {
        return const Text(
          'No data in this period',
          style: TextStyle(fontSize: 12.5, color: AppColors.gray),
        );
      }
      final low = r['lowSample'] == true;
      return Wrap(
        spacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text(
            '${r['numerator']} of $den',
            style: const TextStyle(fontSize: 12.5, color: AppColors.gray),
          ),
          if (low) const Pill('Low sample'),
        ],
      );
    }

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.75,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      builder: (context, controller) => ListView(
        controller: controller,
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        children: [
          Text(
            m.name,
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
          ),
          if (m.idle) ...[
            const SizedBox(height: 6),
            Align(
              alignment: Alignment.centerLeft,
              child: Pill.warn('No calls logged in this period'),
            ),
          ],
          const SectionLabel('Activity'),
          for (final id in _countOrder) row(id, '${m.count(id)}'),
          const SectionLabel('Rates'),
          for (final id in _ratioOrder)
            row(id, ratioText(id), extra: ratioExtra(id)),
        ],
      ),
    );
  }
}
