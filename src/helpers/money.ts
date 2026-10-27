/** Amounts travel in the minor unit (paise). "₹500" / "₹500.50". */
export function formatMoney(minor: number, currency: string | null = 'INR'): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency ?? 'INR',
    minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}

export const rupeesToPaise = (rupees: number) => Math.round(rupees * 100);
export const paiseToRupees = (paise: number) => paise / 100;

/** What a team pays, in paise: the fee × members, or the fee once when it's per team. */
export function amountDue(
  event: { registrationFee: number | null; paymentMode: string; feeBasis?: string },
  members: number,
): number {
  if (event.paymentMode === 'none') return 0;
  const fee = event.registrationFee ?? 0;
  return event.feeBasis === 'per_team' ? fee : fee * members;
}

/** "₹500 per person" / "₹1,200 per team", or null when there's no fee. */
export function describeFee(event: {
  registrationFee: number | null;
  currency: string | null;
  paymentMode: string;
  feeBasis?: string;
}): string | null {
  if (event.paymentMode === 'none' || event.registrationFee === null) return null;
  const per = event.feeBasis === 'per_team' ? 'per team' : 'per person';
  return `${formatMoney(event.registrationFee, event.currency)} ${per}`;
}
