import 'package:material_ui/material_ui.dart';

import '../format.dart';
import '../session.dart';
import '../theme.dart';
import 'auth_screens.dart';
import 'notifications_screen.dart';

/// More: who is signed in, switch organisation, website links, sign out.
class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key, required this.session});
  final Session session;

  @override
  Widget build(BuildContext context) {
    final me = session.me!;
    Widget item(
      IconData icon,
      String text,
      VoidCallback onTap, {
      Widget? trailing,
    }) => ListTile(
      leading: Icon(icon, color: AppColors.teal),
      title: Text(text, style: const TextStyle(fontWeight: FontWeight.w500)),
      trailing:
          trailing ?? const Icon(Icons.chevron_right, color: Color(0xFF98A2B3)),
      onTap: onTap,
    );
    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'More',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          AppCard(
            child: Row(
              children: [
                CircleAvatar(
                  radius: 24,
                  backgroundColor: AppColors.tealSoft,
                  child: Text(
                    me.name.isEmpty ? '?' : me.name[0].toUpperCase(),
                    style: const TextStyle(
                      color: AppColors.teal,
                      fontWeight: FontWeight.w700,
                      fontSize: 18,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        me.name,
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      Text(
                        '${label(roleLabels, me.role)} · ${me.orgName}',
                        style: const TextStyle(color: AppColors.muted),
                      ),
                      Text(
                        me.email,
                        style: const TextStyle(
                          color: AppColors.muted,
                          fontSize: 13,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                if (me.memberships.length > 1)
                  item(
                    Icons.swap_horiz,
                    'Switch organisation',
                    session.switchOrg,
                  ),
                if (me.can('property.read'))
                  item(
                    Icons.home_work_outlined,
                    'Properties',
                    () => openWebsite('/app/properties'),
                    trailing: const Icon(Icons.open_in_new, size: 18),
                  ),
                if (me.can('script.read'))
                  item(
                    Icons.description_outlined,
                    'Call scripts',
                    () => openWebsite('/app/scripts'),
                    trailing: const Icon(Icons.open_in_new, size: 18),
                  ),
                if (me.can('report.read'))
                  item(
                    Icons.bar_chart,
                    'Dashboard',
                    () => openWebsite('/app/dashboard'),
                    trailing: const Icon(Icons.open_in_new, size: 18),
                  ),
                item(
                  Icons.notifications_none,
                  'Notifications',
                  () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => NotificationsScreen(session: session),
                    ),
                  ),
                  trailing: ValueListenableBuilder<int>(
                    valueListenable: session.unread,
                    builder: (_, n, _) => Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (n > 0)
                          Badge(
                            label: Text(n > 99 ? '99+' : '$n'),
                            backgroundColor: AppColors.red,
                          ),
                        const Icon(
                          Icons.chevron_right,
                          color: Color(0xFF98A2B3),
                        ),
                      ],
                    ),
                  ),
                ),
                item(
                  Icons.shield_outlined,
                  'Profile and security',
                  () => openWebsite('/app/security/two-factor'),
                  trailing: const Icon(Icons.open_in_new, size: 18),
                ),
                item(
                  Icons.language,
                  'Open the website',
                  () => openWebsite('/app'),
                  trailing: const Icon(Icons.open_in_new, size: 18),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                item(
                  Icons.privacy_tip_outlined,
                  'Privacy policy',
                  () => openWebsite('/privacy'),
                  trailing: const Icon(Icons.open_in_new, size: 18),
                ),
                item(
                  Icons.person_remove_outlined,
                  'Delete my account',
                  () => openWebsite('/account-deletion'),
                  trailing: const Icon(Icons.open_in_new, size: 18),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          OutlinedButton.icon(
            style: OutlinedButton.styleFrom(
              foregroundColor: AppColors.red,
              minimumSize: const Size.fromHeight(52),
            ),
            onPressed: () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (c) => AlertDialog(
                  title: const Text('Sign out?'),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(c, false),
                      child: const Text('Cancel'),
                    ),
                    FilledButton(
                      onPressed: () => Navigator.pop(c, true),
                      child: const Text('Sign out'),
                    ),
                  ],
                ),
              );
              if (ok == true) await session.signOut();
            },
            icon: const Icon(Icons.logout),
            label: const Text('Sign out'),
          ),
        ],
      ),
    );
  }
}
