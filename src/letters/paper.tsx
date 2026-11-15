import { dateLabel } from '../lib';
import type { IssuedDocument } from '../../shared/administration';
export function IssuedLetter({ document: doc }: { document: IssuedDocument }) {
  const en = doc.language === 'en';
  const synthetic = doc.synthetic !== false;
  return (
    <article
      className="issued-letter"
      dir={en ? 'ltr' : 'rtl'}
      lang={doc.language}
      aria-label={
        en
          ? synthetic
            ? 'Approved preview document'
            : 'Approved document'
          : synthetic
            ? 'المستند التجريبي المعتمد'
            : 'المستند المعتمد'
      }
    >
      <header>
        <img src="/brand/sabq-logo.svg" width="76" height="70" alt="سبق" />
        <div>
          <b>{en ? 'Sabq · People operations' : 'سبق · الشؤون الإدارية'}</b>
          {synthetic ? (
            <span>{en ? 'Internal synthetic preview' : 'معاينة داخلية · بيانات اصطناعية'}</span>
          ) : null}
        </div>
      </header>
      <div className="issued-meta">
        <span>{doc.reference}</span>
        <span>
          {en
            ? new Date(doc.issuedAt).toLocaleDateString('en-GB', { timeZone: 'Asia/Riyadh' })
            : dateLabel(doc.issuedAt, { day: 'numeric', month: 'long', year: 'numeric' })}
        </span>
      </div>
      <h2>{doc.title}</h2>
      <p className="issued-recipient">{doc.recipient}</p>
      {doc.paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      <dl>
        {doc.facts.map((fact, i) => (
          <div key={i}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <footer>
        <p>
          {en ? 'Internal review recorded by:' : 'المراجعة الداخلية مسجلة باسم:'}{' '}
          <b>{doc.approvedByName}</b>
        </p>
        <small>
          {synthetic
            ? en
              ? 'Snapshot preserved at approval. Fictional data only. No legal signature or external verification is provided.'
              : 'نسخة محفوظة وقت الاعتماد. بيانات وهمية فقط، ولا تتضمن توقيعًا قانونيًا أو تحققًا خارجيًا.'
            : en
              ? 'Snapshot preserved at approval. Verify with Sabq HR quoting the reference above.'
              : 'نسخة محفوظة وقت الاعتماد. للتحقق تواصل مع الموارد البشرية في سبق مع ذكر الرقم المرجعي أعلاه.'}
        </small>
      </footer>
    </article>
  );
}
