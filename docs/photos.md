# Photos

Photos is the ecosys photo and video library. It looks like the rest of ecosys, and its layout borrows the best parts of Apple Photos and Google Photos.

## Finding your way around

- **Library.** The pill at the bottom switches between **Years**, **Months**, **Days** and **All** (keys `1` to `4`), as in Apple Photos. Click a year to see its months, and a month to see its days. In **All**, `Ctrl` + scroll, a trackpad pinch or the − / + buttons make the grid denser or bigger.
- **Days.** Photos are grouped by day under headers like "Today", "Saturday" or "Mon, Nov 2". Small days sit side by side, as in Google Photos. Hover a header and click its circle to select the whole day.
- **Memories.** A row at the top of Days with "On this day", "This week" and recent months. Click one to play it as a slideshow.
- **Date scrubber.** On a long library, drag down the right edge to jump through the years.
- **Search.** Use the bar at the top (`/`). Try a month ("july"), a year, a weekday, a camera ("iPhone"), an album name, "videos", "favorites", "landscape" or "not backed up".
- **Selecting.** Hover a photo and click its circle. Once something is selected, a click selects more and Shift-click selects a range. On a touch screen, press and hold. The selection bar has Favorite, Add to album, Download and Delete. `Ctrl+A` selects everything in view and `Esc` clears the selection.
- **The viewer.** Use the arrow keys or swipe to move between photos, double-click or scroll to zoom, and swipe down or press `Esc` to close. The filmstrip along the bottom jumps straight to a photo. Press `F` for Favorite and `I` for the info panel (date, file, camera, albums and backup status).
- **Albums.** The Albums page has **My Albums** (Favorites first), **Media Types** and **Utilities** (Recently Deleted, Cloud backup, Not backed up). Importing while an album is open puts the new photos straight into it.
- **Recently Deleted.** Deleted items stay for 30 days and can be recovered. After that they are deleted for good.
- **Import.** Use the Import button (`U`), drop files anywhere on the page, or paste an image. If you import a photo that's already in the library, Photos keeps one copy.

Photos reads the date taken, camera and exposure from each JPEG's EXIF data. For other formats it uses the file's date. HEIC files (from iPhones) are kept and backed up, but a browser that can't display HEIC shows a placeholder preview for them.

## Where photos are kept

Photos are too big for the shared ecosys data file, so each browser keeps its own library in IndexedDB. Photos asks the browser not to clear that storage, but browsers can still clear it if you clear site data. **Cloud backup is what keeps your photos safe.**

## Cloud backup

Connect **OneDrive** or **Google Drive** in Photos > **Cloud backup**. Backup works the way Samsung Gallery backs up to OneDrive:

- Photos makes a folder of its own in your cloud and sorts photos into year and month folders inside it:
  - OneDrive: `Pictures/ecosys Photos/2026/11/`
  - Google Drive: `My Drive/ecosys Photos/2026/11/`
  You can rename the folder.
- New photos and videos are backed up, newest first, whenever Photos is open in any tab. Only one tab uploads at a time. The cloud icon in the top bar and the card at the bottom of the sidebar always show where backup stands.
- **Delete from the cloud too** (on by default): when you delete a photo for good, its cloud copy goes to your OneDrive recycle bin or Google Drive trash, so you can still get it back there.
- **Free up space** removes originals that are safely backed up from this browser. Their previews stay, and an original downloads again when you open it. **Download originals** brings them all back.
- **Restore from OneDrive / Google Drive** brings photos from the backup folder into another browser or computer. It downloads previews only; originals download when you open them.

Photos signs in to your cloud directly from your browser. No ecosys server is involved, there is no client secret, and the sign-in stays in that browser. On Google Drive, Photos asks only for the `drive.file` permission, so it can see only the files it created.

### One-time setup: register Photos with your cloud

OneDrive and Google Drive only let an app sign in once it is registered. Registration is free. Do it once for each copy of ecosys, then either paste the ID into the box Photos shows when you click **Connect**, or put it in `photos/cloud-config.js` so every browser that opens this copy can use it.

When you click Connect, Photos shows the exact **redirect address** to register. It is this site's address plus `/photos/auth.html`.

**OneDrive** (Microsoft Entra ID)

1. Go to [App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) and choose **New registration**.
2. For supported account types, pick one that includes **personal Microsoft accounts**.
3. Under Redirect URI, choose **Single-page application (SPA)** and enter the redirect address, for example `http://localhost:4300/photos/auth.html`.
4. Copy the **Application (client) ID**. The permissions Photos asks for (`Files.ReadWrite`, `offline_access`, `User.Read`) are requested when you sign in.

Microsoft accepts `http://localhost` but not `http://127.0.0.1` as a redirect address. When you run ecosys on your computer, open it at **http://localhost:4300** to set up and use OneDrive backup.

A OneDrive sign-in renews itself as long as Photos is opened at least once a day. After a longer break, Photos asks you to sign in again.

**Google Drive** (Google Cloud console)

1. Turn on the [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) for a project.
2. Set up the **OAuth consent screen**: choose External, add yourself as a test user, and add the scope `https://www.googleapis.com/auth/drive.file`.
3. In [Credentials](https://console.cloud.google.com/apis/credentials), create an **OAuth client ID** of type **Web application**. Add your site's origin (for example `http://localhost:4300`) as an authorized JavaScript origin, and the redirect address as an authorized redirect URI.
4. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`).

Google gives browser apps sign-ins that last an hour and no way to renew them quietly. After an hour, backup pauses and **Sign in** continues it with one click; Google skips the account screen.

### The GitHub Pages copy

The Pages copy works the same way. Register `https://<you>.github.io/ecosys/photos/auth.html` as the redirect address and `https://<you>.github.io` as the origin. Its photos are kept in that browser, separate from your local copy.
