import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo } from '@azure/msal-browser';
import { env } from './env';

/**
 * Delegated tokens of the user for Fabric and OneLake. Own SPA registration (no secret, PKCE), incremental consent:
 * every group of scopes is requested the first time it is needed, always from a click.
 * No deployment-pipeline or write scope is requested (reading a pipeline definition needs Item.ReadWrite.All: not asked).
 */
export const SCOPES = {
  fabricRead: [
    'https://api.fabric.microsoft.com/Workspace.Read.All',
    'https://api.fabric.microsoft.com/Item.Read.All',
  ],
  fabricRun: [
    'https://api.fabric.microsoft.com/Workspace.Read.All',
    'https://api.fabric.microsoft.com/Item.Read.All',
    'https://api.fabric.microsoft.com/Item.Execute.All',
  ],
  onelake: ['https://storage.azure.com/user_impersonation'],
} as const;

export type ScopeSet = keyof typeof SCOPES;

export class SignInRequiredError extends Error {
  constructor(public readonly scopeSet: ScopeSet) {
    super('Sign in or consent is required');
    this.name = 'SignInRequiredError';
  }
}

let instance: PublicClientApplication | null = null;
/** Created on first use: the demo mode and the unit tests never build it. */
const client = (): PublicClientApplication => (instance ??= new PublicClientApplication({
  auth: {
    clientId: env.msalClientId || '00000000-0000-0000-0000-000000000000',
    authority: `https://login.microsoftonline.com/${env.msalTenantId}`,
    // Blank page: the silent renewal in an iframe must not reload the SPA (block_iframe_reload).
    redirectUri: `${window.location.origin}/blank.html`,
    // Inside the portal iframe storage is partitioned: the popup returns its response through this page.
    popupRelayUri: window.top !== window.self ? `${window.location.origin}/popup-relay.html` : undefined,
  },
  // MSAL keeps its own token cache here (the signed-in user's account). The app itself stores no UPN of the test identities.
  cache: { cacheLocation: 'sessionStorage' },
}));

let ready: Promise<void> | null = null;
function init(): Promise<void> {
  ready ??= client().initialize().then(async () => {
    const r = await client().handleRedirectPromise().catch(() => null);
    if (r?.account) client().setActiveAccount(r.account);
  });
  return ready;
}

function account(): AccountInfo | null {
  return client().getActiveAccount() ?? client().getAllAccounts()[0] ?? null;
}

export async function getToken(
  set: ScopeSet,
  opts: { interactive?: boolean; forceRefresh?: boolean; extraScopesToConsent?: string[] } = {},
): Promise<string> {
  await init();
  const scopes = [...SCOPES[set]];
  const acc = account();
  try {
    if (!acc) throw new InteractionRequiredAuthError('no_account', 'There is no account in the MSAL cache');
    const r = await client().acquireTokenSilent({ scopes, account: acc, forceRefresh: opts.forceRefresh });
    return r.accessToken;
  } catch (err) {
    if (acc && !(err instanceof InteractionRequiredAuthError)) throw err;
    if (!opts.interactive) throw new SignInRequiredError(set);
    // Popup: from a user gesture it is the only reliable way inside the iframe of the Fabric portal.
    const r = await client().acquireTokenPopup({
      scopes, prompt: acc ? undefined : 'select_account', extraScopesToConsent: opts.extraScopesToConsent,
    });
    client().setActiveAccount(r.account);
    return r.accessToken;
  }
}

const EXTRA_CONSENT = [...SCOPES.fabricRun, ...SCOPES.onelake].filter((s) => !(SCOPES.fabricRead as readonly string[]).includes(s));

/** One popup: read token for Fabric and consent for the rest (run, OneLake), so that everything else is silent. */
export async function signIn(): Promise<AccountInfo | null> {
  await getToken('fabricRead', { interactive: true, extraScopesToConsent: EXTRA_CONSENT });
  return account();
}

/** For sessions opened before every scope was requested: forces the consent popup (always from a click). */
export async function grantAccess(): Promise<void> {
  await init();
  const r = await client().acquireTokenPopup({ scopes: [...SCOPES.fabricRead], account: account() ?? undefined, extraScopesToConsent: EXTRA_CONSENT });
  client().setActiveAccount(r.account);
}

export async function currentAccount(): Promise<AccountInfo | null> {
  await init();
  return account();
}
