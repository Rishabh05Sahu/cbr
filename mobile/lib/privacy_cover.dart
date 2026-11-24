import 'package:flutter/foundation.dart';
import 'package:material_ui/material_ui.dart';

import 'theme.dart';

/// iPhone: hides the CRM's contents in the app switcher.
///
/// Android release builds block screenshots and the recent-apps preview with FLAG_SECURE
/// (MainActivity.kt, ADR-0027). iOS has no such switch: apps cannot block screenshots. The
/// app-switcher snapshot is taken after the app goes inactive, so a plain cover shown while
/// the app is not in the foreground keeps lead names and numbers out of it.
/// Off on Android and in debug builds, like FLAG_SECURE.
class PrivacyCover extends StatefulWidget {
  const PrivacyCover({super.key, required this.child, this.enabled});

  final Widget? child;

  /// Tests set this; otherwise the cover is on in iPhone release builds only.
  final bool? enabled;

  bool get active =>
      enabled ?? (kReleaseMode && defaultTargetPlatform == TargetPlatform.iOS);

  @override
  State<PrivacyCover> createState() => _PrivacyCoverState();
}

class _PrivacyCoverState extends State<PrivacyCover> {
  AppLifecycleListener? _listener;
  bool _covered = false;

  @override
  void initState() {
    super.initState();
    if (widget.active) {
      _listener = AppLifecycleListener(onStateChange: _changed);
    }
  }

  void _changed(AppLifecycleState state) {
    final cover = state != AppLifecycleState.resumed;
    if (cover != _covered && mounted) setState(() => _covered = cover);
  }

  @override
  void dispose() {
    _listener?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        ?widget.child,
        if (_covered)
          const Positioned.fill(
            child: ColoredBox(
              key: ValueKey('privacy-cover'),
              color: AppColors.bg,
              child: Center(
                child: Icon(
                  Icons.lock_outline,
                  size: 56,
                  color: AppColors.teal,
                ),
              ),
            ),
          ),
      ],
    );
  }
}
