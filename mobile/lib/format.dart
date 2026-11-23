import 'package:intl/intl.dart';

/// Labels for codes the server sends, in the website's wording (src/modules/leads/stages.ts).
const Map<String, String> stageLabels = {
  'NEW': 'New',
  'ASSIGNED': 'Assigned',
  'CONTACTED': 'Contacted',
  'QUALIFIED': 'Qualified',
  'SITE_VISIT_SCHEDULED': 'Site visit scheduled',
  'SITE_VISIT_COMPLETED': 'Site visit completed',
  'NEGOTIATION': 'Negotiation',
  'WON': 'Won',
  'LOST': 'Lost',
  'NURTURE': 'Nurture',
};

const Map<String, String> roleLabels = {
  'OWNER': 'Owner',
  'ADMIN': 'Admin',
  'SALES_MANAGER': 'Sales Manager',
  'SALES_EXECUTIVE': 'Sales Executive',
  'HR_OPS': 'HR / Ops',
  'owner': 'Owner',
  'admin': 'Admin',
  'sales_manager': 'Sales Manager',
  'sales_executive': 'Sales Executive',
  'hr_ops': 'HR / Ops',
};

const Map<String, String> taskTypeLabels = {
  'FOLLOW_UP': 'Follow-up',
  'CALL': 'Call',
  'MEETING': 'Meeting',
  'DOCUMENT': 'Document',
  'OTHER': 'Other',
};

String label(Map<String, String> map, String? code) {
  if (code == null || code.isEmpty) return '';
  return map[code] ?? _titleCase(code);
}

String _titleCase(String code) {
  final s = code.replaceAll('_', ' ').toLowerCase();
  return s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);
}

/// "Today 4:30 pm", "Tomorrow 10:00 am", "Mon 24 Nov, 9:00 am" in the phone's time zone.
String dueText(String? iso) {
  if (iso == null) return '';
  final t = DateTime.tryParse(iso)?.toLocal();
  if (t == null) return '';
  final now = DateTime.now();
  final day = DateTime(t.year, t.month, t.day);
  final today = DateTime(now.year, now.month, now.day);
  final diff = day.difference(today).inDays;
  final time = DateFormat('h:mm a').format(t).toLowerCase();
  if (diff == 0) return 'Today $time';
  if (diff == 1) return 'Tomorrow $time';
  if (diff == -1) return 'Yesterday $time';
  return '${DateFormat('EEE d MMM').format(t)}, $time';
}

String longDate(DateTime d) => DateFormat('EEEE d MMMM').format(d);

/// AED amounts as the website shows them: 2,500,000 → "AED 2.5M".
String aed(num? v) {
  if (v == null) return '';
  if (v >= 1000000) {
    return 'AED ${(v / 1000000).toStringAsFixed(v % 1000000 == 0 ? 0 : 1)}M';
  }
  if (v >= 1000) return 'AED ${(v / 1000).toStringAsFixed(0)}K';
  return 'AED $v';
}

/// Org-local datetime-local strings ("2026-11-21T16:30"): the server's own format for "when"
/// fields. Built from the server's "now" so the phone's time zone never matters.
DateTime parseLocal(String s) => DateTime.parse(s.length == 16 ? '$s:00' : s);
String formatLocal(DateTime d) => DateFormat("yyyy-MM-dd'T'HH:mm").format(d);

/// Site visit statuses in the website's wording (src/modules/visits/rules.ts).
const Map<String, String> visitStatusLabels = {
  'SCHEDULED': 'Scheduled',
  'CONFIRMED': 'Confirmed',
  'RESCHEDULED': 'Rescheduled',
  'CANCELLED': 'Cancelled',
  'ATTENDED': 'Attended',
  'NO_SHOW': 'No-show',
};

String visitStatusLabel(String? code) => label(visitStatusLabels, code);
