import type { FormValues } from './administration';
export interface ImportRow {
  rowNumber: number;
  values: FormValues;
  errors: string[];
  /** The cells as written in the file, by field key, so a rejected row can be sent back as is. */
  raw?: Record<string, string>;
  /** The employee number is already in the system: the row is skipped, not an error. */
  existing?: boolean;
}
export interface EmployeeImportPreview {
  rows: ImportRow[];
  /** True when no row needs correcting (existing employees are skipped, not errors). */
  valid: boolean;
  total: number;
  /** Rows ready to save. */
  ready?: number;
  /** Rows skipped because the employee is already in the system. */
  existing?: number;
  /** Rows that need correcting. */
  invalid?: number;
  /** XLSX of the rows that need correcting with a «سبب الرفض» column, ready to fix and upload again. */
  rejectedWorkbookBase64?: string;
}
