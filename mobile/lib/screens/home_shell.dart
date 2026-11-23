import 'dart:async';

import 'package:material_ui/material_ui.dart';

import '../session.dart';
import '../theme.dart';
import 'auth_screens.dart';
import 'leads_screen.dart';
import 'more_screen.dart';
import 'my_day_screen.dart';
import 'notifications_screen.dart';
import 'queue_screen.dart';
import 'visits_screen.dart';

class _Tab {
  const _Tab(
    this.label,
    this.icon,
    this.selectedIcon,
    this.build, {
    this.badge = false,
  });
  final String label;
  final bool badge;
  final IconData icon;
  final IconData selectedIcon;
  final Widget Function() build;
}

/// The signed-in app: bottom tabs built from the role and permissions (approved design).
///   Sales Executive  My Day · Leads · Visits · Calendar · More
///   Sales Manager    My Day · Leads · Team · Visits · More
///   Owner / Admin    My Day · Leads · Team · Inbox · More
///   HR / Ops         My Day · People · Inbox · More
/// Screens marked "next update" open a short note with a link to the same page on the website.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.session});
  final Session session;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  int _index = 0;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // While the app is open, check for new notifications every minute.
    _poll = Timer.periodic(const Duration(minutes: 1), (_) => _checkUnread());
    widget.session.unread.addListener(_onUnread);
    _lastUnread = widget.session.unread.value;
  }

  @override
  void dispose() {
    _poll?.cancel();
    widget.session.unread.removeListener(_onUnread);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _checkUnread();
  }

  Future<void> _checkUnread() => widget.session.refreshUnread();

  int _lastUnread = 0;

  /// The count went up: say so, with a shortcut to the list.
  void _onUnread() {
    final n = widget.session.unread.value;
    final grew = n > _lastUnread;
    _lastUnread = n;
    if (!grew || !mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(
            n == 1
                ? 'You have a new notification'
                : 'You have $n unread notifications',
          ),
          action: SnackBarAction(
            label: 'View',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => NotificationsScreen(session: widget.session),
              ),
            ),
          ),
        ),
      );
  }

  List<_Tab> _tabs(Me me) {
    final s = widget.session;
    final myDay = _Tab(
      'My Day',
      Icons.check_box_outlined,
      Icons.check_box,
      () => MyDayScreen(session: s),
    );
    final leads = _Tab(
      'Leads',
      Icons.list_alt_outlined,
      Icons.list_alt,
      () => LeadsScreen(session: s),
    );
    final more = _Tab(
      'More',
      Icons.menu,
      Icons.menu,
      () => MoreScreen(session: s),
      badge: !_hasInbox(me),
    );
    _Tab soon(String label, IconData icon, String path) => _Tab(
      label,
      icon,
      icon,
      () => ComingSoonScreen(title: label, webPath: path),
    );
    final visits = _Tab(
      'Visits',
      Icons.place_outlined,
      Icons.place,
      () => VisitsScreen(session: s),
    );
    final calendar = soon(
      'Calendar',
      Icons.calendar_month_outlined,
      '/app/calendar',
    );
    final team = _Tab(
      'Team',
      Icons.groups_outlined,
      Icons.groups,
      () => TeamScreen(session: s, openWebsite: openWebsite),
    );
    final inbox = _Tab(
      'Inbox',
      Icons.notifications_none,
      Icons.notifications,
      () => NotificationsScreen(session: s),
      badge: true,
    );
    final people = soon(
      'People',
      Icons.groups_outlined,
      '/app/settings/members',
    );

    final tabs = <_Tab>[];
    if (me.can('task.read')) tabs.add(myDay);
    if (me.can('lead.read')) tabs.add(leads);
    switch (me.role) {
      case 'SALES_EXECUTIVE':
        tabs.addAll([if (me.can('site_visit.read')) visits, calendar]);
      case 'SALES_MANAGER':
        tabs.addAll([team, if (me.can('site_visit.read')) visits]);
      case 'OWNER' || 'ADMIN':
        tabs.addAll([team, inbox]);
      case 'HR_OPS':
        tabs.addAll([people, inbox]);
    }
    tabs.add(more);
    return tabs;
  }

  Widget _withBadge(_Tab t, Widget icon) {
    if (!t.badge) return icon;
    return ValueListenableBuilder<int>(
      valueListenable: widget.session.unread,
      builder: (_, n, child) => Badge(
        isLabelVisible: n > 0,
        label: Text(n > 99 ? '99+' : '$n'),
        backgroundColor: AppColors.red,
        child: child,
      ),
      child: icon,
    );
  }

  /// Owner, Admin and HR have an Inbox tab; everyone else reaches notifications from the bell
  /// and More, so More carries the badge.
  static bool _hasInbox(Me me) =>
      const {'OWNER', 'ADMIN', 'HR_OPS'}.contains(me.role);

  @override
  Widget build(BuildContext context) {
    final me = widget.session.me!;
    final tabs = _tabs(me);
    if (_index >= tabs.length) _index = 0;
    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: [for (final t in tabs) t.build()],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: [
          for (final t in tabs)
            NavigationDestination(
              icon: _withBadge(t, Icon(t.icon)),
              selectedIcon: _withBadge(
                t,
                Icon(t.selectedIcon, color: AppColors.teal),
              ),
              label: t.label,
            ),
        ],
      ),
    );
  }
}

/// A tab from the design that is not built yet: says so, and opens the same page on the website.
class ComingSoonScreen extends StatelessWidget {
  const ComingSoonScreen({
    super.key,
    required this.title,
    required this.webPath,
  });
  final String title;
  final String webPath;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.construction_outlined,
                size: 44,
                color: AppColors.muted,
              ),
              const SizedBox(height: 12),
              Text(
                '$title is coming in the next app update.',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                'Until then, use it on the website.',
                textAlign: TextAlign.center,
                style: TextStyle(color: AppColors.muted),
              ),
              const SizedBox(height: 20),
              OutlinedButton.icon(
                onPressed: () => openWebsite(webPath),
                icon: const Icon(Icons.open_in_new, size: 18),
                label: const Text('Open on the website'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
