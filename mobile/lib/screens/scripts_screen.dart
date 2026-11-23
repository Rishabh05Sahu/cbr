import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../session.dart';
import '../theme.dart';

/// Call scripts (FR-094): the organisation's published scripts, readable during a call. The lead
/// screen already suggests the best match for each lead; this is the full library.
class ScriptsScreen extends StatefulWidget {
  const ScriptsScreen({super.key, required this.session});
  final Session session;

  @override
  State<ScriptsScreen> createState() => _ScriptsScreenState();
}

class _ScriptsScreenState extends State<ScriptsScreen> {
  List<Map<String, dynamic>>? _scripts;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d =
          await widget.session.api.get('/scripts') as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _scripts = (d['scripts'] as List).cast<Map<String, dynamic>>();
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _scripts;
    return Scaffold(
      appBar: AppBar(title: const Text('Call scripts')),
      body: s == null
          ? (_error == null
                ? const Center(child: CircularProgressIndicator())
                : MessageView(message: _error!, onRetry: _load))
          : s.isEmpty
          ? const MessageView(
              message:
                  'No published scripts yet. Admins write them on the website.',
              icon: Icons.description_outlined,
            )
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  for (final x in s)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: AppCard(
                        onTap: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => ScriptScreen(script: x),
                          ),
                        ),
                        child: Row(
                          children: [
                            const Icon(
                              Icons.description_outlined,
                              color: AppColors.teal,
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                x['name'] as String? ?? '',
                                style: const TextStyle(
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                            const Icon(
                              Icons.chevron_right,
                              color: Color(0xFF98A2B3),
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ),
    );
  }
}

/// One script, section by section (plain text of the published version).
class ScriptScreen extends StatelessWidget {
  const ScriptScreen({super.key, required this.script});
  final Map<String, dynamic> script;

  @override
  Widget build(BuildContext context) {
    final c = (script['content'] as Map?)?.cast<String, dynamic>() ?? const {};
    String text(String k) => ((c[k] as Map?)?['text'] as String? ?? '').trim();
    final objections = ((c['objections'] as List?) ?? const []).cast<Map>();
    Widget section(String title, String body) => body.isEmpty
        ? const SizedBox.shrink()
        : Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SectionLabel(title),
              AppCard(
                child: SelectableText(
                  body,
                  style: const TextStyle(height: 1.4),
                ),
              ),
            ],
          );
    return Scaffold(
      appBar: AppBar(title: Text(script['name'] as String? ?? 'Script')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
        children: [
          section('Opening', text('opening')),
          section('Questions to ask', text('questions')),
          section('Pitch', text('pitch')),
          section('Closing', text('closing')),
          if (objections.isNotEmpty) const SectionLabel('Objections'),
          for (final o in objections)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '“${o['objection'] ?? ''}”',
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 6),
                    SelectableText(
                      ((o['response'] as Map?)?['text'] as String? ?? '')
                          .trim(),
                      style: const TextStyle(height: 1.4),
                    ),
                  ],
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'Version ${script['versionNo'] ?? ''}',
              style: const TextStyle(color: AppColors.muted, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}
