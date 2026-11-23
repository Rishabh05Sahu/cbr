import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../theme.dart';
import 'when_picker.dart';

/// Server errors under a form, in red.
class FormErrors extends StatelessWidget {
  const FormErrors(this.errors, {super.key});
  final List<String> errors;

  @override
  Widget build(BuildContext context) {
    if (errors.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final e in errors)
            Text(e, style: const TextStyle(color: AppColors.red)),
        ],
      ),
    );
  }
}

/// FR-150 Book a visit (POST /api/v1/leads/:id/visits), as the website's Schedule visit form: date
/// and time (org time), meeting point and, for managers, the salesperson. Booking moves the lead
/// to Site visit scheduled. Pops `true` once booked.
class BookVisitSheet extends StatefulWidget {
  const BookVisitSheet({
    super.key,
    required this.api,
    required this.lead,
    required this.nowLocal,
    this.people = const [],
  });

  final ApiClient api;
  final Map<String, dynamic> lead;

  /// The org-local "now" from the server ("yyyy-MM-ddTHH:mm").
  final String nowLocal;

  /// Salespeople a manager may book for (empty: the visit is the caller's own).
  final List<Map<String, dynamic>> people;

  @override
  State<BookVisitSheet> createState() => _BookVisitSheetState();
}

class _BookVisitSheetState extends State<BookVisitSheet> {
  late String _when;
  final _location = TextEditingController();
  String _assignee = '';
  bool _saving = false;
  List<String> _errors = const [];

  @override
  void initState() {
    super.initState();
    final now = parseLocal(widget.nowLocal);
    _when = formatLocal(DateTime(now.year, now.month, now.day + 1, 11));
  }

  @override
  void dispose() {
    _location.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _errors = const [];
    });
    try {
      final r = await widget.api.post('/leads/${widget.lead['id']}/visits', {
        'scheduledFor': _when,
        'location': _location.text.trim(),
        if (_assignee.isNotEmpty) 'assigneeUserId': _assignee,
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
    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          Text(
            'Book a site visit · ${widget.lead['fullName']}',
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 16),
          WhenPicker(
            label: 'Date and time',
            value: _when,
            onChanged: (s) => setState(() => _when = s),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _location,
            maxLength: 300,
            decoration: const InputDecoration(
              labelText: 'Meeting point',
              hintText: 'Building, community or site office',
            ),
          ),
          if (widget.people.isNotEmpty) ...[
            const SizedBox(height: 4),
            DropdownButtonFormField<String>(
              initialValue: _assignee,
              decoration: const InputDecoration(labelText: 'Salesperson'),
              items: [
                const DropdownMenuItem(value: '', child: Text('Me')),
                for (final p in widget.people)
                  DropdownMenuItem(
                    value: p['userId'] as String,
                    child: Text(p['name'] as String? ?? ''),
                  ),
              ],
              onChanged: (v) => setState(() => _assignee = v ?? ''),
            ),
          ],
          const SizedBox(height: 8),
          const Text(
            'Booking moves the lead to Site visit scheduled. Reminders go to the salesperson.',
            style: TextStyle(color: AppColors.muted, fontSize: 13),
          ),
          FormErrors(_errors),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_saving ? 'Booking…' : 'Book visit'),
          ),
        ],
      ),
    );
  }
}

/// Change stage (POST /api/v1/leads/:id/stage), as the website's Change stage card. The stages
/// offered come from the server. Lost needs a reason; Nurture needs a date to follow up again;
/// moving back and a completed visit need a reason or feedback. Site visit scheduled is booked
/// with [BookVisitSheet] instead, so a real visit exists. Pops `true` once changed.
class StageSheet extends StatefulWidget {
  const StageSheet({
    super.key,
    required this.api,
    required this.lead,
    required this.targets,
    required this.lostReasons,
    required this.nowLocal,
  });

  final ApiClient api;
  final Map<String, dynamic> lead;
  final List<Map<String, dynamic>> targets;
  final List<Map<String, dynamic>> lostReasons;
  final String nowLocal;

  @override
  State<StageSheet> createState() => _StageSheetState();
}

class _StageSheetState extends State<StageSheet> {
  String? _to;
  String? _lostReason;
  final _reason = TextEditingController();
  late String _nurture;
  bool _saving = false;
  List<String> _errors = const [];

  @override
  void initState() {
    super.initState();
    final now = parseLocal(widget.nowLocal);
    _nurture = formatLocal(DateTime(now.year, now.month + 1, now.day, 10));
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_to == null) {
      setState(() => _errors = ['Choose the new stage']);
      return;
    }
    setState(() {
      _saving = true;
      _errors = const [];
    });
    try {
      await widget.api.post('/leads/${widget.lead['id']}/stage', {
        'toStage': _to,
        'version': widget.lead['version'],
        if (_to == 'LOST') 'reasonCode': _lostReason ?? '',
        'reasonText': _reason.text.trim(),
        // The website's Nurture field is a date.
        if (_to == 'NURTURE') 'nurtureUntil': _nurture.substring(0, 10),
      });
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _errors = e.allMessages);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final targets = widget.targets
        .where((t) => t['code'] != 'SITE_VISIT_SCHEDULED')
        .toList();
    final current = widget.lead['stage'] as String?;
    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          Text(
            'Change stage · ${widget.lead['fullName']}',
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 4),
          Text(
            'Now: ${label(stageLabels, current)}',
            style: const TextStyle(color: AppColors.muted),
          ),
          const SectionLabel('New stage'),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final t in targets)
                ChoiceChip(
                  label: Text(t['label'] as String? ?? ''),
                  selected: _to == t['code'],
                  onSelected: _saving
                      ? null
                      : (_) => setState(() {
                          _to = t['code'] as String;
                          _errors = const [];
                        }),
                ),
            ],
          ),
          if (widget.targets.any((t) => t['code'] == 'SITE_VISIT_SCHEDULED'))
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'To schedule a site visit, use Book a visit on the lead.',
                style: TextStyle(color: AppColors.muted, fontSize: 13),
              ),
            ),
          if (_to == 'LOST') ...[
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _lostReason,
              decoration: const InputDecoration(labelText: 'Lost reason'),
              items: [
                for (final r in widget.lostReasons)
                  DropdownMenuItem(
                    value: r['code'] as String,
                    child: Text(r['label'] as String? ?? ''),
                  ),
              ],
              onChanged: (v) => setState(() => _lostReason = v),
            ),
          ],
          if (_to == 'NURTURE') ...[
            const SizedBox(height: 12),
            WhenPicker(
              label: 'Follow up again on',
              value: _nurture,
              onChanged: (s) => setState(() => _nurture = s),
            ),
          ],
          if (_to != null) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _reason,
              minLines: 2,
              maxLines: 4,
              maxLength: 1000,
              decoration: InputDecoration(
                labelText: _to == 'SITE_VISIT_COMPLETED'
                    ? 'Visit feedback'
                    : 'Reason (needed when moving back)',
              ),
            ),
          ],
          FormErrors(_errors),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_saving ? 'Saving…' : 'Change stage'),
          ),
        ],
      ),
    );
  }
}
