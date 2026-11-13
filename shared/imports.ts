import type { FormValues } from './administration';
export interface ImportRow {
  rowNumber: number;
  values: FormValues;
  errors: string[];
}
export interface EmployeeImportPreview {
  rows: ImportRow[];
  valid: boolean;
  total: number;
}
