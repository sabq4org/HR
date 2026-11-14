import type { FinanceDocumentLanguage, FinanceSeller } from '../../shared/finance';
import { sellerAddressText } from '../../shared/finance';

/** Issuer block on every printed document: legal name, national address, VAT number and CR. */
export function SellerBlock({
  seller,
  lang = 'ar',
}: {
  seller: FinanceSeller;
  lang?: FinanceDocumentLanguage;
}) {
  const en = lang === 'en';
  // English papers use the English name and address when the settings hold them.
  const name = (en && seller.nameEnglish?.trim()) || seller.name || 'سبق';
  const address = (en && seller.addressEnglish?.trim()) || sellerAddressText(seller.address);
  return (
    <div className="fin-doc-brand">
      {/* Sized in the stylesheet to the height of the details beside it. */}
      <span className="fin-doc-logo">
        <img src="/brand/sabq-logo.svg" alt={en ? 'Sabq' : 'سبق'} />
      </span>
      <div>
        <b>{name}</b>
        {address && <span>{address}</span>}
        {seller.vatNumber && (
          <span>
            {en ? 'VAT No' : 'الرقم الضريبي / VAT No'}: <bdi>{seller.vatNumber}</bdi>
          </span>
        )}
        {seller.commercialRegistration && (
          <span>
            {en ? 'CR No' : 'السجل التجاري / CR'}: <bdi>{seller.commercialRegistration}</bdi>
          </span>
        )}
      </div>
    </div>
  );
}
