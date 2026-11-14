import type { FinanceSeller } from '../../shared/finance';
import { sellerAddressText } from '../../shared/finance';

/** Issuer block on every printed document: legal name, national address, VAT number and CR. */
export function SellerBlock({ seller }: { seller: FinanceSeller }) {
  const address = sellerAddressText(seller.address);
  return (
    <div className="fin-doc-brand">
      <img src="/brand/sabq-logo.svg" alt="سبق" />
      <div>
        <b>{seller.name || 'سبق'}</b>
        {address && <span>{address}</span>}
        {seller.vatNumber && (
          <span>
            الرقم الضريبي / VAT No: <bdi>{seller.vatNumber}</bdi>
          </span>
        )}
        {seller.commercialRegistration && (
          <span>
            السجل التجاري / CR: <bdi>{seller.commercialRegistration}</bdi>
          </span>
        )}
      </div>
    </div>
  );
}
