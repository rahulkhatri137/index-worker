# Google Drive Mirror — Cloudflare Worker

A lightweight Google Drive index and mirror running entirely on a Cloudflare Worker. It supports multiple roots across different Google accounts using a single OAuth application.

---

## Key Features

- **Multi-Root & Multi-Account:** Expose multiple Drive folders across separate Google accounts.
- **File Handling:** In-browser image previews, direct file downloads, and automatic Google Workspace conversions (Docs to PDF, Sheets to XLSX, Slides to PPTX).
- **Edge Caching:** Metadata and media caching powered by Cloudflare edge nodes.
- **Access Control:** Site-wide or per-root password protection.

---

## 1. Security Notice

This Worker relies on hardcoded configuration secrets at the top of `worker.js`.

* **Never commit real credentials** (`GOOGLE_CLIENT_SECRET`, `refreshToken`, passwords) to a public repository.
* **Use placeholders** in public commits. Rotate any keys immediately if accidentally exposed.

---

## 2. Requirements

- Google accounts for each target Drive.
- A Google Cloud project with the **Google Drive API** enabled.
- One **OAuth 2.0 Web Application** client ID and secret.
- A Cloudflare account and deployed Worker URL.

---

## 3. Configuration & Setup

### Step 1: Google Cloud Setup
1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.
2. Go to **APIs & Services > Library**, search for **Google Drive API**, and enable it.
3. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview):
   - Set application details under **Branding**.
   - Select **External** under **Audience**.
   - Add the restricted scope `https://www.googleapis.com/auth/drive.readonly`.
   - Change Publishing Status to **In Production** to prevent refresh tokens from expiring after 7 days.
4. Go to **Clients**, create a **Web application** client, and copy the Client ID and Secret.

### Step 2: Configure `worker.js`
Update the `CONFIG` object at the top of `worker.js`:

```js
const CONFIG = {
  WORKER_URL: 'https://my-drive-mirror.example.workers.dev',

  ENABLE_SITE_PASSWORD: true,
  SITE_PASSWORD: 'MASTER_PASSWORD',

  OAUTH_SCOPE: 'https://www.googleapis.com/auth/drive.readonly',
  GOOGLE_CLIENT_ID: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'YOUR_CLIENT_SECRET',

  ROOTS: [
    {
      name: 'Main Drive',
      accountLabel: 'account1@gmail.com',
      refreshToken: 'REFRESH_TOKEN_1',
      rootId: 'root',
      password: '', // Inherits SITE_PASSWORD
    },
    {
      name: 'Secondary Folder',
      accountLabel: 'account2@gmail.com',
      refreshToken: 'REFRESH_TOKEN_2',
      rootId: 'YOUR_FOLDER_ID',
      password: 'OPTIONAL_ROOT_PASSWORD',
    },
  ],

  PAGE_SIZE: 1000,
  METADATA_CACHE_SECONDS: 60,
  MEDIA_CACHE_SECONDS: 3600,
};
```

### Step 3: OAuth Authentication & Token Generation
1. Deploy the initial Worker.
2. In Google Cloud Console, set the Authorized Redirect URI to:
   ```text
   https://<your-worker-url>/oauth2callback
   ```
3. Visit the temporary authentication endpoints in your browser to authorize each account:
   - `https://<your-worker-url>/auth?account=0`
   - `https://<your-worker-url>/auth?account=1`
4. Copy the resulting `refresh_token` into the corresponding entry in `CONFIG.ROOTS`.
5. Redeploy the Worker with updated tokens.

---

## 4. Deployment Methods

### Option A: Cloudflare Dashboard
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) > **Workers & Pages**.
2. Click **Create Application > Create Worker**.
3. Paste the contents of `worker.js` into the online editor and click **Save and Deploy**.

### Option B: Wrangler CLI
```bash
npm create cloudflare@latest -- google-drive-mirror
cd google-drive-mirror
# Replace src/index.js with worker.js
npx wrangler deploy
```

---

## 5. Post-Deployment Checklist

- [ ] Confirm all Drive roots load independently.
- [ ] Disable or remove `/auth` and `/oauth2callback` routes in `worker.js` for production security.
- [ ] Ensure public Git commits only contain placeholder credentials.

---

## 6. Route Structure

- **Index Home:** `/`
- **Root Indices:** `/0:/`, `/1:/`, `/2:/`
- **Image Previews:** `/0:/image/FILE_ID`
- **File Downloads:** `/0:/download/FILE_ID`