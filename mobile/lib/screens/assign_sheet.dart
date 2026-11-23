import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../theme.dart';

/// Assign or reassign leads (FR-063/070/073), the approved "Assign" sheet.
///
/// One lead (the lead screen): pick a person; a reason is required when the lead already has an
/// owner. Several unassigned leads (the queue): pick a person, or deal them round-robin to a
/// team. Who may be picked comes from the server (GET /assignment-targets: all people for
/// Owner/Admin, the teams they lead for a Sales Manager), and the server re-checks every target.
/// Returns true when something was assigned.
class AssignSheet extends StatefulWidget {
  const AssignSheet({
    super.key,
    required this.api,
    required this.leadIds,
    this.version,
    this.currentOwnerId,
    this.title,
  });

  final ApiClient api;
  final List<String> leadIds;

  /// The lead's version, for a single lead (optimistic concurrency, as on the web).
  final int? version;

  /// The present owner of a single lead (reassigning needs a reason; they are not offered).
  final String? currentOwnerId;
  final String? title;

  bool get single => version != null;

  @override
  State<AssignSheet> createState() => _AssignSheetState();
}

class _AssignSheetState extends State<AssignSheet> {
  Map<String, dynamic>? _targets;
  String? _loadError;
  bool _roundRobin = false;
  String? _userId;
  String? _teamId;
  String _filter = '';
  final _reason = TextEditingController();
  bool _saving = false;
  List<String> _errors = const [];

  bool get _needsReason => widget.single && widget.currentOwnerId != null;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final t =
          await widget.api.get('/assignment-targets') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _targets = t;
        final teams = (t['teams'] as List).cast<Map<String, dynamic>>();
        if (teams.length == 1) _teamId = teams.first['id'] as String;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _loadError = e.message);
    }
  }

  List<Map<String, dynamic>> get _people {
    final all = ((_targets?['people'] as List?) ?? const [])
        .cast<Map<String, dynamic>>();
    final f = _filter.trim().toLowerCase();
    return all
        .where((p) => p['userId'] != widget.currentOwnerId)
        .where(
          (p) => f.isEmpty || (p['name'] as String).toLowerCase().contains(f),
        )
        .toList();
  }

  List<Map<String, dynamic>> get _teams =>
      ((_targets?['teams'] as List?) ?? const []).cast<Map<String, dynamic>>();

  Future<void> _save() async {
    if (_roundRobin ? _teamId == null : _userId == null) {
      setState(
        () => _errors = [
          _roundRobin ? 'Choose a team' : 'Choose who should own the lead',
        ],
      );
      return;
    }
    if (_needsReason && _reason.text.trim().isEmpty) {
      setState(() => _errors = ['Give a reason for reassigning']);
      return;
    }
    setState(() {
      _saving = true;
      _errors = const [];
    });
    try {
      if (_roundRobin) {
        await widget.api.post('/leads/round-robin', {
          'leadIds': widget.leadIds,
          'teamId': _teamId,
        });
      } else if (widget.single) {
        await widget.api.post('/leads/${widget.leadIds.first}/assign', {
          'target': 'user:$_userId',
          'version': widget.version,
          if (_reason.text.trim().isNotEmpty) 'reason': _reason.text.trim(),
        });
      } else {
        await widget.api.post('/leads/assign', {
          'leadIds': widget.leadIds,
          'target': 'user:$_userId',
          if (_reason.text.trim().isNotEmpty) 'reason': _reason.text.trim(),
        });
      }
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _errors = e.allMessages);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_targets == null) {
      return SizedBox(
        height: 240,
        child: _loadError == null
            ? const Center(child: CircularProgressIndicator())
            : MessageView(message: _loadError!, onRetry: _load),
      );
    }
    final count = widget.leadIds.length;
    final canRoundRobin = !widget.single && _teams.isNotEmpty;
    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          Text(
            widget.title ??
                (widget.single
                    ? (widget.currentOwnerId == null
                          ? 'Assign lead'
                          : 'Reassign lead')
                    : 'Assign $count ${count == 1 ? 'lead' : 'leads'}'),
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 12),
          if (canRoundRobin) ...[
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: false, label: Text('Pick a person')),
                ButtonSegment(value: true, label: Text('Round-robin')),
              ],
              selected: {_roundRobin},
              showSelectedIcon: false,
              onSelectionChanged: (s) => setState(() {
                _roundRobin = s.first;
                _errors = const [];
              }),
            ),
            const SizedBox(height: 12),
          ],
          if (_roundRobin) ...[
            const Text(
              "Leads are shared out in turn among the team's active members.",
              style: TextStyle(color: AppColors.muted),
            ),
            const SizedBox(height: 8),
            RadioGroup<String>(
              groupValue: _teamId,
              onChanged: (v) => setState(() => _teamId = v),
              child: Column(
                children: [
                  for (final t in _teams)
                    RadioListTile<String>(
                      contentPadding: EdgeInsets.zero,
                      value: t['id'] as String,
                      title: Text(t['name'] as String),
                    ),
                ],
              ),
            ),
          ] else ...[
            if (((_targets!['people'] as List?) ?? const []).length > 6)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: TextField(
                  decoration: const InputDecoration(
                    hintText: 'Search people',
                    prefixIcon: Icon(Icons.search),
                  ),
                  onChanged: (v) => setState(() => _filter = v),
                ),
              ),
            if (_people.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  'Nobody you can assign to. A Sales Manager assigns within the teams they lead.',
                  style: TextStyle(color: AppColors.muted),
                ),
              ),
            RadioGroup<String>(
              groupValue: _userId,
              onChanged: (v) => setState(() => _userId = v),
              child: Column(
                children: [
                  for (final p in _people)
                    RadioListTile<String>(
                      contentPadding: EdgeInsets.zero,
                      value: p['userId'] as String,
                      title: Text(p['name'] as String),
                    ),
                ],
              ),
            ),
          ],
          if (_needsReason) ...[
            const SizedBox(height: 8),
            TextField(
              controller: _reason,
              decoration: const InputDecoration(
                labelText: 'Reason for reassigning',
              ),
            ),
          ],
          if (_errors.isNotEmpty) ...[
            const SizedBox(height: 12),
            for (final e in _errors)
              Text(e, style: const TextStyle(color: AppColors.red)),
          ],
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(
                    width: 22,
                    height: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.5,
                      color: Colors.white,
                    ),
                  )
                : Text(_roundRobin ? 'Share out' : 'Assign'),
          ),
        ],
      ),
    );
  }
}

/// Opens [AssignSheet] as a bottom sheet; true when something was assigned.
Future<bool> showAssignSheet(
  BuildContext context, {
  required ApiClient api,
  required List<String> leadIds,
  int? version,
  String? currentOwnerId,
}) async {
  final r = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => AssignSheet(
      api: api,
      leadIds: leadIds,
      version: version,
      currentOwnerId: currentOwnerId,
    ),
  );
  return r == true;
}
