import 'package:material_ui/material_ui.dart';

import '../session.dart';
import '../theme.dart';
import 'auth_screens.dart';
import 'leads_screen.dart';
import 'more_screen.dart';
import 'my_day_screen.dart';

class _Tab {
  const _Tab(this.label, this.icon, this.selectedIcon, this.build);
  final String label;
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

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

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
    );
    _Tab soon(String label, IconData icon, String path) => _Tab(
      label,
      icon,
      icon,
      () => ComingSoonScreen(title: label, webPath: path),
    );
    final visits = soon('Visits', Icons.place_outlined, '/app/visits');
    final calendar = soon(
      'Calendar',
      Icons.calendar_month_outlined,
      '/app/calendar',
    );
    final team = soon('Team', Icons.groups_outlined, '/app/dashboard');
    final inbox = soon('Inbox', Icons.notifications_none, '/app/notifications');
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
              icon: Icon(t.icon),
              selectedIcon: Icon(t.selectedIcon, color: AppColors.teal),
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
