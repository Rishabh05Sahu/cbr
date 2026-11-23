import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api/api_client.dart';

/// Call outcomes saved on the phone while it had no signal, sent later (app 1.0.4).
///
/// Each entry is the exact body the outcome sheet would have posted to /api/v1/interactions,
/// with its idempotency key, so sending it twice never logs the call twice. Kept in Android's
/// encrypted storage (notes are personal data) and only for the signed-in person: signing out
/// clears it.
///
/// An entry the server refuses (for example the lead changed meanwhile) is dropped and reported
/// in [failed], so the person can log it again by hand; "no connection" and server errors keep
/// it for the next try.
class Outbox extends ChangeNotifier {
  Outbox(this._api, {FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final ApiClient _api;
  final FlutterSecureStorage _storage;
  static const _key = 'outbox_interactions_v1';

  final List<Map<String, dynamic>> _items = [];

  /// Leads whose queued outcome the server refused (name for the message).
  final List<String> failed = [];
  bool _loaded = false;
  bool _sending = false;

  int get pending => _items.length;

  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    final raw = await _storage.read(key: _key);
    if (raw == null) return;
    try {
      _items.addAll((jsonDecode(raw) as List).cast<Map<String, dynamic>>());
    } catch (_) {
      await _storage.delete(key: _key);
    }
    notifyListeners();
  }

  Future<void> _save() async {
    if (_items.isEmpty) {
      await _storage.delete(key: _key);
    } else {
      await _storage.write(key: _key, value: jsonEncode(_items));
    }
    notifyListeners();
  }

  /// Keeps an outcome to send later. [leadName] is only for messages on this phone.
  Future<void> add(
    Map<String, dynamic> body, {
    required String leadName,
  }) async {
    await load();
    _items.add({'body': body, 'leadName': leadName});
    await _save();
  }

  /// Sends what is waiting, oldest first. Stops at the first "no connection".
  Future<int> flush() async {
    await load();
    if (_sending || _items.isEmpty || _api.token == null) return 0;
    _sending = true;
    var sent = 0;
    try {
      while (_items.isNotEmpty) {
        final item = _items.first;
        try {
          await _api.post(
            '/interactions',
            (item['body'] as Map).cast<String, dynamic>(),
          );
          sent++;
        } on ApiException catch (e) {
          if (e.status == 0 || e.status >= 500 || e.status == 429) break;
          if (e.unauthenticated) break;
          // Refused for good (validation, conflict, no longer allowed): tell the person.
          failed.add(item['leadName'] as String? ?? 'a lead');
        }
        _items.removeAt(0);
        await _save();
      }
    } finally {
      _sending = false;
    }
    return sent;
  }

  /// Sign-out: nothing of this person stays on the phone.
  Future<void> clear() async {
    _items.clear();
    failed.clear();
    await _storage.delete(key: _key);
    notifyListeners();
  }
}
