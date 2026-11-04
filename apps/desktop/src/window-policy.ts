/** Navigation rules for the app window: it may only ever show the local service. */

export function isServiceUrl(url: string, serviceOrigin: string): boolean {
  try {
    return new URL(url).origin === serviceOrigin;
  } catch {
    return false;
  }
}

/** Links that open in the user's browser: plain web links only (never file:, app:, javascript:). */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export const WINDOW_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
} as const;

/**
 * The microphone, and only the microphone, for the TrailerForge window itself (the voiceover
 * recorder). Never the camera, never screen capture, never another page.
 */
export function allowMicrophone(
  permission: string,
  mediaTypes: readonly string[] | undefined,
  requestingUrl: string,
  serviceOrigin: string,
): boolean {
  return (
    permission === 'media' &&
    mediaTypes !== undefined &&
    mediaTypes.length > 0 &&
    mediaTypes.every((t) => t === 'audio') &&
    isServiceUrl(requestingUrl, serviceOrigin)
  );
}
