import 'package:crm/format.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('org-local date strings round-trip', () {
    final d = parseLocal('2026-11-21T16:30');
    expect(
      formatLocal(DateTime(d.year, d.month, d.day + 1, 10)),
      '2026-11-22T10:00',
    );
    // Month end rolls over.
    final e = parseLocal('2026-11-30T23:10');
    expect(
      formatLocal(DateTime(e.year, e.month, e.day + 1, 10)),
      '2026-12-01T10:00',
    );
  });

  test('labels', () {
    expect(label(stageLabels, 'SITE_VISIT_COMPLETED'), 'Site visit completed');
    expect(label(stageLabels, 'SOMETHING_NEW'), 'Something new');
    expect(aed(2500000), 'AED 2.5M');
  });
}
