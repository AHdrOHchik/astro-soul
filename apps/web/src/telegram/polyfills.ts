/*
 * @telegram-apps/sdk parses launch parameters with valibot, which calls
 * Object.hasOwn (ES2022). Safari before 15.4 and Chromium before 93 do not have
 * it, and both are inside the supported range (iOS 15+, Android 9+ WebView):
 * there the SDK throws, cannot read initData, and the app would decide it runs
 * outside Telegram. Build targets only lower syntax, so the method is added here.
 */
export function installPolyfills(): void {
  if ('hasOwn' in Object) return;
  Object.defineProperty(Object, 'hasOwn', {
    configurable: true,
    writable: true,
    value: (target: unknown, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(Object(target), key),
  });
}
