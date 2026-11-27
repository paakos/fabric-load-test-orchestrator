import { runPopupRelay } from '@azure/msal-browser/popup-relay';

const button = document.getElementById('go') as HTMLButtonElement;
const msg = document.getElementById('msg') as HTMLParagraphElement;

// The provider popup is opened from a click so that the browser does not block it.
button.addEventListener('click', () => {
  button.disabled = true;
  msg.textContent = 'Complete the sign-in in the Microsoft window.';
  try {
    runPopupRelay({ allowedAuthorityOrigins: ['https://login.microsoftonline.com'] });
  } catch (err) {
    button.disabled = false;
    msg.textContent = `Could not open the sign-in: ${err instanceof Error ? err.message : String(err)}`;
  }
});
