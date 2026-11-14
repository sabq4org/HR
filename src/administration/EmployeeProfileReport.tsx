import { ArrowRight, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EmployeeFile } from '../../shared/administration';
import { api, useApp } from '../lib';
import { EmployeeProfilePaper } from './EmployeeProfilePaper';

export function EmployeeProfileReport({
  file,
  onBack,
}: {
  file: EmployeeFile;
  onBack: () => void;
}) {
  const { data } = useApp();
  const [dataMode, setDataMode] = useState('');
  useEffect(() => {
    let active = true;
    void api<{ mode?: string }>('/session')
      .then((session) => {
        if (active) setDataMode(session.mode || '');
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const dataModeLabel = dataMode.startsWith('private-')
    ? 'بيانات خاصة'
    : dataMode.startsWith('synthetic-')
      ? 'بيانات اصطناعية'
      : 'نوع البيانات غير محدد';
  return (
    <div className="employee-report-page">
      <div className="employee-report-controls">
        <button className="adm-button secondary" onClick={onBack}>
          <ArrowRight size={16} /> العودة للملف
        </button>
        <button className="adm-button" onClick={() => window.print()}>
          <Printer size={16} /> طباعة / حفظ PDF
        </button>
      </div>
      <p className="employee-report-help">
        لحفظ نسخة على جهازك، اضغط «طباعة / حفظ PDF»، ثم اختر «حفظ بصيغة PDF» من نافذة الطباعة.
      </p>
      <EmployeeProfilePaper file={file} employees={data.employees} dataModeLabel={dataModeLabel} />
    </div>
  );
}
