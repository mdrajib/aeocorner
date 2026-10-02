/** "sam.lee@example.com" -> "s•••@example.com": enough to recognise your own address, not enough to harvest one. */
export function maskEmail(address) {
  const [local = '', domain = ''] = String(address).split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}
