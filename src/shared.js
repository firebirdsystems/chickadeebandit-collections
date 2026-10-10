// Mirrors hub-sdk.js helpers used by logic.js, so logic can be unit-tested
// without loading the browser-only SDK. Keep in sync with /hub-sdk.js.

export function isAdult(member) {
  return !!member && (member.role === "adult" || member.role === "admin");
}
