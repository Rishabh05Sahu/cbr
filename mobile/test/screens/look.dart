// Shared set-up for the screenshot tests: the real Roboto and Material Icons fonts from the Flutter
// SDK and the app theme, so goldens look like the phone. Refresh with
// `flutter test --update-goldens test/screens`.
import 'dart:io';

import 'package:crm/theme.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

Future<void> _font(String family, List<String> files) async {
  final root =
      '${Platform.environment['FLUTTER_ROOT'] ?? 'C:/flutter'}'
      '/bin/cache/artifacts/material_fonts';
  final loader = FontLoader(family);
  for (final f in files) {
    final file = File('$root/$f');
    if (file.existsSync()) {
      loader.addFont(
        Future.value(ByteData.sublistView(file.readAsBytesSync())),
      );
    }
  }
  await loader.load();
}

/// Loads the fonts and sets a 360 × [height] dp phone screen.
Future<void> phone(WidgetTester t, {double height = 780}) async {
  await _font('Roboto', [
    'roboto-regular.ttf',
    'roboto-medium.ttf',
    'roboto-bold.ttf',
  ]);
  await _font('MaterialIcons', ['materialicons-regular.otf']);
  t.view.physicalSize = Size(1080, height * 3);
  t.view.devicePixelRatio = 3;
  addTearDown(t.view.reset);
}

/// The app theme with Roboto everywhere (tests have no system font).
ThemeData lookTheme() {
  final base = buildTheme();
  return base.copyWith(
    textTheme: base.textTheme.apply(fontFamily: 'Roboto'),
    appBarTheme: base.appBarTheme.copyWith(
      titleTextStyle: base.appBarTheme.titleTextStyle?.copyWith(
        fontFamily: 'Roboto',
      ),
    ),
  );
}
