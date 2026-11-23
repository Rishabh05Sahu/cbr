import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';

import '../config.dart';

/// An error from the server, in the same shape as the website's form errors.
class ApiException implements Exception {
  ApiException(
    this.status,
    this.code,
    this.message, [
    this.fieldErrors = const {},
  ]);

  final int status;
  final String code;
  final String message;
  final Map<String, List<String>> fieldErrors;

  bool get unauthenticated => status == 401;

  /// Every message, field errors included, for showing under a form.
  List<String> get allMessages {
    final out = <String>[];
    for (final list in fieldErrors.values) {
      out.addAll(list);
    }
    return out.isEmpty ? [message] : out;
  }

  @override
  String toString() => message;
}

/// Result of the password step.
enum SignInStep { done, twoFactor }

/// HTTP client for the CRM (ADR-0027).
///
/// Sign-in goes through the normal `/api/auth/*` endpoints with the app's Origin; the session
/// token comes back in the `set-auth-token` header. Everything under `/api/v1` is called with
/// `Authorization: Bearer <token>` only. During the two-step verification the short-lived
/// two-factor cookie is kept in memory and dropped as soon as the token arrives.
class ApiClient {
  ApiClient({http.Client? httpClient, String? baseUrl})
    : _http = httpClient ?? http.Client(),
      baseUrl = baseUrl ?? apiBaseUrl;

  final http.Client _http;
  final String baseUrl;

  String? token;
  String? _twoFactorCookie;

  /// Called when the server says the session is gone (expired, signed out elsewhere).
  void Function()? onUnauthenticated;

  static final _twoFactorCookieRe = RegExp(
    r'((?:__Secure-)?cbr\.two_factor)=([^;,\s]*)',
  );

  Future<Map<String, dynamic>> _auth(
    String path,
    Map<String, dynamic> body,
  ) async {
    final headers = <String, String>{
      'content-type': 'application/json',
      'origin': appOrigin,
      if (token != null) 'authorization': 'Bearer $token',
      'cookie': ?_twoFactorCookie,
    };
    final res = await _http
        .post(
          Uri.parse('$baseUrl/api/auth$path'),
          headers: headers,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 30));
    final setCookie = res.headers['set-cookie'];
    if (setCookie != null) {
      final m = _twoFactorCookieRe.firstMatch(setCookie);
      if (m != null && m.group(2)!.isNotEmpty) {
        _twoFactorCookie = '${m.group(1)}=${m.group(2)}';
      }
    }
    final newToken = res.headers['set-auth-token'];
    if (newToken != null && newToken.isNotEmpty) {
      token = newToken;
      _twoFactorCookie = null;
    }
    final decoded = res.body.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(res.body);
    final map = decoded is Map<String, dynamic> ? decoded : <String, dynamic>{};
    if (res.statusCode >= 400) {
      throw ApiException(
        res.statusCode,
        (map['code'] as String?) ?? 'AUTH_FAILED',
        _authMessage(res.statusCode, map),
      );
    }
    return map;
  }

  static String _authMessage(int status, Map<String, dynamic> body) {
    final code = body['code'] as String?;
    switch (code) {
      case 'INVALID_EMAIL_OR_PASSWORD':
        return 'Email or password is incorrect';
      case 'EMAIL_NOT_VERIFIED':
        return 'Verify your email first. We sent you a link.';
      case 'INVALID_CODE':
      case 'INVALID_TWO_FACTOR_CODE':
        return 'That code is not right. Try the latest code.';
    }
    if (status == 429) return 'Too many attempts. Wait a minute and try again.';
    return (body['message'] as String?) ?? 'Sign-in failed (error $status)';
  }

  /// Password step. Returns [SignInStep.twoFactor] when an authenticator code is needed.
  Future<SignInStep> signIn(String email, String password) async {
    token = null;
    _twoFactorCookie = null;
    final body = await _auth('/sign-in/email', {
      'email': email.trim(),
      'password': password,
    });
    if (body['twoFactorRedirect'] == true) return SignInStep.twoFactor;
    if (token == null) {
      throw ApiException(500, 'NO_TOKEN', 'The server did not start a session');
    }
    return SignInStep.done;
  }

  /// Second step: a 6-digit authenticator code, or one of the recovery codes.
  Future<void> verifySecondFactor(
    String code, {
    bool recoveryCode = false,
  }) async {
    await _auth(
      recoveryCode
          ? '/two-factor/verify-backup-code'
          : '/two-factor/verify-totp',
      {'code': code.trim()},
    );
    if (token == null) {
      throw ApiException(500, 'NO_TOKEN', 'The server did not start a session');
    }
  }

  Future<void> setActiveOrganization(String orgId) async {
    await _auth('/organization/set-active', {'organizationId': orgId});
  }

  /// Ends the session on the server; the local token is dropped either way.
  Future<void> signOut() async {
    try {
      if (token != null) await _auth('/sign-out', {});
    } catch (_) {
      // Offline or already gone: forgetting the token locally is what matters.
    } finally {
      token = null;
      _twoFactorCookie = null;
    }
  }

  // --- /api/v1 --------------------------------------------------------------------------------

  Future<dynamic> get(String path, [Map<String, String>? query]) =>
      _v1('GET', path, query: query);

  Future<dynamic> post(String path, [Map<String, dynamic>? body]) =>
      _v1('POST', path, body: body ?? {});

  Future<dynamic> delete(String path, [Map<String, dynamic>? body]) =>
      _v1('DELETE', path, body: body ?? {});

  /// Raw bytes of a private file (property photos). Null when it is gone or not allowed.
  Future<Uint8List?> getBytes(String path, [Map<String, String>? query]) async {
    final uri = Uri.parse(
      '$baseUrl/api/v1$path',
    ).replace(queryParameters: (query == null || query.isEmpty) ? null : query);
    try {
      final res = await _http
          .get(
            uri,
            headers: {if (token != null) 'authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 30));
      if (res.statusCode == 401) onUnauthenticated?.call();
      return res.statusCode == 200 ? res.bodyBytes : null;
    } catch (_) {
      return null;
    }
  }

  /// Multipart upload (property photos): named files, each with its content type.
  Future<dynamic> upload(
    String path,
    Map<String, (Uint8List, String)> files,
  ) async {
    final req = http.MultipartRequest(
      'POST',
      Uri.parse('$baseUrl/api/v1$path'),
    );
    if (token != null) req.headers['authorization'] = 'Bearer $token';
    files.forEach((name, f) {
      final (bytes, type) = f;
      final parts = type.split('/');
      req.files.add(
        http.MultipartFile.fromBytes(
          name,
          bytes,
          filename: name,
          contentType: MediaType(parts[0], parts[1]),
        ),
      );
    });
    final http.Response res;
    try {
      res = await http.Response.fromStream(
        await _http.send(req).timeout(const Duration(seconds: 90)),
      );
    } catch (_) {
      throw ApiException(
        0,
        'OFFLINE',
        'No connection. Check your internet and try again.',
      );
    }
    return _decode(res);
  }

  Future<dynamic> _v1(
    String method,
    String path, {
    Map<String, String>? query,
    Map<String, dynamic>? body,
  }) async {
    final uri = Uri.parse(
      '$baseUrl/api/v1$path',
    ).replace(queryParameters: (query == null || query.isEmpty) ? null : query);
    final headers = <String, String>{
      if (token != null) 'authorization': 'Bearer $token',
      if (body != null) 'content-type': 'application/json',
    };
    final http.Response res;
    try {
      res = await (switch (method) {
        'GET' => _http.get(uri, headers: headers),
        'DELETE' => _http.delete(uri, headers: headers, body: jsonEncode(body)),
        _ => _http.post(uri, headers: headers, body: jsonEncode(body)),
      }).timeout(const Duration(seconds: 30));
    } catch (_) {
      throw ApiException(
        0,
        'OFFLINE',
        'No connection. Check your internet and try again.',
      );
    }
    return _decode(res);
  }

  dynamic _decode(http.Response res) {
    Map<String, dynamic> map;
    try {
      final decoded = jsonDecode(res.body);
      map = decoded is Map<String, dynamic> ? decoded : {};
    } catch (_) {
      map = {};
    }
    if (map['ok'] == true) return map['data'];
    final err = (map['error'] as Map<String, dynamic>?) ?? {};
    final fieldErrors = <String, List<String>>{};
    final fe = err['fieldErrors'];
    if (fe is Map) {
      fe.forEach((k, v) {
        if (v is List) fieldErrors['$k'] = v.map((e) => '$e').toList();
      });
    }
    final ex = ApiException(
      res.statusCode,
      (err['code'] as String?) ?? 'HTTP_${res.statusCode}',
      (err['message'] as String?) ??
          'Something went wrong (error ${res.statusCode})',
      fieldErrors,
    );
    if (ex.unauthenticated) onUnauthenticated?.call();
    throw ex;
  }
}
