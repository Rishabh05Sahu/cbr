import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../session.dart';
import '../theme.dart';
import 'lead_detail_screen.dart';
import 'lead_sheets.dart' show FormErrors;

/// New lead (POST /api/v1/leads), the website's "New lead" form for walk-ins and referrals
/// (FR-050). The server checks for an open lead with the same number (FR-052): then nothing is
/// created and the person can open the existing lead when it is theirs to see.
class NewLeadScreen extends StatefulWidget {
  const NewLeadScreen({super.key, required this.session});
  final Session session;

  @override
  State<NewLeadScreen> createState() => _NewLeadScreenState();
}

const _intents = {'HOT': 'Hot', 'WARM': 'Warm', 'COLD': 'Cold'};
const _transactions = {
  'BUY': 'Buy',
  'RENT': 'Rent',
  'LEASE_COMMERCIAL': 'Commercial lease',
  'SELL': 'Sell',
  'LET_OUT': 'Let out',
};
const _propertyTypes = {
  'APARTMENT': 'Apartment',
  'VILLA': 'Villa',
  'PLOT': 'Plot',
  'ROW_HOUSE': 'Townhouse',
  'OFFICE': 'Office',
  'SHOP': 'Shop',
  'WAREHOUSE': 'Warehouse',
  'OTHER': 'Other',
};

class _NewLeadScreenState extends State<NewLeadScreen> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _alt = TextEditingController();
  final _email = TextEditingController();
  final _bhk = TextEditingController();
  final _budgetMax = TextEditingController();
  final _city = TextEditingController();
  final _localities = TextEditingController();
  final _note = TextEditingController();
  String _source = '';
  String _intent = '';
  String _transaction = '';
  String _propertyType = '';
  List<Map<String, dynamic>> _sources = const [];
  bool _saving = false;
  List<String> _errors = const [];
  Map<String, List<String>> _fieldErrors = const {};

  ApiClient get _api => widget.session.api;

  @override
  void initState() {
    super.initState();
    _api
        .get('/lead-sources')
        .then((d) {
          if (!mounted) return;
          setState(
            () => _sources = ((d as Map)['sources'] as List)
                .cast<Map<String, dynamic>>(),
          );
        })
        .catchError((_) {});
  }

  @override
  void dispose() {
    for (final c in [
      _name,
      _phone,
      _alt,
      _email,
      _bhk,
      _budgetMax,
      _city,
      _localities,
      _note,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  String? _err(String f) => _fieldErrors[f]?.join(' ');

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _errors = const [];
      _fieldErrors = const {};
    });
    String t(TextEditingController c) => c.text.trim();
    try {
      final r = await _api.post('/leads', {
        'fullName': t(_name),
        'primaryPhone': t(_phone),
        'alternatePhone': t(_alt),
        'email': t(_email),
        'sourceId': _source,
        'intent': _intent,
        'transactionType': _transaction,
        'propertyType': _propertyType,
        'bhkMin': t(_bhk),
        'bhkMax': t(_bhk),
        'budgetMax': t(_budgetMax),
        'preferredCity': t(_city),
        'preferredLocalities': t(_localities),
        'note': t(_note),
      }) as Map<String, dynamic>;
      if (!mounted) return;
      if (r['status'] == 'created') {
        Navigator.of(context).pushReplacement(
          MaterialPageRoute<void>(
            builder: (_) => LeadDetailScreen(
              session: widget.session,
              leadId: r['leadId'] as String,
            ),
          ),
        );
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Lead added')));
        return;
      }
      await _duplicate(r);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _fieldErrors = e.fieldErrors;
          _errors = e.fieldErrors.isEmpty ? [e.message] : const [];
        });
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _duplicate(Map<String, dynamic> r) async {
    final id = r['leadId'] as String?;
    final archived = r['archived'] == true;
    final open = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('This number is already a lead'),
        content: Text(
          id == null
              ? 'Another open lead has this phone number. It belongs to someone else, so ask your manager to add the enquiry to it.'
              : archived
              ? 'An archived lead has this phone number. Open it to restore it instead of adding a new one.'
              : 'An open lead already has this phone number. Open it and log this enquiry there.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(c, false),
            child: const Text('Close'),
          ),
          if (id != null)
            FilledButton(
              onPressed: () => Navigator.pop(c, true),
              child: const Text('Open the lead'),
            ),
        ],
      ),
    );
    if (open == true && id != null && mounted) {
      Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => LeadDetailScreen(session: widget.session, leadId: id),
        ),
      );
    }
  }

  Widget _field(
    TextEditingController c,
    String label,
    String field, {
    TextInputType? keyboard,
    String? hint,
    int maxLines = 1,
    Key? key,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: TextField(
      key: key,
      controller: c,
      keyboardType: keyboard,
      maxLines: maxLines,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        errorText: _err(field),
      ),
    ),
  );

  Widget _choice(
    String label,
    Map<String, String> options,
    String value,
    ValueChanged<String> on,
  ) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: DropdownButtonFormField<String>(
      initialValue: value,
      decoration: InputDecoration(labelText: label),
      items: [
        const DropdownMenuItem(value: '', child: Text('—')),
        for (final e in options.entries)
          DropdownMenuItem(value: e.key, child: Text(e.value)),
      ],
      onChanged: (v) => setState(() => on(v ?? '')),
    ),
  );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('New lead')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const SectionLabel('Contact'),
          _field(_name, 'Name *', 'fullName', key: const Key('lead-name')),
          _field(
            _phone,
            'Mobile number *',
            'primaryPhone',
            keyboard: TextInputType.phone,
            hint: '+971 50 123 4567 or a 10-digit Indian number',
            key: const Key('lead-phone'),
          ),
          _field(
            _alt,
            'Other number',
            'alternatePhone',
            keyboard: TextInputType.phone,
          ),
          _field(
            _email,
            'Email',
            'email',
            keyboard: TextInputType.emailAddress,
          ),
          if (_sources.isNotEmpty)
            _choice(
              'Source',
              {
                for (final s in _sources)
                  s['id'] as String: s['name'] as String,
              },
              _source,
              (v) => _source = v,
            ),
          const SizedBox(height: 8),
          const SectionLabel('What they want'),
          _choice('Interest', _intents, _intent, (v) => _intent = v),
          _choice(
            'Looking to',
            _transactions,
            _transaction,
            (v) => _transaction = v,
          ),
          _choice(
            'Property type',
            _propertyTypes,
            _propertyType,
            (v) => _propertyType = v,
          ),
          _field(_bhk, 'Bedrooms', 'bhkMin', keyboard: TextInputType.number),
          _field(
            _budgetMax,
            'Budget (AED)',
            'budgetMax',
            keyboard: TextInputType.number,
            hint: 'e.g. 2500000 or 2.5M',
          ),
          _field(_city, 'City', 'preferredCity', hint: 'Dubai'),
          _field(
            _localities,
            'Areas',
            'preferredLocalities',
            hint: 'Marina, JLT',
          ),
          _field(_note, 'Note', 'note', maxLines: 3),
          FormErrors(_errors),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_saving ? 'Adding…' : 'Add lead'),
          ),
          const SizedBox(height: 8),
          const Text(
            'The lead is yours. A manager can reassign it.',
            textAlign: TextAlign.center,
            style: TextStyle(color: AppColors.muted, fontSize: 13),
          ),
        ],
      ),
    );
  }
}
