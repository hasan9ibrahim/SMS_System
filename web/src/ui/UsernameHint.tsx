// Multi-step sign-in and password forms (§13.28). Browsers' password managers pair a password with the text
// field typed next to it; in the code step that is the 6-digit sign-in code, which then got saved (and later
// autofilled) as the username. A hidden, read-only username field in that form tells the password manager the
// real username, as the Chromium and WebKit guidance for multi-step sign-in recommends.

/** Hidden `autocomplete="username"` field carrying the username of the account the form is for. */
export function UsernameHint({ username }: { username: string }) {
  return (
    <input
      type="text"
      id="username"
      name="username"
      autoComplete="username"
      value={username}
      readOnly
      hidden
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}

/** A username of 4–8 digits only: most likely a sign-in code a password manager saved as the username before. */
export const looksLikeCode = (username: string) => /^\d{4,8}$/.test(username.trim());
