import 'package:material_ui/material_ui.dart';
import 'package:intl/intl.dart';

import '../format.dart';

/// A date and time field for "when" values the server reads as org-local datetime-local strings
/// ("2026-11-24T16:30"). It starts from a server-provided org-local value, so the phone's own
/// time zone never shifts the time that is sent.
class WhenPicker extends StatelessWidget {
  const WhenPicker({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
  });

  final String label;

  /// The chosen org-local value ("yyyy-MM-ddTHH:mm").
  final String value;
  final ValueChanged<String> onChanged;

  Future<void> _pick(BuildContext context) async {
    final current = parseLocal(value);
    final date = await showDatePicker(
      context: context,
      initialDate: current,
      firstDate: DateTime(current.year - 1),
      lastDate: DateTime(current.year + 2),
    );
    if (date == null || !context.mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: current.hour, minute: current.minute),
    );
    if (time == null) return;
    onChanged(
      formatLocal(
        DateTime(date.year, date.month, date.day, time.hour, time.minute),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final d = parseLocal(value);
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => _pick(context),
      child: InputDecorator(
        decoration: InputDecoration(
          labelText: label,
          suffixIcon: const Icon(Icons.event),
        ),
        child: Text(
          '${DateFormat('EEE d MMM yyyy').format(d)}, '
          '${DateFormat('h:mm a').format(d).toLowerCase()}',
        ),
      ),
    );
  }
}
