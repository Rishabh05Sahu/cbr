# Anonymised pilot exports (Phase 2 M4, P6)

This folder is **only** for anonymised real-estate brokerage pilot exports in CSV, XLSX or TSV format. They are used to validate the lead import (Phase 2 milestone M4, gate P6) against real-world column names and value formats. See [docs/PHASE-2-M4-REPORT.md](../../docs/PHASE-2-M4-REPORT.md) and [docs/PHASE-2-PLAN.md](../../docs/PHASE-2-PLAN.md).

> **Currently this folder holds generated SYNTHETIC fixtures, not brokerage exports:** `synthetic_pilot_leads.csv` and `synthetic_pilot_leads.xlsx`. See [SYNTHETIC_FIXTURES.md](SYNTHETIC_FIXTURES.md).

## Anonymise before placing a file here

Every file must be anonymised **before** it is copied into this folder. Replace all of the following with synthetic data:

- people's names (customers, owners, brokers, agents, referrers);
- phone numbers (mobile, landline, WhatsApp, alternate numbers);
- email addresses;
- property and postal addresses, flat or unit numbers, PIN codes that identify a property;
- any other identifying or confidential information: ID numbers (PAN, Aadhaar), deal values tied to a person, free-text notes or remarks that mention people, URLs, account or lead IDs from the source system.

Keep the **format** of the original values so the validation is meaningful, for example:

- the same column headings and spelling;
- the same phone shapes (`+91 98xxx xxxxx`, `098xxxxxxxx`, numbers stored as Excel numbers);
- the same budget styles (`85 L`, `1.2 Cr`, `85,00,000`);
- the same blank or malformed cells;
- the same duplicate rows.

Never place the original customer export here, or anywhere in this repository.

## Git

The `.gitignore` in this folder keeps spreadsheet and archive files (`.csv`, `.xlsx`, `.xls`, `.tsv`, `.zip`) out of Git, even when anonymised. Only this README and the `.gitignore` are meant to be tracked.

## Retention

Delete the files from this folder when the P6 validation is finished and recorded in the M4 report.
