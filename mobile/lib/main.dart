import 'package:material_ui/material_ui.dart';

import 'push.dart';
import 'screens/auth_screens.dart';
import 'screens/home_shell.dart';
import 'session.dart';
import 'theme.dart';
import 'app_lock.dart';
import 'privacy_cover.dart';

final _navigatorKey = GlobalKey<NavigatorState>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final session = Session();
  final push = Push(_navigatorKey);
  session.push = push;
  // Firebase first (fast, local), so a tap that launched the app is not lost.
  await push.init(session);
  await session.lock.init();
  session.start();
  runApp(CrmApp(session: session, navigatorKey: _navigatorKey));
}

/// CBR Property CRM for Android and iPhone (ADR-0027). Same backend and database as the website.
class CrmApp extends StatelessWidget {
  const CrmApp({super.key, required this.session, this.navigatorKey});
  final Session session;
  final GlobalKey<NavigatorState>? navigatorKey;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: navigatorKey,
      // Fingerprint unlock covers every screen, pushed ones included.
      builder: (context, child) => ListenableBuilder(
        listenable: Listenable.merge([session, session.lock]),
        builder: (context, _) => PrivacyCover(
          child: Stack(
            children: [
              ?child,
              if (session.lock.locked && session.status == SessionStatus.ready)
                LockScreen(lock: session.lock),
            ],
          ),
        ),
      ),
      title: 'CBR CRM',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: ListenableBuilder(
        listenable: session,
        builder: (context, _) => switch (session.status) {
          SessionStatus.loading => const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          ),
          SessionStatus.signedOut => LoginScreen(
            key: const ValueKey('login'),
            session: session,
          ),
          SessionStatus.twoFactor => TwoFactorScreen(session: session),
          SessionStatus.chooseOrg => SelectOrgScreen(session: session),
          SessionStatus.blocked => BlockedScreen(session: session),
          // Keyed by organisation: switching rebuilds every tab with the new data.
          SessionStatus.ready => HomeShell(
            key: ValueKey(session.me?.active?['orgId']),
            session: session,
          ),
        },
      ),
    );
  }
}

/// Shown over the app while it is locked: asks for the fingerprint, face or screen lock.
class LockScreen extends StatefulWidget {
  const LockScreen({super.key, required this.lock});
  final AppLock lock;

  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => widget.lock.unlock());
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.bg,
      child: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.lock_outline, size: 56, color: AppColors.teal),
              const SizedBox(height: 12),
              const Text(
                'CBR CRM is locked',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 20),
              FilledButton.icon(
                onPressed: widget.lock.unlock,
                icon: const Icon(Icons.fingerprint),
                label: const Text('Unlock'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
