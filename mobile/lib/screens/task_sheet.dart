import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../theme.dart';
import 'lead_sheets.dart' show FormErrors;
import 'when_picker.dart';

/// Add a follow-up or task (POST /api/v1/tasks), the same command as the website (FR-103).
/// With a [lead]: a follow-up, call, meeting, document or other task about that lead. Without:
/// a personal task (call, document or other). Managers may give it to someone in their scope.
/// Pops `true` once added.
class AddTaskSheet extends StatefulWidget {
  const AddTaskSheet({
    super.key,
    required this.api,
    required this.nowLocal,
    this.lead,
  });

  final ApiClient api;

  /// The org-local "now" ("yyyy-MM-ddTHH:mm").
  final String nowLocal;
  final Map<String, dynamic>? lead;

  @override
  State<AddTaskSheet> createState() => _AddTaskSheetState();
}

const _types = {
  'FOLLOW_UP': 'Follow-up',
  'CALL': 'Call',
  'MEETING': 'Meeting',
  'DOCUMENT': 'Document',
  'OTHER': 'Other',
};

const _priorities = {
  'LOW': 'Low',
  'NORMAL': 'Normal',
  'HIGH': 'High',
  'URGENT': 'Urgent',
};

class _AddTaskSheetState extends State<AddTaskSheet> {
  late String _type = widget.lead != null ? 'FOLLOW_UP' : 'CALL';
  late String _when;
  late String _end;
  final _title = TextEditingController();
  final _location = TextEditingController();
  String _priority = 'NORMAL';
  String _assignee = '';
  List<Map<String, dynamic>> _people = const [];
  bool _saving = false;
  List<String> _errors = const [];

  @override
  void initState() {
    super.initState();
    final now = parseLocal(widget.nowLocal);
    final start = DateTime(now.year, now.month, now.day + 1, 10);
    _when = formatLocal(start);
    _end = formatLocal(start.add(const Duration(hours: 1)));
    _loadPeople();
  }

  @override
  void dispose() {
    _title.dispose();
    _location.dispose();
    super.dispose();
  }

  Future<void> _loadPeople() async {
    try {
      final d = await widget.api.get('/task-assignees', {
        if (widget.lead != null) 'leadId': widget.lead!['id'] as String,
      }) as Map<String, dynamic>;
      if (mounted) {
        setState(
          () => _people = ((d['people'] as List?) ?? const [])
              .cast<Map<String, dynamic>>(),
        );
      }
    } on ApiException {
      // Only yourself, then.
    }
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _errors = const [];
    });
    try {
      final r = await widget.api.post('/tasks', {
        if (widget.lead != null) 'leadId': widget.lead!['id'],
        'type': _type,
        'title': _title.text.trim(),
        'dueAt': _when,
        'priority': _priority,
        if (_assignee.isNotEmpty) 'assigneeUserId': _assignee,
        if (_type == 'MEETING') ...{
          'endAt': _end,
          'location': _location.text.trim(),
        },
      });
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

  @override
  Widget build(BuildContext context) {
    final types = widget.lead != null
        ? _types
        : (Map.of(_types)
            ..removeWhere((k, _) => k == 'FOLLOW_UP' || k == 'MEETING'));
    final others = _people;
    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          Text(
            widget.lead != null
                ? 'Add a task · ${widget.lead!['fullName']}'
                : 'Add a task',
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final e in types.entries)
                ChoiceChip(
                  label: Text(e.value),
                  selected: _type == e.key,
                  onSelected: (_) => setState(() => _type = e.key),
                ),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('task-title'),
            controller: _title,
            maxLength: 200,
            decoration: InputDecoration(
              labelText: _type == 'FOLLOW_UP'
                  ? 'Title (optional)'
                  : 'What is it?',
              hintText: _type == 'CALL' ? 'Call back about the 2BHK' : null,
            ),
          ),
          WhenPicker(
            label: _type == 'MEETING' ? 'Starts' : 'Due',
            value: _when,
            onChanged: (s) => setState(() => _when = s),
          ),
          if (_type == 'MEETING') ...[
            const SizedBox(height: 12),
            WhenPicker(
              label: 'Ends',
              value: _end,
              onChanged: (s) => setState(() => _end = s),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _location,
              maxLength: 300,
              decoration: const InputDecoration(labelText: 'Where'),
            ),
          ],
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _priority,
            decoration: const InputDecoration(labelText: 'Priority'),
            items: [
              for (final e in _priorities.entries)
                DropdownMenuItem(value: e.key, child: Text(e.value)),
            ],
            onChanged: (v) => setState(() => _priority = v ?? 'NORMAL'),
          ),
          if (others.isNotEmpty) ...[
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _assignee,
              decoration: const InputDecoration(labelText: 'For'),
              items: [
                const DropdownMenuItem(value: '', child: Text('Me')),
                for (final p in others)
                  DropdownMenuItem(
                    value: p['userId'] as String,
                    child: Text(p['name'] as String? ?? ''),
                  ),
              ],
              onChanged: (v) => setState(() => _assignee = v ?? ''),
            ),
          ],
          if (_type == 'FOLLOW_UP')
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'A lead has one open follow-up per person. If one is open, move it instead.',
                style: TextStyle(color: AppColors.muted, fontSize: 13),
              ),
            ),
          FormErrors(_errors),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_saving ? 'Adding…' : 'Add task'),
          ),
        ],
      ),
    );
  }
}
