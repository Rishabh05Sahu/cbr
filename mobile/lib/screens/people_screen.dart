import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import 'lead_sheets.dart' show FormErrors;

String roleName(String? pluginRole) =>
    label(roleLabels, (pluginRole ?? '').toUpperCase());

/// People: members of the organisation in the caller's scope; for Owner/Admin, invite by email,
/// change role, suspend and reactivate, and cancel invitations. The same rules as the website's
/// Members page (an Admin cannot act on an Owner or Admin; the last Owner stays), checked again
/// by the server. Deactivating with a handover of leads stays on the website.
class PeopleScreen extends StatefulWidget {
  const PeopleScreen({super.key, required this.session});
  final Session session;

  @override
  State<PeopleScreen> createState() => _PeopleScreenState();
}

class _PeopleScreenState extends State<PeopleScreen> {
  Map<String, dynamic>? _data;
  String? _error;
  final _q = TextEditingController();

  ApiClient get _api => widget.session.api;
  Map<String, dynamic> get _can =>
      (_data?['can'] as Map?)?.cast<String, dynamic>() ?? const {};

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
      final d = await _api.get('/members') as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _data = d;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  void _toast(String t) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(t)));

  Future<void> _run(Future<dynamic> Function() call, String done) async {
    try {
      await call();
      _toast(done);
      await _load();
    } on ApiException catch (e) {
      _toast(e.allMessages.join(' '));
    }
  }

  Future<bool> _confirm(String title, String body, String action) async =>
      await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(c, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(c, true),
              child: Text(action),
            ),
          ],
        ),
      ) ==
      true;

  Future<void> _memberActions(Map<String, dynamic> m) async {
    final me = widget.session.me!;
    final self = m['userId'] == me.user['id'];
    final active = m['status'] == 'ACTIVE';
    final id = m['membershipId'] as String;
    final roles = ((_data!['grantableRoles'] as List?) ?? const [])
        .cast<String>();
    final choice = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              title: Text(
                m['name'] as String? ?? '',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              subtitle: Text(
                '${m['email']} · ${roleName(m['role'] as String?)}',
              ),
            ),
            if (_can['changeRole'] == true && !self && active)
              ListTile(
                leading: const Icon(Icons.badge_outlined),
                title: const Text('Change role'),
                onTap: () => Navigator.pop(c, 'role'),
              ),
            if (_can['suspend'] == true && !self && active)
              ListTile(
                leading: const Icon(Icons.block, color: AppColors.red),
                title: const Text('Suspend'),
                onTap: () => Navigator.pop(c, 'suspend'),
              ),
            if (_can['suspend'] == true && !self && !active)
              ListTile(
                leading: const Icon(Icons.restart_alt),
                title: const Text('Reactivate'),
                onTap: () => Navigator.pop(c, 'reactivate'),
              ),
          ],
        ),
      ),
    );
    if (!mounted || choice == null) return;
    switch (choice) {
      case 'role':
        final role = await showDialog<String>(
          context: context,
          builder: (c) => SimpleDialog(
            title: Text('Role for ${m['name']}'),
            children: [
              for (final r in roles)
                SimpleDialogOption(
                  onPressed: () => Navigator.pop(c, r),
                  child: Text(
                    roleName(r),
                    style: TextStyle(
                      fontWeight: r == m['role']
                          ? FontWeight.w700
                          : FontWeight.w400,
                    ),
                  ),
                ),
            ],
          ),
        );
        if (role != null && role != m['role']) {
          await _run(
            () => _api.post('/members/$id/role', {'role': role}),
            'Role changed to ${roleName(role)}',
          );
        }
      case 'suspend':
        if (await _confirm(
          'Suspend ${m['name']}?',
          'They can no longer sign in to this organisation. Their leads stay with them until you reassign them.',
          'Suspend',
        )) {
          await _run(() => _api.post('/members/$id/suspend'), 'Suspended');
        }
      case 'reactivate':
        await _run(() => _api.post('/members/$id/reactivate'), 'Reactivated');
    }
  }

  Future<void> _invite() async {
    final sent = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => _InviteSheet(
        api: _api,
        roles: ((_data!['grantableRoles'] as List?) ?? const []).cast<String>(),
        teams: ((_data!['teams'] as List?) ?? const [])
            .cast<Map<String, dynamic>>(),
      ),
    );
    if (sent == true) {
      _toast('Invitation sent');
      await _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _data;
    Widget body;
    if (d == null) {
      body = _error == null
          ? const Center(child: CircularProgressIndicator())
          : MessageView(message: _error!, onRetry: _load);
    } else {
      final q = _q.text.trim().toLowerCase();
      final members = (d['members'] as List)
          .cast<Map<String, dynamic>>()
          .where(
            (m) =>
                q.isEmpty ||
                '${m['name']} ${m['email']}'.toLowerCase().contains(q),
          )
          .toList();
      final invitations = (d['invitations'] as List)
          .cast<Map<String, dynamic>>();
      body = RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 90),
          children: [
            TextField(
              controller: _q,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Name or email',
              ),
            ),
            SectionLabel('Members', count: members.length),
            for (final m in members)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: AppCard(
                  onTap: () => _memberActions(m),
                  child: Row(
                    children: [
                      CircleAvatar(
                        backgroundColor: AppColors.tealSoft,
                        child: Text(
                          '${m['name'] ?? '?'}'.isEmpty
                              ? '?'
                              : '${m['name']}'[0].toUpperCase(),
                          style: const TextStyle(color: AppColors.teal),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              m['name'] as String? ?? '',
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            Text(
                              [
                                roleName(m['role'] as String?),
                                ...((m['teams'] as List?) ?? const [])
                                    .cast<String>(),
                              ].join(' · '),
                              style: const TextStyle(
                                color: AppColors.muted,
                                fontSize: 13,
                              ),
                            ),
                          ],
                        ),
                      ),
                      if (m['status'] != 'ACTIVE')
                        Pill.red(
                          m['status'] == 'SUSPENDED' ? 'Suspended' : 'Inactive',
                        ),
                    ],
                  ),
                ),
              ),
            if (invitations.isNotEmpty) ...[
              SectionLabel('Pending invitations', count: invitations.length),
              for (final i in invitations)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: AppCard(
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(i['email'] as String? ?? ''),
                              Text(
                                roleName(i['role'] as String?),
                                style: const TextStyle(
                                  color: AppColors.muted,
                                  fontSize: 13,
                                ),
                              ),
                            ],
                          ),
                        ),
                        TextButton(
                          onPressed: () async {
                            if (await _confirm(
                              'Cancel this invitation?',
                              '${i['email']} will not be able to join with it.',
                              'Cancel invitation',
                            )) {
                              await _run(
                                () =>
                                    _api.post('/invitations/${i['id']}/cancel'),
                                'Invitation cancelled',
                              );
                            }
                          },
                          child: const Text('Cancel'),
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
      appBar: AppBar(
        title: const Text(
          'People',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
        ),
      ),
      floatingActionButton: _can['invite'] == true
          ? FloatingActionButton.extended(
              heroTag: 'people-invite',
              onPressed: _invite,
              icon: const Icon(Icons.person_add_alt),
              label: const Text('Invite'),
            )
          : null,
      body: body,
    );
  }
}

class _InviteSheet extends StatefulWidget {
  const _InviteSheet({
    required this.api,
    required this.roles,
    required this.teams,
  });
  final ApiClient api;
  final List<String> roles;
  final List<Map<String, dynamic>> teams;

  @override
  State<_InviteSheet> createState() => _InviteSheetState();
}

class _InviteSheetState extends State<_InviteSheet> {
  final _email = TextEditingController();
  late String _role = widget.roles.contains('sales_executive')
      ? 'sales_executive'
      : widget.roles.first;
  String _team = '';
  bool _saving = false;
  List<String> _errors = const [];

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    setState(() {
      _saving = true;
      _errors = const [];
    });
    try {
      await widget.api.post('/members', {
        'email': _email.text.trim(),
        'role': _role,
        'teamId': _team,
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
    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          const Text(
            'Invite someone',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _email,
            keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(labelText: 'Work email'),
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _role,
            decoration: const InputDecoration(labelText: 'Role'),
            items: [
              for (final r in widget.roles)
                DropdownMenuItem(value: r, child: Text(roleName(r))),
            ],
            onChanged: (v) => setState(() => _role = v ?? _role),
          ),
          if (widget.teams.isNotEmpty) ...[
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: _team,
              decoration: const InputDecoration(labelText: 'Team'),
              items: [
                const DropdownMenuItem(value: '', child: Text('No team')),
                for (final t in widget.teams)
                  DropdownMenuItem(
                    value: t['id'] as String,
                    child: Text(t['name'] as String? ?? ''),
                  ),
              ],
              onChanged: (v) => setState(() => _team = v ?? ''),
            ),
          ],
          const SizedBox(height: 8),
          const Text(
            'They get an email with a link to join.',
            style: TextStyle(color: AppColors.muted, fontSize: 13),
          ),
          FormErrors(_errors),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _saving ? null : _send,
            child: Text(_saving ? 'Sending…' : 'Send invitation'),
          ),
        ],
      ),
    );
  }
}
