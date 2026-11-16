-- Document details for expiry follow-up (decision 023, owner 2026-11-16).
-- The document number is an identity number for iqama and passport scans, so it is stored
-- encrypted with the data key like the file itself. The issue date is optional. Both columns
-- are additive; existing documents read as "no number, no issue date". No row is rewritten.
ALTER TABLE employee_documents ADD COLUMN document_number_encrypted TEXT;
ALTER TABLE employee_documents ADD COLUMN issued_at TEXT;
