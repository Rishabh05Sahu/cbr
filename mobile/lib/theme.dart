import 'package:material_ui/material_ui.dart';

/// Colours from the approved app design.
class AppColors {
  static const teal = Color(0xFF0B5F66);
  static const tealDark = Color(0xFF084A50);
  static const tealSoft = Color(0xFFE6F2F2);
  static const bg = Color(0xFFF5F6F8);
  static const card = Colors.white;
  static const border = Color(0xFFE4E7EC);
  static const text = Color(0xFF101828);
  static const muted = Color(0xFF475467);
  static const red = Color(0xFFB42318);
  static const redSoft = Color(0xFFFDECEC);
  static const warn = Color(0xFF93370D);
  static const warnSoft = Color(0xFFFEF0E6);
  static const graySoft = Color(0xFFF2F4F7);
  static const gray = Color(0xFF344054);
}

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: AppColors.teal,
    primary: AppColors.teal,
    surface: AppColors.bg,
    error: AppColors.red,
  );
  final shape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(12));
  return ThemeData(
    colorScheme: scheme,
    scaffoldBackgroundColor: AppColors.bg,
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.white,
      foregroundColor: AppColors.text,
      elevation: 0,
      scrolledUnderElevation: 0.5,
      titleTextStyle: TextStyle(
        fontSize: 20,
        fontWeight: FontWeight.w700,
        color: AppColors.text,
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(52),
        shape: shape,
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(44, 48),
        shape: shape,
        side: const BorderSide(color: Color(0xFFD0D5DD)),
        textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: Color(0xFFD0D5DD)),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: Color(0xFFD0D5DD)),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: Colors.white,
      indicatorColor: AppColors.tealSoft,
      labelTextStyle: WidgetStateProperty.resolveWith(
        (s) => TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w600,
          color: s.contains(WidgetState.selected)
              ? AppColors.teal
              : AppColors.muted,
        ),
      ),
    ),
    chipTheme: const ChipThemeData(
      side: BorderSide(color: Color(0xFFD0D5DD)),
      selectedColor: AppColors.tealSoft,
    ),
  );
}

/// White rounded card with the design's border.
class AppCard extends StatelessWidget {
  const AppCard({super.key, required this.child, this.onTap, this.padding});

  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: AppColors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: padding ?? const EdgeInsets.all(12),
          child: child,
        ),
      ),
    );
  }
}

/// Small rounded status label.
class Pill extends StatelessWidget {
  const Pill(
    this.text, {
    super.key,
    this.bg = AppColors.graySoft,
    this.fg = AppColors.gray,
  });

  final String text;
  final Color bg;
  final Color fg;

  factory Pill.red(String t) =>
      Pill(t, bg: AppColors.redSoft, fg: AppColors.red);
  factory Pill.warn(String t) =>
      Pill(t, bg: AppColors.warnSoft, fg: AppColors.warn);
  factory Pill.teal(String t) =>
      Pill(t, bg: AppColors.tealSoft, fg: AppColors.teal);

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        text,
        style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: fg),
      ),
    );
  }
}

/// Upper-case section label, optionally with a count.
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key, this.count, this.countPill});

  final String text;
  final int? count;
  final Pill? countPill;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 8),
      child: Row(
        children: [
          Text(
            text.toUpperCase(),
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              letterSpacing: .5,
              color: AppColors.muted,
            ),
          ),
          if (countPill != null) ...[const SizedBox(width: 8), countPill!],
          if (countPill == null && count != null) ...[
            const SizedBox(width: 8),
            Pill('$count'),
          ],
        ],
      ),
    );
  }
}

/// A full-screen message with a retry button (errors, empty states).
class MessageView extends StatelessWidget {
  const MessageView({
    super.key,
    required this.message,
    this.onRetry,
    this.icon,
  });

  final String message;
  final VoidCallback? onRetry;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon ?? Icons.info_outline, size: 40, color: AppColors.muted),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColors.muted),
            ),
            if (onRetry != null) ...[
              const SizedBox(height: 16),
              OutlinedButton(
                onPressed: onRetry,
                child: const Text('Try again'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
