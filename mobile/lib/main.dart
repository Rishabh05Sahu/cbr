import 'package:material_ui/material_ui.dart';

import 'screens/auth_screens.dart';
import 'screens/home_shell.dart';
import 'session.dart';
import 'theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final session = Session()..start();
  runApp(CrmApp(session: session));
}

/// CBR Property CRM for Android (ADR-0027). Same backend and database as the website.
class CrmApp extends StatelessWidget {
  const CrmApp({super.key, required this.session});
  final Session session;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
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
