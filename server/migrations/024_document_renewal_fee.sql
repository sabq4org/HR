-- Expected renewal fee of a document, in halalas (decision 024, owner 2026-11-16). Entered by
-- HR from the fee schedule they pay; no statutory amount is assumed. Additive and optional.
ALTER TABLE employee_documents ADD COLUMN renewal_fee_halalas INTEGER;
