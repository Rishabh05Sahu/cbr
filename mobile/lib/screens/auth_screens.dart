import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart';
import '../config.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';

Future<void> openWebsite([String path = '']) => launchUrl(
  Uri.parse('$apiBaseUrl$path'),
  mode: LaunchMode.externalApplication,
);

class _ErrorText extends StatelessWidget {
  const _ErrorText(this.text);
  final String? text;

  @override
  Widget build(BuildContext context) {
    if (text == null) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.redSoft,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        text!,
        style: const TextStyle(
          color: AppColors.red,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}

/// Screen 1: email and password.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.session});
  final Session session;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _hide = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _error = widget.session.notice;
    widget.session.notice = null;
  }

  Future<void> _submit() async {
    if (_email.text.trim().isEmpty || _password.text.isEmpty) {
      setState(() => _error = 'Enter your email and password');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.session.signIn(_email.text, _password.text);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'No connection. Check your internet and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(24, 48, 24, 24),
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                color: AppColors.teal,
                borderRadius: BorderRadius.circular(16),
              ),
              alignment: Alignment.center,
              child: const Text(
                'CBR',
                style: TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w700,
                  fontSize: 18,
                ),
              ),
            ),
            const SizedBox(height: 20),
            const Text(
              'Sign in',
              style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            const Text(
              'CBR Property CRM',
              style: TextStyle(color: AppColors.muted),
            ),
            const SizedBox(height: 28),
            const Text(
              'Work email',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            TextField(
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              autofillHints: const [AutofillHints.email],
              textInputAction: TextInputAction.next,
            ),
            const SizedBox(height: 16),
            const Text(
              'Password',
              style: TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            TextField(
              controller: _password,
              obscureText: _hide,
              autofillHints: const [AutofillHints.password],
              onSubmitted: (_) => _submit(),
              decoration: InputDecoration(
                suffixIcon: IconButton(
                  tooltip: _hide ? 'Show password' : 'Hide password',
                  icon: Icon(
                    _hide
                        ? Icons.visibility_outlined
                        : Icons.visibility_off_outlined,
                  ),
                  onPressed: () => setState(() => _hide = !_hide),
                ),
              ),
            ),
            const SizedBox(height: 16),
            _ErrorText(_error),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _busy ? null : _submit,
              child: _busy
                  ? const SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(
                        strokeWidth: 2.5,
                        color: Colors.white,
                      ),
                    )
                  : const Text('Sign in'),
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: () => openWebsite('/forgot-password'),
              child: const Text('Forgot password?'),
            ),
            const SizedBox(height: 24),
            const Text(
              'Accounts are by invitation only. Ask your admin for an invite.',
              textAlign: TextAlign.center,
              style: TextStyle(color: AppColors.muted, fontSize: 13),
            ),
            TextButton(
              onPressed: () => openWebsite('/privacy'),
              child: const Text('Privacy policy'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Screen 2: the authenticator code (or a recovery code).
class TwoFactorScreen extends StatefulWidget {
  const TwoFactorScreen({super.key, required this.session});
  final Session session;

  @override
  State<TwoFactorScreen> createState() => _TwoFactorScreenState();
}

class _TwoFactorScreenState extends State<TwoFactorScreen> {
  final _code = TextEditingController();
  bool _recovery = false;
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    final code = _code.text.trim();
    if (code.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.session.verifySecondFactor(code, recoveryCode: _recovery);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back to sign in',
          icon: const Icon(Icons.arrow_back),
          onPressed: widget.session.signOut,
        ),
        title: const Text('Two-step verification'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Text(
            _recovery
                ? 'Enter one of your recovery codes. Each code works once.'
                : 'Enter the 6-digit code from your authenticator app.',
            style: const TextStyle(fontSize: 16),
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _code,
            autofocus: true,
            keyboardType: _recovery ? TextInputType.text : TextInputType.number,
            maxLength: _recovery ? 32 : 6,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 24,
              letterSpacing: 8,
              fontWeight: FontWeight.w600,
            ),
            onSubmitted: (_) => _submit(),
          ),
          _ErrorText(_error),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _busy ? null : _submit,
            child: const Text('Verify'),
          ),
          const SizedBox(height: 8),
          TextButton(
            onPressed: () => setState(() {
              _recovery = !_recovery;
              _code.clear();
              _error = null;
            }),
            child: Text(
              _recovery ? 'Use authenticator code' : 'Use a recovery code',
            ),
          ),
        ],
      ),
    );
  }
}

/// Screen 3: choose the organisation (only when the person belongs to more than one).
class SelectOrgScreen extends StatefulWidget {
  const SelectOrgScreen({super.key, required this.session});
  final Session session;

  @override
  State<SelectOrgScreen> createState() => _SelectOrgScreenState();
}

class _SelectOrgScreenState extends State<SelectOrgScreen> {
  String? _busyId;
  String? _error;

  Future<void> _pick(String orgId) async {
    setState(() {
      _busyId = orgId;
      _error = null;
    });
    try {
      await widget.session.chooseOrg(orgId);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final me = widget.session.me;
    final orgs = me?.memberships ?? const [];
    return Scaffold(
      appBar: AppBar(title: const Text('Choose organisation')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (me != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(
                'Signed in as ${me.email}',
                style: const TextStyle(color: AppColors.muted),
              ),
            ),
          for (final m in orgs) ...[
            AppCard(
              onTap: _busyId == null ? () => _pick(m['orgId'] as String) : null,
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          m['orgName'] as String,
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        Text(
                          label(roleLabels, m['role'] as String?),
                          style: const TextStyle(color: AppColors.muted),
                        ),
                      ],
                    ),
                  ),
                  if (_busyId == m['orgId'])
                    const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  else
                    const Icon(Icons.chevron_right, color: AppColors.muted),
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],
          _ErrorText(_error),
          const SizedBox(height: 16),
          OutlinedButton(
            onPressed: widget.session.signOut,
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
  }
}

/// Signed in, but the app cannot be used yet (2FA setup on the website, no membership, …).
class BlockedScreen extends StatelessWidget {
  const BlockedScreen({super.key, required this.session});
  final Session session;

  @override
  Widget build(BuildContext context) {
    final reason = session.me?.blocked;
    final (title, body, path) = switch (reason) {
      'TWO_FACTOR_REQUIRED' => (
        'Set up two-step verification',
        'Your role needs an authenticator app. Set it up on the website once, then sign in here again.',
        '/app/security/two-factor',
      ),
      'SUPPORT_ON_WEB' => (
        'Use the website',
        'Platform support access works on the website only.',
        '/platform',
      ),
      _ => (
        'No active organisation',
        'Your account is not an active member of any organisation. Ask your admin, or check the website.',
        '',
      ),
    };
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(Icons.lock_outline, size: 48, color: AppColors.teal),
              const SizedBox(height: 16),
              Text(
                title,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                body,
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.muted),
              ),
              const SizedBox(height: 24),
              FilledButton(
                onPressed: () => openWebsite(path),
                child: const Text('Open the website'),
              ),
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: session.refresh,
                child: const Text('I have done it, check again'),
              ),
              TextButton(
                onPressed: session.signOut,
                child: const Text('Sign out'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
