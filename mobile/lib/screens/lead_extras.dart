import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../theme.dart';
import 'lead_sheets.dart';

/// Lead screen additions (owner request 2026-11-24): edit contact details, the lead's history,
/// quick WhatsApp messages and sending a property, picking properties, and adding a tag.

// --- Edit contact details ---------------------------------------------------------------------

const _contactMethods = {
  '': '—',
  'PHONE': 'Phone',
  'WHATSAPP': 'WhatsApp',
  'EMAIL': 'Email',
  'ANY': 'Any',
};

/// POST /api/v1/leads/:id/contact: name, alternate number (not while numbers are masked), email,
/// preferred contact method and language. The main number is not edited (as on the website).
/// Pops `true` once saved.
class EditContactSheet extends StatefulWidget {
  const EditContactSheet({super.key, required this.api, required this.lead});
  final ApiClient api;
  final Map<String, dynamic> lead;

  @override
  State<EditContactSheet> createState() => _EditContactSheetState();
}

class _EditContactSheetState extends State<EditContactSheet> {
  late final _name = TextEditingController(text: _s('fullName'));
  late final _alt = TextEditingController(text: _s('alternatePhoneE164'));
  late final _email = TextEditingController(text: _s('email'));
  late final _lang = TextEditingController(text: _s('preferredLanguage'));
  late String _method =
      _contactMethods.containsKey(_s('preferredContactMethod'))
      ? _s('preferredContactMethod')
      : '';
  bool _saving = false;
  List<String> _errors = const [];

  String _s(String k) => (widget.lead[k] as String?) ?? '';
  bool get _masked => widget.lead['phoneMasked'] == true;

  @override
  void dispose() {
    for (final c in [_name, _alt, _email, _lang]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _errors = const [];
    });
    try {
      await widget.api.post('/leads/${widget.lead['id']}/contact', {
        'version': widget.lead['version'],
        'fullName': _name.text.trim(),
        if (!_masked) 'alternatePhone': _alt.text.trim(),
        'email': _email.text.trim(),
        'preferredLanguage': _lang.text.trim().toLowerCase(),
        'preferredContactMethod': _method,
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
    Widget gap() => const SizedBox(height: 12);
    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          const Text(
            'Edit contact details',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 4),
          Text(
            'Main number: ${_s('primaryPhoneE164')}. It identifies the lead and is not changed here.',
            style: const TextStyle(color: AppColors.muted, fontSize: 13),
          ),
          gap(),
          TextField(
            controller: _name,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Name'),
          ),
          gap(),
          if (!_masked) ...[
            TextField(
              controller: _alt,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                labelText: 'Alternate number (optional)',
                hintText: '+971 50 123 4567',
              ),
            ),
            gap(),
          ],
          TextField(
            controller: _email,
            keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(labelText: 'Email (optional)'),
          ),
          gap(),
          DropdownButtonFormField<String>(
            initialValue: _method,
            decoration: const InputDecoration(labelText: 'Preferred contact'),
            items: [
              for (final e in _contactMethods.entries)
                DropdownMenuItem(value: e.key, child: Text(e.value)),
            ],
            onChanged: (v) => setState(() => _method = v ?? ''),
          ),
          gap(),
          TextField(
            controller: _lang,
            maxLength: 2,
            decoration: const InputDecoration(
              labelText: 'Language code (optional)',
              hintText: 'en, ar, hi…',
            ),
          ),
          FormErrors(_errors),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_saving ? 'Saving…' : 'Save'),
          ),
        ],
      ),
    );
  }
}

// --- History ----------------------------------------------------------------------------------

IconData _historyIcon(String? kind) => switch (kind) {
  'call' => Icons.call_outlined,
  'stage' => Icons.swap_horiz,
  'visit' => Icons.place_outlined,
  'task' => Icons.event_available_outlined,
  'note' => Icons.sticky_note_2_outlined,
  'assigned' => Icons.person_outline,
  'status' => Icons.block,
  'edit' => Icons.edit_outlined,
  _ => Icons.circle_outlined,
};

/// One history entry: icon, the website's sentence, any notes, and who/when.
class HistoryTile extends StatelessWidget {
  const HistoryTile(this.entry, {super.key, this.last = false});
  final Map<String, dynamic> entry;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final line = (entry['line'] as Map?) ?? const {};
    final detail = (line['detail'] as String?)?.trim();
    final who = entry['actorName'] as String?;
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 32,
            child: Column(
              children: [
                Container(
                  width: 28,
                  height: 28,
                  decoration: const BoxDecoration(
                    color: AppColors.tealSoft,
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    _historyIcon(line['kind'] as String?),
                    size: 16,
                    color: AppColors.teal,
                  ),
                ),
                if (!last)
                  Expanded(child: Container(width: 2, color: AppColors.border)),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    line['text'] as String? ?? entry['type'] as String? ?? '',
                    style: const TextStyle(fontSize: 14, color: AppColors.text),
                  ),
                  if (detail != null && detail.isNotEmpty)
                    Container(
                      margin: const EdgeInsets.only(top: 6),
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: AppColors.graySoft,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(detail, style: const TextStyle(fontSize: 13)),
                    ),
                  const SizedBox(height: 4),
                  Text(
                    [
                      dueText(entry['occurredAt'] as String?),
                      if (who != null && who.isNotEmpty) who,
                      if (entry['fromMergedLeadId'] != null)
                        'from a merged lead',
                    ].join(' · '),
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.muted,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// GET /api/v1/leads/:id/timeline: the full history, newest first.
class LeadHistoryScreen extends StatefulWidget {
  const LeadHistoryScreen({
    super.key,
    required this.api,
    required this.leadId,
    required this.leadName,
  });
  final ApiClient api;
  final String leadId;
  final String leadName;

  @override
  State<LeadHistoryScreen> createState() => _LeadHistoryScreenState();
}

class _LeadHistoryScreenState extends State<LeadHistoryScreen> {
  List<Map<String, dynamic>>? _rows;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d =
          await widget.api.get('/leads/${widget.leadId}/timeline') as List;
      if (mounted) setState(() => _rows = d.cast<Map<String, dynamic>>());
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final rows = _rows;
    return Scaffold(
      appBar: AppBar(title: Text('History · ${widget.leadName}')),
      body: rows == null
          ? (_error == null
                ? const Center(child: CircularProgressIndicator())
                : MessageView(message: _error!, onRetry: _load))
          : rows.isEmpty
          ? const MessageView(message: 'No history yet.', icon: Icons.history)
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView.builder(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                itemCount: rows.length,
                itemBuilder: (_, i) =>
                    HistoryTile(rows[i], last: i == rows.length - 1),
              ),
            ),
    );
  }
}

// --- Directions -------------------------------------------------------------------------------

/// Opens Google Maps (or the phone's maps app) searching for a meeting point. The address text
/// goes to Google Maps (owner approved 2026-11-24).
Future<bool> openDirections(String place) => launchUrl(
  Uri.https('www.google.com', '/maps/search/', {'api': '1', 'query': place}),
  mode: LaunchMode.externalApplication,
);

// --- Properties -------------------------------------------------------------------------------

/// "2 BR Apartment · Dubai Marina · AED 1.8M (P-00012)": one line for lists and messages.
String propertyLine(Map<String, dynamic> p) {
  final bhk = p['bhk'];
  final place = [
    p['locality'],
    p['city'],
  ].whereType<String>().where((s) => s.isNotEmpty).join(', ');
  final price = num.tryParse('${p['price'] ?? ''}');
  return [
    [
      if (bhk != null) '$bhk BR',
      label(const {}, p['propertyType'] as String?),
    ].where((s) => s.isNotEmpty).join(' '),
    if (place.isNotEmpty) place,
    if (price != null) aed(price),
  ].where((s) => s.isNotEmpty).join(' · ');
}

/// The property as a WhatsApp message.
String propertyMessage(Map<String, dynamic> p, {required String greeting}) {
  final lines = <String>[
    greeting,
    '',
    '*${p['title']}* (${p['code']})',
    propertyLine(p),
    if ((p['carpetAreaSqft'] ?? p['builtUpAreaSqft']) != null)
      'Area: ${p['builtUpAreaSqft'] ?? p['carpetAreaSqft']} sq ft',
    if (p['furnishing'] != null)
      'Furnishing: ${label(const {}, p['furnishing'] as String?)}',
    if ((p['description'] as String?)?.trim().isNotEmpty == true)
      (p['description'] as String).trim(),
    '',
    'Would you like to see it? I can arrange a visit.',
  ];
  return lines.join('\n');
}

/// GET /api/v1/properties?q=: pick one property ([multi] false) or up to [max] properties.
/// Pops the chosen property maps (in order), or null when closed.
class PropertyPickerSheet extends StatefulWidget {
  const PropertyPickerSheet({
    super.key,
    required this.api,
    this.multi = false,
    this.max = 10,
    this.selected = const [],
    this.title = 'Choose a property',
  });
  final ApiClient api;
  final bool multi;
  final int max;
  final List<Map<String, dynamic>> selected;
  final String title;

  @override
  State<PropertyPickerSheet> createState() => _PropertyPickerSheetState();
}

class _PropertyPickerSheetState extends State<PropertyPickerSheet> {
  final _q = TextEditingController();
  List<Map<String, dynamic>>? _rows;
  String? _error;
  late final List<Map<String, dynamic>> _chosen = [...widget.selected];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await widget.api.get('/properties', {
        if (_q.text.trim().isNotEmpty) 'q': _q.text.trim(),
      }) as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _rows = ((d['rows'] as List?) ?? const [])
              .cast<Map<String, dynamic>>();
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  bool _isChosen(Map<String, dynamic> p) =>
      _chosen.any((c) => c['id'] == p['id']);

  void _tap(Map<String, dynamic> p) {
    if (!widget.multi) {
      Navigator.of(context).pop([p]);
      return;
    }
    setState(() {
      if (_isChosen(p)) {
        _chosen.removeWhere((c) => c['id'] == p['id']);
      } else if (_chosen.length < widget.max) {
        _chosen.add(p);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final rows = _rows;
    return SizedBox(
      height: MediaQuery.of(context).size.height * 0.8,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(
              widget.title,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: TextField(
              controller: _q,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _load(),
              decoration: InputDecoration(
                hintText: 'Search by title, code or area',
                prefixIcon: const Icon(Icons.search),
                isDense: true,
                suffixIcon: IconButton(
                  icon: const Icon(Icons.arrow_forward),
                  onPressed: _load,
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: rows == null
                ? (_error == null
                      ? const Center(child: CircularProgressIndicator())
                      : MessageView(message: _error!, onRetry: _load))
                : rows.isEmpty
                ? const MessageView(
                    message: 'No properties found.',
                    icon: Icons.home_work_outlined,
                  )
                : ListView.builder(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    itemCount: rows.length,
                    itemBuilder: (_, i) {
                      final p = rows[i];
                      return ListTile(
                        onTap: () => _tap(p),
                        leading: widget.multi
                            ? Checkbox(
                                value: _isChosen(p),
                                onChanged: (_) => _tap(p),
                              )
                            : const Icon(Icons.home_work_outlined),
                        title: Text(
                          '${p['title']}',
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        subtitle: Text('${p['code']} · ${propertyLine(p)}'),
                      );
                    },
                  ),
          ),
          if (widget.multi)
            Padding(
              padding: const EdgeInsets.all(16),
              child: FilledButton(
                onPressed: () => Navigator.of(context).pop(_chosen),
                child: Text(
                  _chosen.isEmpty
                      ? 'No properties'
                      : 'Use ${_chosen.length} ${_chosen.length == 1 ? 'property' : 'properties'}',
                ),
              ),
            ),
        ],
      ),
    );
  }
}

Future<List<Map<String, dynamic>>?> pickProperties(
  BuildContext context,
  ApiClient api, {
  bool multi = false,
  List<Map<String, dynamic>> selected = const [],
  String title = 'Choose a property',
}) => showModalBottomSheet<List<Map<String, dynamic>>>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  showDragHandle: true,
  builder: (_) => PropertyPickerSheet(
    api: api,
    multi: multi,
    selected: selected,
    title: title,
  ),
);

// --- Quick WhatsApp messages ------------------------------------------------------------------

/// A ready message: its label and text with the names filled in.
class QuickMessage {
  const QuickMessage(this.label, this.icon, this.text);
  final String label;
  final IconData icon;
  final String text;
}

/// The fixed set (owner decision 2026-11-24): introduction, missed call, visit details, follow-up,
/// thank you after a visit. [visit] is the lead's next open visit, if any.
List<QuickMessage> quickMessages({
  required String leadName,
  required String agent,
  required String org,
  Map<String, dynamic>? visit,
}) {
  final first = leadName.trim().split(RegExp(r'\s+')).first;
  final sign = '– $agent, $org';
  return [
    QuickMessage(
      'Introduction',
      Icons.waving_hand_outlined,
      'Hi $first, this is $agent from $org. Thank you for your enquiry. '
          'When is a good time to talk about the properties you are looking for?',
    ),
    QuickMessage(
      'Missed call',
      Icons.phone_missed_outlined,
      'Hi $first, I tried calling you just now. Please let me know a convenient time '
          'to call back. $sign',
    ),
    if (visit != null)
      QuickMessage(
        'Visit details',
        Icons.place_outlined,
        'Hi $first, looking forward to meeting you ${dueText(visit['scheduledFor'] as String?)} '
            'at ${visit['location']}. Please let me know if anything changes. $sign',
      ),
    QuickMessage(
      'Follow-up',
      Icons.forum_outlined,
      'Hi $first, just following up on our conversation. Are you still looking? '
          'I would be happy to share new options that match your requirements. $sign',
    ),
    QuickMessage(
      'Thank you',
      Icons.favorite_border,
      'Hi $first, thank you for your time today. Please let me know if you have any questions '
          'or would like to see more properties. $sign',
    ),
  ];
}

/// Pops the message text to send, or null.
class WhatsAppMessageSheet extends StatelessWidget {
  const WhatsAppMessageSheet({
    super.key,
    required this.api,
    required this.messages,
    required this.leadFirstName,
  });
  final ApiClient api;
  final List<QuickMessage> messages;
  final String leadFirstName;

  @override
  Widget build(BuildContext context) {
    return ListView(
      shrinkWrap: true,
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 16),
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(8, 0, 8, 4),
          child: Text(
            'WhatsApp message',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
        ),
        const Padding(
          padding: EdgeInsets.fromLTRB(8, 0, 8, 8),
          child: Text(
            'WhatsApp opens with the message ready. You can change it before sending.',
            style: TextStyle(color: AppColors.muted, fontSize: 13),
          ),
        ),
        ListTile(
          leading: const Icon(Icons.home_work_outlined, color: AppColors.teal),
          title: const Text(
            'Send a property',
            style: TextStyle(fontWeight: FontWeight.w600),
          ),
          subtitle: const Text('Title, price, area and details'),
          onTap: () async {
            final picked = await pickProperties(
              context,
              api,
              title: 'Send a property',
            );
            if (picked == null || picked.isEmpty || !context.mounted) return;
            Navigator.of(context).pop(
              propertyMessage(
                picked.first,
                greeting:
                    'Hi $leadFirstName, here is a property that matches what you are looking for:',
              ),
            );
          },
        ),
        const Divider(height: 1),
        for (final m in messages)
          ListTile(
            leading: Icon(m.icon, color: AppColors.teal),
            title: Text(
              m.label,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            subtitle: Text(
              m.text,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            onTap: () => Navigator.of(context).pop(m.text),
          ),
        ListTile(
          leading: const Icon(Icons.chat_outlined, color: AppColors.muted),
          title: const Text('Empty message'),
          onTap: () => Navigator.of(context).pop(''),
        ),
      ],
    );
  }
}

/// The wa.me link from the server with the message added (`?text=`).
String withWhatsAppText(String href, String text) {
  if (text.isEmpty) return href;
  final u = Uri.parse(href);
  return u
      .replace(queryParameters: {...u.queryParameters, 'text': text})
      .toString();
}

// --- Tags -------------------------------------------------------------------------------------

/// POST /api/v1/leads/:id/tags with one of [options] not already on the lead. Pops `true`.
class AddTagSheet extends StatefulWidget {
  const AddTagSheet({
    super.key,
    required this.api,
    required this.leadId,
    required this.options,
    required this.current,
  });
  final ApiClient api;
  final String leadId;
  final List<Map<String, dynamic>> options;
  final List<Map<String, dynamic>> current;

  @override
  State<AddTagSheet> createState() => _AddTagSheetState();
}

class _AddTagSheetState extends State<AddTagSheet> {
  bool _saving = false;
  List<String> _errors = const [];

  Future<void> _add(String id) async {
    setState(() {
      _saving = true;
      _errors = const [];
    });
    try {
      await widget.api.post('/leads/${widget.leadId}/tags', {'tagId': id});
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _errors = e.allMessages);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final have = widget.current.map((t) => t['id']).toSet();
    final left = widget.options.where((t) => !have.contains(t['id'])).toList();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Add a tag',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 12),
          if (left.isEmpty)
            const Text(
              'This lead has every tag. Owners and Admins create tags on the website '
              '(Settings → Lead tags).',
              style: TextStyle(color: AppColors.muted),
            )
          else
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final t in left)
                  ActionChip(
                    avatar: const Icon(Icons.sell_outlined, size: 16),
                    label: Text('#${t['name']}'),
                    onPressed: _saving ? null : () => _add(t['id'] as String),
                  ),
              ],
            ),
          FormErrors(_errors),
        ],
      ),
    );
  }
}

// --- One-tap call -----------------------------------------------------------------------------

/// Call a lead from a list (owner request 2026-11-24: Call on visit and My Day cards). The tap is
/// recorded on the server first (POST /leads/:id/call-intents, the lead screen's rules: Do Not
/// Contact refused, an invalid number needs a confirmation), then the dialer opens. The call then
/// shows on My Day under calls with no outcome, ready to log.
Future<void> quickCall(
  BuildContext context,
  ApiClient api,
  String leadId, {
  bool confirmInvalid = false,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final r = await api.post('/leads/$leadId/call-intents', {
      'channel': 'PHONE_NATIVE',
      if (confirmInvalid) 'confirmInvalidNumber': true,
    }) as Map<String, dynamic>;
    final ok = await launchUrl(
      Uri.parse(r['href'] as String),
      mode: LaunchMode.externalApplication,
    );
    if (!ok) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Could not open the dialer')),
      );
    }
  } on ApiException catch (e) {
    if (e.fieldErrors.containsKey('confirmInvalidNumber') && context.mounted) {
      final go = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: const Text('Number marked invalid'),
          content: Text(e.allMessages.join('\n')),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(c, true),
              child: const Text('Try anyway'),
            ),
          ],
        ),
      );
      if (go == true && context.mounted) {
        return quickCall(context, api, leadId, confirmInvalid: true);
      }
      return;
    }
    messenger.showSnackBar(SnackBar(content: Text(e.allMessages.join('\n'))));
  }
}
