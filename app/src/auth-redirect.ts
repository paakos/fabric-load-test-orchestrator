import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';

broadcastResponseToMainFrame().catch((err: unknown) => {
  document.body.textContent = `Could not complete the sign-in: ${err instanceof Error ? err.message : String(err)}`;
});
