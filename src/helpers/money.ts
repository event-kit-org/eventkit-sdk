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

/** What a team pays, in paise: the per-person fee × members. */
export function amountDue(
  event: { registrationFee: number | null; paymentMode: string },
  members: number,
): number {
  return event.paymentMode === 'none' ? 0 : (event.registrationFee ?? 0) * members;
}
