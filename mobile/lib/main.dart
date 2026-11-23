import 'package:material_ui/material_ui.dart';

import 'push.dart';
import 'screens/auth_screens.dart';
import 'screens/home_shell.dart';
import 'session.dart';
import 'theme.dart';

final _navigatorKey = GlobalKey<NavigatorState>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final session = Session();
  final push = Push(_navigatorKey);
  session.push = push;
  // Firebase first (fast, local), so a tap that launched the app is not lost.
  await push.init(session);
  session.start();
  runApp(CrmApp(session: session, navigatorKey: _navigatorKey));
}

/// CBR Property CRM for Android (ADR-0027). Same backend and database as the website.
class CrmApp extends StatelessWidget {
  const CrmApp({super.key, required this.session, this.navigatorKey});
  final Session session;
  final GlobalKey<NavigatorState>? navigatorKey;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: navigatorKey,
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
