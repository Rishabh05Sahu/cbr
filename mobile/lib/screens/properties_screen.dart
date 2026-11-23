import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;
import 'package:image_picker/image_picker.dart';
import 'package:material_ui/material_ui.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../session.dart';
import '../theme.dart';
import 'lead_sheets.dart' show FormErrors;

const listingLabels = {'SALE': 'Sale', 'RENT': 'Rent', 'LEASE': 'Lease'};
const propertyKindLabels = {
  'APARTMENT': 'Apartment',
  'VILLA': 'Villa',
  'PLOT': 'Plot',
  'ROW_HOUSE': 'Townhouse',
  'OFFICE': 'Office',
  'SHOP': 'Shop',
  'WAREHOUSE': 'Warehouse',
  'OTHER': 'Other',
};
const propertyStatusLabels = {
  'DRAFT': 'Draft',
  'AVAILABLE': 'Available',
  'ON_HOLD': 'On hold',
  'SOLD': 'Sold',
  'RENTED': 'Rented',
  'WITHDRAWN': 'Withdrawn',
};
const priceTypeLabels = {
  'TOTAL': 'Total price',
  'PER_SQFT': 'Per sq ft',
  'MONTHLY_RENT': 'Monthly rent',
};

String _price(Map<String, dynamic> p) {
  final v = num.tryParse('${p['price'] ?? ''}');
  final base = v == null ? '${p['price'] ?? ''}' : aed(v);
  return switch (p['priceType']) {
    'MONTHLY_RENT' => '$base / month',
    'PER_SQFT' => '$base / sq ft',
    _ => base,
  };
}

/// Properties (FR-140/141): the list with search and status, a property with its photos, and for
/// Owner/Admin, adding a property and photos from the camera or gallery.
class PropertiesScreen extends StatefulWidget {
  const PropertiesScreen({super.key, required this.session});
  final Session session;

  @override
  State<PropertiesScreen> createState() => _PropertiesScreenState();
}

class _PropertiesScreenState extends State<PropertiesScreen> {
  final _q = TextEditingController();
  String _status = '';
  final List<Map<String, dynamic>> _rows = [];
  int _page = 1;
  bool _hasMore = false;
  bool _loading = false;
  String? _error;

  ApiClient get _api => widget.session.api;

  @override
  void initState() {
    super.initState();
    _load(reset: true);
  }

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  Future<void> _load({bool reset = false}) async {
    if (_loading) return;
    setState(() => _loading = true);
    final page = reset ? 1 : _page + 1;
    try {
      final d = await _api.get('/properties', {
        if (_q.text.trim().isNotEmpty) 'q': _q.text.trim(),
        if (_status.isNotEmpty) 'status': _status,
        'page': '$page',
      }) as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        if (reset) _rows.clear();
        _rows.addAll((d['rows'] as List).cast<Map<String, dynamic>>());
        _page = page;
        _hasMore = d['hasMore'] == true;
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _open(String id) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => PropertyDetailScreen(session: widget.session, id: id),
      ),
    );
    _load(reset: true);
  }

  @override
  Widget build(BuildContext context) {
    final canManage = widget.session.me!.can('property.manage');
    return Scaffold(
      appBar: AppBar(title: const Text('Properties')),
      floatingActionButton: canManage
          ? FloatingActionButton.extended(
              heroTag: 'property-add',
              onPressed: () async {
                final id = await Navigator.of(context).push<String>(
                  MaterialPageRoute(
                    builder: (_) => AddPropertyScreen(api: _api),
                  ),
                );
                if (id != null) await _open(id);
              },
              icon: const Icon(Icons.add_home_outlined),
              label: const Text('Add property'),
            )
          : null,
      body: RefreshIndicator(
        onRefresh: () => _load(reset: true),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 90),
          children: [
            TextField(
              controller: _q,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _load(reset: true),
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Title, code, area or city',
              ),
            ),
            const SizedBox(height: 8),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final e in {'': 'All', ...propertyStatusLabels}.entries)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        label: Text(e.value),
                        selected: _status == e.key,
                        onSelected: (_) {
                          setState(() => _status = e.key);
                          _load(reset: true);
                        },
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            if (_error != null)
              MessageView(message: _error!, onRetry: () => _load(reset: true))
            else if (_rows.isEmpty && !_loading)
              const Padding(
                padding: EdgeInsets.only(top: 60),
                child: MessageView(
                  message: 'No properties match.',
                  icon: Icons.home_work_outlined,
                ),
              ),
            for (final p in _rows)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: AppCard(
                  onTap: () => _open(p['id'] as String),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              p['title'] as String? ?? '',
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                                fontSize: 15,
                              ),
                            ),
                          ),
                          Pill(
                            propertyStatusLabels[p['status']] ??
                                '${p['status']}',
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        [
                          p['code'],
                          listingLabels[p['listingType']],
                          if (p['bhk'] != null) '${p['bhk']} BR',
                          propertyKindLabels[p['propertyType']],
                          [
                            p['locality'],
                            p['city'],
                          ].whereType<String>().join(', '),
                        ].whereType<String>().join(' · '),
                        style: const TextStyle(
                          color: AppColors.muted,
                          fontSize: 13,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _price(p),
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
                ),
              ),
            if (_hasMore)
              OutlinedButton(
                onPressed: _loading ? null : () => _load(),
                child: const Text('Load more'),
              ),
            if (_loading && _rows.isEmpty)
              const Padding(
                padding: EdgeInsets.only(top: 60),
                child: Center(child: CircularProgressIndicator()),
              ),
          ],
        ),
      ),
    );
  }
}

/// One property: details and photos; Owner/Admin add photos from the camera or gallery.
class PropertyDetailScreen extends StatefulWidget {
  const PropertyDetailScreen({
    super.key,
    required this.session,
    required this.id,
  });
  final Session session;
  final String id;

  @override
  State<PropertyDetailScreen> createState() => _PropertyDetailScreenState();
}

class _PropertyDetailScreenState extends State<PropertyDetailScreen> {
  Map<String, dynamic>? _data;
  String? _error;
  bool _uploading = false;
  final Map<String, Future<Uint8List?>> _thumbs = {};

  ApiClient get _api => widget.session.api;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d =
          await _api.get('/properties/${widget.id}') as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _data = d;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(
          () => _error = e.status == 404
              ? 'This property is not available.'
              : e.message,
        );
      }
    }
  }

  Future<Uint8List?> _thumb(String photoId) => _thumbs.putIfAbsent(
    photoId,
    () => _api.getBytes('/properties/${widget.id}/photos/$photoId', {
      'size': 'thumb',
    }),
  );

  Future<void> _addPhoto(ImageSource source) async {
    final picked = await ImagePicker().pickImage(source: source);
    if (picked == null) return;
    setState(() => _uploading = true);
    try {
      final prepared = await compute(preparePhoto, await picked.readAsBytes());
      if (prepared == null) {
        throw ApiException(
          422,
          'BAD_IMAGE',
          'This file is not a photo the app can read.',
        );
      }
      await _api.upload('/properties/${widget.id}/photos', {
        'photo': (prepared.full, 'image/jpeg'),
        'thumb': (prepared.thumb, 'image/jpeg'),
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Photo added')));
      await _load();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  void _viewPhoto(String photoId) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => Scaffold(
          backgroundColor: Colors.black,
          appBar: AppBar(
            backgroundColor: Colors.black,
            foregroundColor: Colors.white,
          ),
          body: FutureBuilder<Uint8List?>(
            future: _api.getBytes('/properties/${widget.id}/photos/$photoId'),
            builder: (_, s) => s.connectionState != ConnectionState.done
                ? const Center(child: CircularProgressIndicator())
                : s.data == null
                ? const Center(
                    child: Text(
                      'Could not load the photo.',
                      style: TextStyle(color: Colors.white),
                    ),
                  )
                : InteractiveViewer(
                    child: Center(child: Image.memory(s.data!)),
                  ),
          ),
        ),
      ),
    );
  }

  Widget _row(String label, String? value) => value == null || value.isEmpty
      ? const SizedBox.shrink()
      : Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 120,
                child: Text(
                  label,
                  style: const TextStyle(color: AppColors.muted),
                ),
              ),
              Expanded(child: Text(value)),
            ],
          ),
        );

  @override
  Widget build(BuildContext context) {
    if (_data == null) {
      return Scaffold(
        appBar: AppBar(),
        body: _error == null
            ? const Center(child: CircularProgressIndicator())
            : MessageView(message: _error!, onRetry: _load),
      );
    }
    final p = _data!['property'] as Map<String, dynamic>;
    final photos = (_data!['photos'] as List).cast<Map<String, dynamic>>();
    final canManage = _data!['canManage'] == true;
    final amenities = ((p['amenities'] as List?) ?? const []).join(', ');
    return Scaffold(
      appBar: AppBar(title: Text(p['code'] as String? ?? 'Property')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(
              p['title'] as String? ?? '',
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            Wrap(
              spacing: 6,
              children: [
                Pill(propertyStatusLabels[p['status']] ?? '${p['status']}'),
                Pill(listingLabels[p['listingType']] ?? ''),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              _price(p),
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 12),
            SectionLabel('Photos', count: photos.length),
            if (photos.isEmpty)
              const Text(
                'No photos yet.',
                style: TextStyle(color: AppColors.muted),
              ),
            if (photos.isNotEmpty)
              SizedBox(
                height: 110,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: photos.length,
                  separatorBuilder: (_, _) => const SizedBox(width: 8),
                  itemBuilder: (_, i) {
                    final id = photos[i]['id'] as String;
                    return GestureDetector(
                      onTap: () => _viewPhoto(id),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: SizedBox(
                          width: 140,
                          child: FutureBuilder<Uint8List?>(
                            future: _thumb(id),
                            builder: (_, s) => s.data == null
                                ? Container(color: AppColors.graySoft)
                                : Image.memory(s.data!, fit: BoxFit.cover),
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
            if (canManage) ...[
              const SizedBox(height: 10),
              if (_uploading)
                const LinearProgressIndicator()
              else
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: photos.length >= 20
                            ? null
                            : () => _addPhoto(ImageSource.camera),
                        icon: const Icon(Icons.photo_camera_outlined),
                        label: const Text('Take photo'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: photos.length >= 20
                            ? null
                            : () => _addPhoto(ImageSource.gallery),
                        icon: const Icon(Icons.photo_library_outlined),
                        label: const Text('From gallery'),
                      ),
                    ),
                  ],
                ),
              if (photos.length >= 20)
                const Text(
                  'A property can have up to 20 photos.',
                  style: TextStyle(color: AppColors.muted, fontSize: 13),
                ),
            ],
            const SizedBox(height: 8),
            const SectionLabel('Details'),
            _row('Type', propertyKindLabels[p['propertyType']]),
            _row('Bedrooms', p['bhk'] == null ? null : '${p['bhk']}'),
            _row(
              'Location',
              [
                p['addressLine'],
                p['locality'],
                p['city'],
              ].whereType<String>().join(', '),
            ),
            _row(
              'Area',
              p['builtUpAreaSqft'] != null
                  ? '${p['builtUpAreaSqft']} sq ft built-up'
                  : p['carpetAreaSqft'] != null
                  ? '${p['carpetAreaSqft']} sq ft carpet'
                  : null,
            ),
            _row('Floor', p['floor'] as String?),
            _row('Furnishing', p['furnishing'] as String?),
            _row('Maintenance', p['maintenance'] as String?),
            _row('Deposit', p['deposit'] as String?),
            _row('Available from', p['availableFrom'] as String?),
            _row('Amenities', amenities),
            _row('Responsible', p['responsibleName'] as String?),
            if ((p['description'] as String?)?.isNotEmpty == true) ...[
              const SectionLabel('Description'),
              Text(p['description'] as String),
            ],
            const SizedBox(height: 16),
            const Text(
              'Owner contacts and editing are on the website.',
              style: TextStyle(color: AppColors.muted, fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }
}

/// A photo prepared like the website does (FR-141): JPEG, longest side at most 2048 px, plus a
/// 480 px thumbnail. Re-encoding drops EXIF data (location, camera), so it never leaves the
/// phone. Runs in a background isolate. Null when the file is not an image.
class PreparedPhoto {
  const PreparedPhoto(this.full, this.thumb);
  final Uint8List full;
  final Uint8List thumb;
}

PreparedPhoto? preparePhoto(Uint8List bytes) {
  final decoded = img.decodeImage(bytes);
  if (decoded == null) return null;
  // Apply the camera's rotation before the EXIF data is dropped.
  final upright = img.bakeOrientation(decoded);
  img.Image fit(int side) {
    final w = upright.width, h = upright.height;
    if (w <= side && h <= side) return upright;
    return w >= h
        ? img.copyResize(
            upright,
            width: side,
            interpolation: img.Interpolation.average,
          )
        : img.copyResize(
            upright,
            height: side,
            interpolation: img.Interpolation.average,
          );
  }

  final full = fit(2048)..exif = img.ExifData();
  final thumb = fit(480)..exif = img.ExifData();
  return PreparedPhoto(
    img.encodeJpg(full, quality: 85),
    img.encodeJpg(thumb, quality: 80),
  );
}

/// Add a property (Owner/Admin): the main fields; the rest can be filled in on the website.
/// Pops the new property's id.
class AddPropertyScreen extends StatefulWidget {
  const AddPropertyScreen({super.key, required this.api});
  final ApiClient api;

  @override
  State<AddPropertyScreen> createState() => _AddPropertyScreenState();
}

class _AddPropertyScreenState extends State<AddPropertyScreen> {
  final _title = TextEditingController();
  final _bhk = TextEditingController();
  final _city = TextEditingController(text: 'Dubai');
  final _locality = TextEditingController();
  final _price = TextEditingController();
  final _area = TextEditingController();
  final _description = TextEditingController();
  String _listing = 'SALE';
  String _kind = 'APARTMENT';
  String _priceType = 'TOTAL';
  String _status = 'AVAILABLE';
  bool _saving = false;
  List<String> _errors = const [];
  Map<String, List<String>> _fieldErrors = const {};

  @override
  void dispose() {
    for (final c in [
      _title,
      _bhk,
      _city,
      _locality,
      _price,
      _area,
      _description,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _errors = const [];
      _fieldErrors = const {};
    });
    try {
      final r = await widget.api.post('/properties', {
        'title': _title.text.trim(),
        'listingType': _listing,
        'propertyType': _kind,
        'bhk': _bhk.text.trim(),
        'city': _city.text.trim(),
        'locality': _locality.text.trim(),
        'price': _price.text.trim(),
        'priceType': _priceType,
        'builtUpAreaSqft': _area.text.trim(),
        'status': _status,
        'description': _description.text.trim(),
      }) as Map<String, dynamic>;
      if (mounted) Navigator.of(context).pop(r['id'] as String);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _fieldErrors = e.fieldErrors;
          _errors = e.fieldErrors.isEmpty ? [e.message] : const [];
        });
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Widget _text(
    TextEditingController c,
    String label,
    String field, {
    TextInputType? keyboard,
    int maxLines = 1,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: TextField(
      controller: c,
      keyboardType: keyboard,
      maxLines: maxLines,
      decoration: InputDecoration(
        labelText: label,
        errorText: _fieldErrors[field]?.join(' '),
      ),
    ),
  );

  Widget _pick(
    String label,
    Map<String, String> options,
    String value,
    ValueChanged<String> on,
  ) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: DropdownButtonFormField<String>(
      initialValue: value,
      decoration: InputDecoration(labelText: label),
      items: [
        for (final e in options.entries)
          DropdownMenuItem(value: e.key, child: Text(e.value)),
      ],
      onChanged: (v) => setState(() => on(v ?? value)),
    ),
  );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add property')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _text(_title, 'Title *', 'title'),
          _pick('For', listingLabels, _listing, (v) {
            _listing = v;
            _priceType = v == 'SALE' ? 'TOTAL' : 'MONTHLY_RENT';
          }),
          _pick('Type', propertyKindLabels, _kind, (v) => _kind = v),
          _text(_bhk, 'Bedrooms', 'bhk', keyboard: TextInputType.number),
          _text(_city, 'City *', 'city'),
          _text(_locality, 'Area / community', 'locality'),
          _text(
            _price,
            'Price (AED) *',
            'price',
            keyboard: TextInputType.number,
          ),
          _pick('Price is', priceTypeLabels, _priceType, (v) => _priceType = v),
          _text(
            _area,
            'Built-up area (sq ft)',
            'builtUpAreaSqft',
            keyboard: TextInputType.number,
          ),
          _pick('Status', propertyStatusLabels, _status, (v) => _status = v),
          _text(_description, 'Description', 'description', maxLines: 4),
          FormErrors(_errors),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_saving ? 'Adding…' : 'Add property'),
          ),
          const SizedBox(height: 8),
          const Text(
            'After adding, take photos on the next screen. Owner contacts and other details are on the website.',
            textAlign: TextAlign.center,
            style: TextStyle(color: AppColors.muted, fontSize: 13),
          ),
        ],
      ),
    );
  }
}
