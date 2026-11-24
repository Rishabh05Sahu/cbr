import 'package:crm/privacy_cover.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

Future<void> _lifecycle(WidgetTester t, AppLifecycleState s) async {
  t.binding.handleAppLifecycleStateChanged(s);
  await t.pump();
}

void main() {
  testWidgets('covers the app while it is in the app switcher, when on', (
    t,
  ) async {
    await t.pumpWidget(
      const MaterialApp(
        home: PrivacyCover(enabled: true, child: Text('Priya +971500000001')),
      ),
    );
    final cover = find.byKey(const ValueKey('privacy-cover'));
    expect(cover, findsNothing);
    await _lifecycle(t, AppLifecycleState.inactive);
    expect(cover, findsOneWidget);
    await _lifecycle(t, AppLifecycleState.hidden);
    await _lifecycle(t, AppLifecycleState.paused);
    expect(cover, findsOneWidget);
    await _lifecycle(t, AppLifecycleState.hidden);
    await _lifecycle(t, AppLifecycleState.inactive);
    await _lifecycle(t, AppLifecycleState.resumed);
    expect(cover, findsNothing);
  });

  testWidgets('does nothing when off (Android, debug builds)', (t) async {
    await t.pumpWidget(
      const MaterialApp(
        home: PrivacyCover(enabled: false, child: Text('Priya')),
      ),
    );
    await _lifecycle(t, AppLifecycleState.inactive);
    expect(find.byKey(const ValueKey('privacy-cover')), findsNothing);
    await _lifecycle(t, AppLifecycleState.resumed);
  });

  test('off by default in tests and debug builds', () {
    expect(const PrivacyCover(child: null).active, isFalse);
  });
}
