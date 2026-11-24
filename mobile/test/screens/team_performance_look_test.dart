// Renders Team performance at a common phone size (360 dp wide) with the real Roboto and Material
// Icons fonts and writes test/screens/goldens/team_performance*.png, so the layout can be looked
// at. Run with `flutter test --update-goldens test/screens/team_performance_look_test.dart`.
import 'package:crm/screens/team_performance_screen.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import '../team_performance_test.dart' show fakeSession, syntheticTeam;
import 'look.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  Widget app(double scale) => MaterialApp(
    theme: lookTheme(),
    debugShowCheckedModeBanner: false,
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context)
          .copyWith(textScaler: TextScaler.linear(scale)),
      child: child!,
    ),
    home: TeamPerformanceScreen(session: fakeSession(syntheticTeam())),
  );

  for (final (scale, suffix) in const [(1.0, ''), (1.3, '_large_text')]) {
    // Tall enough to show the totals and every card in one picture.
    testWidgets('Team performance on a phone, text × $scale', (t) async {
      await phone(t, height: scale == 1.0 ? 1500 : 1900);
      await t.pumpWidget(app(scale));
      await t.pumpAndSettle();
      await expectLater(
        find.byType(TeamPerformanceScreen),
        matchesGoldenFile('goldens/team_performance$suffix.png'),
      );
    });

    testWidgets('Team performance person sheet, text × $scale', (t) async {
      await phone(t);
      await t.pumpWidget(app(scale));
      await t.pumpAndSettle();
      await t.scrollUntilVisible(
        find.text('Chen Wei'),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await t.tap(find.text('Chen Wei'));
      await t.pumpAndSettle();
      await expectLater(
        find.byType(MaterialApp),
        matchesGoldenFile('goldens/team_performance_sheet$suffix.png'),
      );
    });
  }
}
