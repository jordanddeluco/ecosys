// Cloud backup app registrations. Photos signs in to OneDrive and Google Drive in the browser, so each
// provider needs a (free) app registration that lists this site's address. Paste the IDs here to set them
// for everyone who opens this copy of ecosys, or enter them in Photos > Cloud backup > Set up (kept in
// that browser only). Client IDs are public identifiers, not secrets: there is no client secret anywhere.
//
// OneDrive (Microsoft Entra ID, "App registrations" at https://entra.microsoft.com):
//   New registration → Accounts in any organizational directory and personal Microsoft accounts →
//   Redirect URI, platform "Single-page application": <this site>/photos/auth.html
//   (locally use http://localhost:4300/photos/auth.html and open ecosys at http://localhost:4300).
//   API permissions: Microsoft Graph, delegated: Files.ReadWrite, offline_access, User.Read.
//
// Google Drive (Google Cloud console, https://console.cloud.google.com/apis/credentials):
//   Enable the Google Drive API → Create credentials → OAuth client ID → Web application →
//   Authorized JavaScript origins: <this site's origin>; Authorized redirect URIs: <this site>/photos/auth.html
//   OAuth consent screen scope: .../auth/drive.file (Photos only sees the files it created).
export const CLOUD_CONFIG = {
  onedriveClientId: '',
  googleClientId: '',
};
