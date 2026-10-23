/**
 * Remember, for this browser tab only, that the user agreed to send project details to a
 * provider. It is asked again next session, and for any other provider.
 */
const key = (providerId: string) => `tforge.consent.${providerId}`;

export function hasConsent(providerId: string): boolean {
  try {
    return window.sessionStorage.getItem(key(providerId)) === '1';
  } catch {
    return false; // storage blocked: just ask every time
  }
}

export function giveConsent(providerId: string): void {
  try {
    window.sessionStorage.setItem(key(providerId), '1');
  } catch {
    // ignore
  }
}
