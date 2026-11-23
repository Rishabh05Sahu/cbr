import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../theme.dart';
import 'when_picker.dart';

/// FR-151/152 on a site visit (POST /api/v1/visits/:id): confirm, reschedule (new time and
/// reason), cancel (reason), and from the visit's day no-show (reason) or attended (interest,
/// objections, notes, next action). The same command as the website; the server re-checks the
/// lead, the transition, the time rules and the version. Pops `true` once something was saved.
class VisitSheet extends StatefulWidget {
  const VisitSheet({super.key, required this.api, required this.visit});

  final ApiClient api;
  final Map<String, dynamic> visit;

  @override
  State<VisitSheet> createState() => _VisitSheetState();
}

const _interest = {
  'HIGH': 'High',
  'MEDIUM': 'Medium',
  'LOW': 'Low',
  'NONE': 'None',
};

class _VisitSheetState extends State<VisitSheet> {
  String? _action;
  late String _when;
  String? _interestLevel;
  final _reason = TextEditingController();
  final _objections = TextEditingController();
  final _notes = TextEditingController();
  final _nextAction = TextEditingController();
  bool _saving = false;
  List<String> _errors = const [];

  Map<String, dynamic> get v => widget.visit;

  @override
  void initState() {
    super.initState();
    _when = v['scheduledForLocal'] as String? ?? formatLocal(DateTime.now());
  }

  @override
  void dispose() {
    _reason.dispose();
    _objections.dispose();
    _notes.dispose();
    _nextAction.dispose();
    super.dispose();
  }

  Future<void> _save(String action) async {
    setState(() {
      _saving = true;
      _errors = const [];
    });
    final body = <String, dynamic>{
      'action': action,
      'version': v['version'],
      if (action == 'reschedule') 'scheduledFor': _when,
      if (action == 'reschedule' || action == 'cancel' || action == 'no_show')
        'reason': _reason.text.trim(),
      if (action == 'attended') ...{
        'interestLevel': _interestLevel ?? '',
        'objections': _objections.text,
        'notes': _notes.text,
        'nextAction': _nextAction.text.trim(),
      },
    };
    try {
      final r = await widget.api.post('/visits/${v['id']}', body);
      final warning = r is Map ? r['warning'] as String? : null;
      if (!mounted) return;
      if (warning != null) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(warning)));
      }
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _errors = e.allMessages);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _choose(String a) => setState(() {
    _action = _action == a ? null : a;
    _errors = const [];
  });

  Widget _field(TextEditingController c, String label, {int lines = 1}) =>
      Padding(
        padding: const EdgeInsets.only(top: 12),
        child: TextField(
          controller: c,
          minLines: lines,
          maxLines: lines == 1 ? 1 : 5,
          decoration: InputDecoration(labelText: label),
        ),
      );

  Widget _form() {
    final a = _action;
    if (a == null) return const SizedBox.shrink();
    const labels = {
      'reschedule': 'Save new time',
      'cancel': 'Cancel visit',
      'no_show': 'Record no-show',
      'attended': 'Record visit',
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 4),
        if (a == 'reschedule') ...[
          const SizedBox(height: 12),
          WhenPicker(
            label: 'New date and time',
            value: _when,
            onChanged: (s) => setState(() => _when = s),
          ),
        ],
        if (a == 'reschedule' || a == 'cancel' || a == 'no_show')
          _field(_reason, 'Reason'),
        if (a == 'attended') ...[
          const SectionLabel('Interest level'),
          Wrap(
            spacing: 8,
            children: [
              for (final e in _interest.entries)
                ChoiceChip(
                  label: Text(e.value),
                  selected: _interestLevel == e.key,
                  onSelected: (_) => setState(() => _interestLevel = e.key),
                ),
            ],
          ),
          _field(_objections, 'Objections (separate with commas)'),
          _field(_notes, 'Notes', lines: 3),
          _field(_nextAction, 'Next action'),
        ],
        const SizedBox(height: 16),
        FilledButton(
          onPressed: _saving ? null : () => _save(a),
          child: Text(_saving ? 'Saving…' : labels[a]!),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final lead = v['lead'] as Map<String, dynamic>?;
    final name = lead?['fullName'] as String? ?? v['leadName'] as String? ?? '';
    final status = v['status'] as String? ?? '';
    final due = v['outcomeDue'] == true;
    final canManage = v['canManage'] == true;
    Widget chip(String a, String text) => ChoiceChip(
      label: Text(text),
      selected: _action == a,
      onSelected: _saving ? null : (_) => _choose(a),
    );
    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          Text(
            'Site visit · $name',
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 6),
          Text(
            '${dueText(v['scheduledFor'] as String?)} · ${visitStatusLabel(status)}',
            style: const TextStyle(color: AppColors.muted),
          ),
          const SizedBox(height: 4),
          Text('Meeting point: ${v['location'] ?? ''}'),
          Text(
            'With ${v['assigneeName'] ?? ''}',
            style: const TextStyle(color: AppColors.muted, fontSize: 13),
          ),
          if (!canManage)
            const Padding(
              padding: EdgeInsets.only(top: 16),
              child: Text(
                'You can see this visit but not change it. The lead\'s owner or a manager can.',
                style: TextStyle(color: AppColors.muted),
              ),
            )
          else ...[
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (status != 'CONFIRMED')
                  ActionChip(
                    label: const Text('Confirm'),
                    avatar: const Icon(Icons.check, size: 18),
                    onPressed: _saving ? null : () => _save('confirm'),
                  ),
                chip('reschedule', 'Reschedule'),
                chip('cancel', 'Cancel'),
                if (due) chip('attended', 'Attended'),
                if (due) chip('no_show', 'No-show'),
              ],
            ),
            if (!due)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text(
                  'Attended and no-show can be recorded from the visit\'s day.',
                  style: TextStyle(color: AppColors.muted, fontSize: 13),
                ),
              ),
            _form(),
          ],
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
