// GOOGLE DRIVE MIRROR - CLOUDFLARE WORKER

const CONFIG = {
  WORKER_URL: 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev',
  ENABLE_SITE_PASSWORD: false,
  SITE_PASSWORD: 'CHANGE-ME',
  OAUTH_SCOPE: 'https://www.googleapis.com/auth/drive.readonly',
  GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'YOUR_GOOGLE_OAUTH_CLIENT_SECRET',

  ROOTS: [
    {
      name: 'Account 1 - Main',
      accountLabel: 'account1@example.com',
      refreshToken: 'REFRESH_TOKEN_FOR_ACCOUNT_1',
      rootId: 'root',
      password: '',
    },
    {
      name: 'Account 2 - Movies',
      accountLabel: 'account2@example.com',
      refreshToken: 'REFRESH_TOKEN_FOR_ACCOUNT_2',
      rootId: 'YOUR_FOLDER_OR_SHARED_DRIVE_ROOT_ID',
      password: 'DRIVE-2-PASSWORD',
    }
  ],

  PAGE_SIZE: 1000,
  METADATA_CACHE_SECONDS: 60,
  MEDIA_CACHE_SECONDS: 3600,
};

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_TTL_MS = 50 * 60 * 1000;
const tokenCache = new Map();

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}

function formatDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('en-IN');
}

function isImageMime(mime) {
  return typeof mime === 'string' && mime.startsWith('image/');
}

function isFolder(file) {
  return file?.mimeType === 'application/vnd.google-apps.folder';
}

function isGoogleWorkspaceFile(file) {
  return typeof file?.mimeType === 'string' && file.mimeType.startsWith('application/vnd.google-apps.');
}

function contentDisposition(filename, inline = false) {
  const safe = String(filename || 'download').replace(/[\r\n"]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${safe}"`;
}

function rootByIndex(index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n >= CONFIG.ROOTS.length) return null;
  return CONFIG.ROOTS[n];
}

function rootIndexFromPath(pathname) {
  const m = pathname.match(/^\/(\d+):(?:\/|$)/);
  return m ? Number(m[1]) : null;
}

function rootPrefix(index) {
  return `/${index}:/`;
}

function driveUrl(index, folderId = null) {
  const u = new URL(CONFIG.WORKER_URL);
  u.pathname = rootPrefix(index);
  if (folderId) u.searchParams.set('folder', folderId);
  return u.toString();
}

function imageUrl(index, fileId) {
  return `${CONFIG.WORKER_URL.replace(/\/$/, '')}/${index}:/image/${encodeURIComponent(fileId)}`;
}

function downloadUrl(index, fileId) {
  return `${CONFIG.WORKER_URL.replace(/\/$/, '')}/${index}:/download/${encodeURIComponent(fileId)}`;
}

function responseHtml(body, status = 200, extraHeaders = {}) {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Drive Mirror</title></head><body>${body}</body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function errorPage(title, message, status = 500) {
  return responseHtml(`
    <style>${BASE_CSS}</style>
    <main class="container">
      <div class="error-card">
        <h1>${htmlEscape(title)}</h1>
        <p>${htmlEscape(message)}</p>
        <p><a href="${htmlEscape(CONFIG.WORKER_URL)}">Back to index</a></p>
      </div>
    </main>`, status);
}

function authUrl(accountIndex, requestUrl) {
  const root = rootByIndex(accountIndex);
  if (!root) return null;

  const redirect = `${new URL(requestUrl).origin}/oauth2callback`;
  const state = btoa(JSON.stringify({ accountIndex, t: Date.now() }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', CONFIG.GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', CONFIG.OAUTH_SCOPE);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  if (root.accountLabel && !root.accountLabel.includes('example.com')) {
    u.searchParams.set('login_hint', root.accountLabel);
  }
  return u.toString();
}

async function exchangeCode(code, requestUrl) {
  const redirect = `${new URL(requestUrl).origin}/oauth2callback`;
  const body = new URLSearchParams({
    code,
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    client_secret: CONFIG.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirect,
    grant_type: 'authorization_code',
  });

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || data.error || 'Google token exchange failed');
  return data;
}

async function getAccessToken(index) {
  const root = rootByIndex(index);
  if (!root) throw new Error('Unknown drive root');
  if (!root.refreshToken || root.refreshToken.startsWith('REFRESH_TOKEN_')) {
    throw new Error('No refresh token configured for this root');
  }

  const cached = tokenCache.get(index);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const body = new URLSearchParams({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    client_secret: CONFIG.GOOGLE_CLIENT_SECRET,
    refresh_token: root.refreshToken,
    grant_type: 'refresh_token',
  });

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Google access token refresh failed');
  }

  tokenCache.set(index, {
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.min((data.expires_in || 3600) * 1000, TOKEN_TTL_MS),
  });

  return data.access_token;
}

async function driveFetch(index, path, options = {}, retry = true) {
  const token = await getAccessToken(index);
  const url = `${DRIVE_API}${path}`;
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);

  const r = await fetch(url, { ...options, headers });

  if (r.status === 401 && retry) {
    tokenCache.delete(index);
    return driveFetch(index, path, options, false);
  }

  return r;
}

async function getFile(index, fileId) {
  const fields = [
    'id', 'name', 'mimeType', 'size', 'modifiedTime', 'createdTime',
    'parents', 'description', 'webViewLink', 'iconLink', 'thumbnailLink',
    'capabilities(canDownload)', 'driveId',
  ].join(',');

  const r = await driveFetch(index, `/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Drive API ${r.status}: ${text.slice(0, 500)}`);
  }
  return r.json();
}

async function listChildren(index, folderId) {
  const files = [];
  let pageToken = '';
  const q = `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`;
  const fields = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,parents,description,iconLink,thumbnailLink,capabilities(canDownload),driveId)';

  do {
    const params = new URLSearchParams({
      q,
      pageSize: String(CONFIG.PAGE_SIZE),
      orderBy: 'folder,name_natural',
      fields,
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const r = await driveFetch(index, `/files?${params.toString()}`);
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Drive API ${r.status}: ${text.slice(0, 500)}`);
    }

    const data = await r.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return files;
}

async function searchFiles(index, query) {
  const files = [];
  let pageToken = '';
  const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `trashed = false and name contains '${escaped}'`;
  const fields = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,thumbnailLink,capabilities(canDownload))';

  do {
    const params = new URLSearchParams({
      q,
      pageSize: '100',
      orderBy: 'name_natural',
      fields,
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const r = await driveFetch(index, `/files?${params.toString()}`);
    if (!r.ok) throw new Error(`Search failed (${r.status})`);
    const data = await r.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken && files.length < 500);

  return files;
}

async function getMedia(index, file) {
  if (isGoogleWorkspaceFile(file)) {
    return exportGoogleFile(index, file);
  }

  const r = await driveFetch(index, `/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Download failed (${r.status}): ${text.slice(0, 500)}`);
  }
  return r;
}

async function exportGoogleFile(index, file) {
  const exportMap = {
    'application/vnd.google-apps.document': 'application/pdf',
    'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  const mime = exportMap[file.mimeType];
  if (!mime) throw new Error('This Google Workspace file type cannot be exported by this mirror.');

  const r = await driveFetch(index, `/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(mime)}`);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Export failed (${r.status}): ${text.slice(0, 500)}`);
  }
  return new Response(r.body, {
    status: r.status,
    headers: {
      'Content-Type': mime,
      'Content-Disposition': contentDisposition(file.name + exportExtension(mime), false),
      'Cache-Control': `public, max-age=${CONFIG.MEDIA_CACHE_SECONDS}`,
    },
  });
}

function exportExtension(mime) {
  if (mime === 'application/pdf') return '.pdf';
  if (mime.includes('spreadsheetml')) return '.xlsx';
  if (mime.includes('presentationml')) return '.pptx';
  return '';
}

const BASE_CSS = `
:root{color-scheme:dark;--bg:#07090d;--panel:#0e1218;--panel2:#131922;--line:rgba(255,255,255,.075);--line2:rgba(255,255,255,.14);--text:#f4f7fb;--muted:#8994a5;--accent:#9cc8ff;--accent2:#c7a8ff;--good:#71d7a0;--danger:#ff8585;--shadow:0 22px 70px rgba(0,0,0,.34)}
*{box-sizing:border-box}html{min-height:100%;background:var(--bg);scroll-behavior:smooth}body{margin:0;min-height:100vh;background:radial-gradient(900px 520px at 12% -8%,rgba(86,133,255,.15),transparent 62%),radial-gradient(800px 500px at 96% 2%,rgba(177,105,255,.12),transparent 60%),linear-gradient(180deg,#090c12 0%,#07090d 70%);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.container{width:min(1240px,100%);margin:0 auto;padding:26px 22px 92px}.top{display:flex;gap:20px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:18px}.brand{display:flex;gap:13px;align-items:center;min-width:0}.brand-mark{width:46px;height:46px;flex:0 0 46px;display:grid;place-items:center;border:1px solid var(--line2);border-radius:15px;background:linear-gradient(145deg,rgba(156,200,255,.18),rgba(198,167,255,.08));box-shadow:0 10px 34px rgba(0,0,0,.24)}.brand-mark svg{width:23px;height:23px}.eyebrow{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#7e8999;font-weight:800;margin-bottom:4px}.brand h1{font-size:22px;line-height:1.15;margin:0;font-weight:760;letter-spacing:-.025em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55vw}.title-sub{font-size:12px;color:var(--muted);margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55vw}.search{display:flex;gap:8px;min-width:min(460px,100%)}.search-wrap{position:relative;flex:1;min-width:0}.search-wrap svg{position:absolute;left:13px;top:50%;width:17px;height:17px;transform:translateY(-50%);color:#788394;pointer-events:none}.search input{padding-left:40px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}input,input,button,select{font:inherit}input{width:100%;background:rgba(255,255,255,.045);color:var(--text);border:1px solid var(--line2);border-radius:13px;padding:11px 13px;outline:none;transition:.18s}input:focus,select:focus{border-color:rgba(156,200,255,.55);box-shadow:0 0 0 3px rgba(156,200,255,.09)}button,.select{background:rgba(255,255,255,.055);color:#edf2f8;border:1px solid var(--line2);border-radius:11px;padding:10px 13px;font-weight:700;cursor:pointer;transition:.18s}.search button{background:#eef4ff;color:#10141b;border:0;padding:11px 16px;box-shadow:0 7px 22px rgba(0,0,0,.18)}button:hover{transform:translateY(-1px);background:rgba(255,255,255,.09)}button.active{background:rgba(156,200,255,.14);border-color:rgba(156,200,255,.35);color:#d9eaff}.roots{display:flex;gap:8px;overflow:auto;padding:3px 1px 12px;margin-bottom:4px;scrollbar-width:thin}.root{display:inline-flex;align-items:center;gap:8px;white-space:nowrap;padding:9px 13px;border:1px solid var(--line);border-radius:999px;text-decoration:none;color:#dce3ed;background:rgba(255,255,255,.035);font-size:13px;font-weight:650;transition:.18s}.root:hover,.root.active{border-color:rgba(156,200,255,.28);background:rgba(156,200,255,.09);transform:translateY(-1px)}.root-dot{width:7px;height:7px;border-radius:50%;background:var(--good);box-shadow:0 0 10px rgba(116,215,161,.45)}.crumbs{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:12px 0;color:var(--muted);font-size:13px}.crumbs a{color:#c8d8ee;text-decoration:none}.crumbs a:hover{text-decoration:underline}.crumb-sep{opacity:.35}.panel{border:1px solid var(--line);background:linear-gradient(145deg,rgba(255,255,255,.045),rgba(255,255,255,.018));border-radius:18px;box-shadow:var(--shadow);backdrop-filter:blur(14px)}.summary{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 15px;margin:0 0 12px}.summary-left{display:flex;align-items:center;gap:10px;min-width:0}.summary-icon{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:rgba(116,215,161,.10);color:var(--good);flex:0 0 34px}.summary-icon svg{width:18px}.summary-count{font-size:13px;font-weight:750}.summary-note{font-size:11px;color:var(--muted);margin-top:2px}.summary-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.summary-actions select{background:rgba(255,255,255,.045);color:#e9eef5;border:1px solid var(--line2);border-radius:10px;padding:9px 11px;outline:none}.view-toggle{display:flex;gap:3px;padding:3px;background:rgba(255,255,255,.045);border:1px solid var(--line);border-radius:11px}.view-toggle button{padding:7px 9px;border:0;background:transparent;border-radius:8px}.view-toggle button.active{background:rgba(255,255,255,.09);color:#fff}.filter-row{display:flex;gap:7px;overflow:auto;margin:0 0 12px;padding:1px 1px 3px;scrollbar-width:none}.filter-row::-webkit-scrollbar{display:none}.filter{white-space:nowrap;border-radius:999px;padding:7px 11px;font-size:11px;background:rgba(255,255,255,.035);border:1px solid var(--line);color:#aeb8c7}.filter.active{color:#e8f2ff;border-color:rgba(156,200,255,.3);background:rgba(156,200,255,.10)}.back{display:inline-flex;align-items:center;gap:7px;color:#c9d7e8;text-decoration:none;font-size:13px;font-weight:650;margin:0 0 13px}.back:hover{color:#fff}
.file-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(225px,1fr));gap:12px}.card{position:relative;display:block;min-height:188px;border:1px solid var(--line);border-radius:17px;padding:0;background:linear-gradient(150deg,rgba(20,24,32,.96),rgba(10,13,18,.96));color:var(--text);text-decoration:none;overflow:hidden;transition:transform .18s,border-color .18s,background .18s,box-shadow .18s}.card:hover{transform:translateY(-3px);border-color:rgba(156,200,255,.25);box-shadow:0 16px 40px rgba(0,0,0,.27)}.thumb{height:112px;background:linear-gradient(145deg,#151b25,#0e1219);display:grid;place-items:center;overflow:hidden;border-bottom:1px solid var(--line);position:relative}.thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .3s}.card:hover .thumb img{transform:scale(1.035)}.thumb-icon{width:46px;height:46px;display:grid;place-items:center;border-radius:14px;background:rgba(255,255,255,.055);color:#cdd9ea}.thumb-icon svg{width:24px;height:24px}.thumb-type{position:absolute;left:9px;top:9px;padding:4px 7px;border-radius:7px;background:rgba(5,7,10,.72);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.12);font-size:9px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}.card-body{padding:12px 13px 13px}.name{font-weight:700;font-size:13.5px;line-height:1.38;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.meta{font-size:10.5px;color:var(--muted);margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.file-type{display:none}.list-view .file-grid{display:flex;flex-direction:column;gap:7px}.list-view .card{min-height:0;display:grid;grid-template-columns:64px minmax(0,1fr) auto;align-items:center;padding:8px;border-radius:13px}.list-view .thumb{width:56px;height:56px;border:0;border-radius:9px}.list-view .thumb-type{display:none}.list-view .thumb img{border-radius:9px}.list-view .card-body{padding:3px 10px}.list-view .name{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.list-view .meta{margin-top:4px}.list-view .card:after{content:'›';font-size:22px;color:#5e6877;padding:0 8px}.empty{padding:48px 20px;text-align:center;color:var(--muted)}.empty strong{display:block;color:#dfe5ed;font-size:15px;margin-bottom:5px}.error-card{max-width:700px;margin:70px auto;padding:26px;border:1px solid rgba(255,133,133,.20);border-radius:18px;background:linear-gradient(145deg,rgba(80,25,30,.35),rgba(20,16,20,.9));box-shadow:var(--shadow)}.error-card h1{font-size:22px;color:#ff9a9a;margin:0 0 9px}.error-card p{color:#c0c7d1;line-height:1.6}.muted{color:var(--muted)}.status{padding:11px 14px;border-radius:12px;background:rgba(255,255,255,.035);margin:8px 0}.status.bad{border:1px solid rgba(255,133,133,.25)}.status.ok{border:1px solid rgba(116,215,161,.14)}.viewer{max-width:1280px;margin:auto;padding:20px;text-align:center}.viewer-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}.viewer img{max-width:100%;max-height:82vh;object-fit:contain;border-radius:14px;border:1px solid var(--line);box-shadow:0 24px 80px rgba(0,0,0,.42)}.actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:14px}.actions a{display:inline-flex;align-items:center;gap:7px;padding:9px 13px;border:1px solid var(--line2);border-radius:10px;color:#e9eef5;text-decoration:none;background:rgba(255,255,255,.04);font-size:13px;font-weight:650}.actions a:hover{background:rgba(255,255,255,.08)}textarea{font:inherit}.login{max-width:420px;margin:90px auto}.login .panel{padding:24px}.login h1{margin:0 0 7px;font-size:21px}.login form{display:flex;gap:8px;margin-top:18px}.footer{padding-top:28px;text-align:center;color:#626d7c;font-size:11px}.mobile-nav{display:none}
@media(max-width:700px){.container{padding:17px 13px 82px}.top{align-items:stretch;margin-bottom:14px}.brand{width:100%}.brand h1{max-width:calc(100vw - 90px)}.title-sub{max-width:calc(100vw - 90px)}.search{width:100%;min-width:0}.search input{min-width:0}.file-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.card{min-height:170px;border-radius:14px}.thumb{height:94px}.card-body{padding:10px 11px 11px}.name{font-size:12.5px}.meta{font-size:10px}.summary{padding:11px 12px}.summary-actions select{max-width:115px}.roots{margin-right:-13px;padding-right:13px}.crumbs{margin:9px 0}.mobile-nav{position:fixed;display:flex;z-index:50;left:10px;right:10px;bottom:10px;height:58px;padding:5px;gap:3px;background:rgba(13,17,24,.90);border:1px solid rgba(255,255,255,.12);border-radius:18px;backdrop-filter:blur(18px);box-shadow:0 14px 45px rgba(0,0,0,.45);padding-bottom:max(5px,env(safe-area-inset-bottom))}.mobile-nav button{flex:1;border:0;background:transparent;padding:5px 4px;color:#7f8999;border-radius:12px;font-size:9px;font-weight:750}.mobile-nav button svg{display:block;width:18px;height:18px;margin:0 auto 2px}.mobile-nav button.active{background:rgba(156,200,255,.10);color:#dcecff}.login{margin:50px auto}.login form{flex-direction:column}.footer{padding-bottom:5px}}@media(max-width:410px){.file-grid{grid-template-columns:1fr}.card{min-height:145px}.thumb{height:92px}.list-view .file-grid{gap:6px}.list-view .card{grid-template-columns:56px minmax(0,1fr) auto}.list-view .thumb{width:48px;height:48px}}
`;


function svgIcon(kind) {
  const icons = {
    folder:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3.5 6.5h6l2 2H20.5v9a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"/><path d="M2.5 10h19"/></svg>',
    image:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.4"/><path d="m4.5 17 5-5 3.5 3 2.5-2.5 4 4.5"/></svg>',
    video:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 10 5-3v10l-5-3z"/></svg>',
    audio:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    pdf:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M8.5 16h7M8.5 12h4"/></svg>',
    doc:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
    box:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4.5 7.8 7.5 4.3 7.5-4.3M12 12v9"/></svg>'
  };
  return icons[kind] || icons.box;
}

function fileKind(file) {
  if (isFolder(file)) return 'folder';
  if (isImageMime(file.mimeType)) return 'image';
  if (file.mimeType?.startsWith('video/')) return 'video';
  if (file.mimeType?.startsWith('audio/')) return 'audio';
  if (file.mimeType === 'application/pdf') return 'pdf';
  if (isGoogleWorkspaceFile(file)) return 'doc';
  return 'box';
}

function fileIcon(file) { return svgIcon(fileKind(file)); }

function renderRootButtons() {
  return CONFIG.ROOTS.map((r, i) => `<a class="root" href="${htmlEscape(rootPrefix(i))}"><span class="root-dot"></span>${htmlEscape(r.name || `Drive ${i}`)}</a>`).join('');
}

function fileTypeLabel(file) {
  if (isFolder(file)) return 'Folder';
  if (isImageMime(file.mimeType)) return 'Image';
  if (file.mimeType?.startsWith('video/')) return 'Video';
  if (file.mimeType?.startsWith('audio/')) return 'Audio';
  if (file.mimeType === 'application/pdf') return 'PDF';
  if (isGoogleWorkspaceFile(file)) return 'Google file';
  const ext = file.name?.includes('.') ? file.name.split('.').pop() : 'File';
  return String(ext || 'File').slice(0, 8).toUpperCase();
}

function renderFileCard(file, index) {
  const href = isFolder(file)
    ? `${rootPrefix(index)}?folder=${encodeURIComponent(file.id)}`
    : (isImageMime(file.mimeType) ? imageUrl(index, file.id) : downloadUrl(index, file.id));
  const target = !isFolder(file) && isImageMime(file.mimeType) ? '' : ' target="_blank" rel="noopener"';
  const kind = fileKind(file);
  const type = fileTypeLabel(file);
  const thumb = (!isFolder(file) && isImageMime(file.mimeType) && file.thumbnailLink)
    ? `<img loading="lazy" src="${htmlEscape(file.thumbnailLink)}" alt="" referrerpolicy="no-referrer">`
    : `<div class="thumb-icon">${fileIcon(file)}</div>`;
  return `<a class="card" data-kind="${htmlEscape(kind)}" data-name="${htmlEscape((file.name||'').toLowerCase())}" data-size="${htmlEscape(file.size || 0)}" data-date="${htmlEscape(file.modifiedTime || '')}" href="${htmlEscape(href)}"${target} aria-label="${htmlEscape(file.name)}">
    <div class="thumb">${thumb}<span class="thumb-type">${htmlEscape(type)}</span></div>
    <div class="card-body"><div class="name">${htmlEscape(file.name)}</div><div class="meta">${isFolder(file) ? 'Folder' : `${htmlEscape(formatBytes(file.size))} · ${htmlEscape(formatDate(file.modifiedTime))}`}</div></div>
  </a>`;
}

function renderSearchResults(results, index) {
  if (!results.length) return '<div class="panel empty"><strong>No files found</strong>Try a different search term.</div>';
  return `<div class="grid">${results.map(f => renderFileCard(f, index)).join('')}</div>`;
}

async function renderIndex(index, requestUrl) {
  const root = rootByIndex(index);
  if (!root) return errorPage('Drive not found', 'That drive root does not exist.', 404);

  const u = new URL(requestUrl);
  const folderId = u.searchParams.get('folder') || root.rootId;
  const q = u.searchParams.get('q')?.trim() || '';

  let files;
  try {
    files = q ? await searchFiles(index, q) : await listChildren(index, folderId);
  } catch (e) {
    return errorPage(`${root.name || `Drive ${index}`} unavailable`, e.message, 503);
  }

  let folder = null;
  if (!q && folderId !== root.rootId) {
    try { folder = await getFile(index, folderId); } catch (_) {}
  }

  const parentUrl = folder?.parents?.[0]
    ? `${rootPrefix(index)}?folder=${encodeURIComponent(folder.parents[0])}`
    : rootPrefix(index);
  const itemLabel = `${files.length} item${files.length === 1 ? '' : 's'}`;
  const cards = files.map(f => renderFileCard(f, index)).join('');

  return responseHtml(`
    <style>${BASE_CSS}</style>
    <main class="container" id="app">
      <header class="top">
        <div class="brand">
          <div class="brand-mark">${svgIcon('folder')}</div>
          <div><div class="eyebrow">Drive mirror</div><h1>${htmlEscape(root.name || `Drive ${index}`)}</h1><div class="title-sub">${htmlEscape(root.accountLabel || 'Connected storage')}</div></div>
        </div>
        <form class="search" method="get">
          ${folder ? `<input type="hidden" name="folder" value="${htmlEscape(folderId)}">` : ''}
          <div class="search-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input name="q" value="${htmlEscape(q)}" placeholder="Search files and folders" autocomplete="off"></div>
          <button type="submit">Search</button>
        </form>
      </header>

      <nav class="roots" aria-label="Drives">${renderRootButtons()}</nav>
      <div class="crumbs"><a href="${htmlEscape(rootPrefix(index))}">Root</a>${folder ? `<span class="crumb-sep">/</span><span>${htmlEscape(folder.name)}</span>` : ''}${q ? `<span class="crumb-sep">/</span><span>Search: ${htmlEscape(q)}</span>` : ''}</div>
      ${folder && !q ? `<a class="back" href="${htmlEscape(parentUrl)}">← <span>Parent folder</span></a>` : ''}

      <section class="panel summary">
        <div class="summary-left"><div class="summary-icon">${svgIcon('folder')}</div><div><div class="summary-count" id="item-count">${htmlEscape(itemLabel)}</div><div class="summary-note" id="summary-note">${q ? 'Search results' : (folder ? 'Current folder' : 'Drive root')}</div></div></div>
        <div class="summary-actions">
          <select id="sort-select" aria-label="Sort files"><option value="name-asc">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="date-desc">Newest</option><option value="date-asc">Oldest</option><option value="size-desc">Largest</option><option value="size-asc">Smallest</option></select>
          <div class="view-toggle" aria-label="View mode"><button id="grid-btn" class="active" type="button" title="Grid view">${svgIcon('box')}</button><button id="list-btn" type="button" title="List view">${svgIcon('doc')}</button></div>
          ${q ? `<a class="back" style="margin:0" href="${htmlEscape(rootPrefix(index))}">Clear</a>` : ''}
        </div>
      </section>

      <div class="filter-row" id="filters" aria-label="File type filters">
        <button class="filter active" data-filter="all" type="button">All</button><button class="filter" data-filter="folder" type="button">Folders</button><button class="filter" data-filter="image" type="button">Images</button><button class="filter" data-filter="video" type="button">Videos</button><button class="filter" data-filter="audio" type="button">Audio</button><button class="filter" data-filter="pdf" type="button">PDF</button><button class="filter" data-filter="doc" type="button">Documents</button>
      </div>

      <div id="file-area" class="file-area"><div class="file-grid">${cards}</div></div>
      ${!files.length ? `<div class="panel empty" id="server-empty"><strong>This folder is empty</strong><span>No files or folders to display here.</span></div>` : ''}
      <div class="footer">Google Drive Mirror · Securely served by Cloudflare Workers</div>

      <nav class="mobile-nav" aria-label="Mobile navigation">
        <button type="button" class="active" data-mobile="home">${svgIcon('folder')}Home</button>
        <button type="button" data-mobile="search">${svgIcon('image')}Search</button>
        <button type="button" data-mobile="view">${svgIcon('box')}View</button>
        <button type="button" data-mobile="sort">${svgIcon('doc')}Sort</button>
      </nav>
    </main>
    <script>
    (()=>{
      const app=document.getElementById('app'), area=document.getElementById('file-area'), grid=area?.querySelector('.file-grid');
      const cards=[...document.querySelectorAll('.card')], count=document.getElementById('item-count'), sort=document.getElementById('sort-select');
      let filter='all', list=false;
      const setCount=n=>{if(count) count.textContent=n+' item'+(n===1?'':'s')};
      function apply(){
        if(!grid)return;
        const visible=cards.filter(c=>filter==='all'||c.dataset.kind===filter||(filter==='doc'&&c.dataset.kind==='doc'));
        const mode=sort?.value||'name-asc';
        visible.sort((a,b)=>{
          if(mode.startsWith('name')) return (a.dataset.name.localeCompare(b.dataset.name,undefined,{numeric:true}))*(mode==='name-desc'?-1:1);
          if(mode.startsWith('date')) return ((new Date(a.dataset.date||0))-(new Date(b.dataset.date||0)))*(mode==='date-desc'?-1:1);
          const d=(Number(a.dataset.size)||0)-(Number(b.dataset.size)||0); return d*(mode==='size-desc'?-1:1);
        });
        cards.forEach(c=>c.style.display='none'); visible.forEach(c=>{c.style.display='';grid.appendChild(c)}); setCount(visible.length);
        const empty=document.getElementById('client-empty');
        if(visible.length===0){ if(!empty){const e=document.createElement('div');e.id='client-empty';e.className='panel empty';e.innerHTML='<strong>No matching files</strong><span>Try another filter or search.</span>';area.after(e)}} else empty?.remove();
      }
      document.querySelectorAll('.filter').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.filter').forEach(x=>x.classList.remove('active'));b.classList.add('active');filter=b.dataset.filter;apply()}));
      sort?.addEventListener('change',apply);
      const setView=v=>{list=v;app.classList.toggle('list-view',v);document.getElementById('grid-btn')?.classList.toggle('active',!v);document.getElementById('list-btn')?.classList.toggle('active',v);localStorage.setItem('drive-view',v?'list':'grid')};
      document.getElementById('grid-btn')?.addEventListener('click',()=>setView(false)); document.getElementById('list-btn')?.addEventListener('click',()=>setView(true));
      if(localStorage.getItem('drive-view')==='list')setView(true);
      document.querySelectorAll('[data-mobile]').forEach(b=>b.addEventListener('click',()=>{const a=b.dataset.mobile;if(a==='home'){location.href='${htmlEscape(rootPrefix(index))}'}if(a==='search'){document.querySelector('.search input')?.focus();window.scrollTo({top:0,behavior:'smooth'})}if(a==='view')setView(!list);if(a==='sort'){sort?.focus();sort?.showPicker?.()}}));
      apply();
    })();
    </script>`);
}

async function renderImage(index, fileId, request) {
  let file;
  try {
    file = await getFile(index, fileId);
  } catch (e) {
    return errorPage('Image unavailable', e.message, 404);
  }

  if (!isImageMime(file.mimeType)) {
    return Response.redirect(downloadUrl(index, fileId), 302);
  }

  let r;
  try {
    r = await driveFetch(index, `/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
  } catch (e) {
    return errorPage('Image unavailable', e.message, 503);
  }

  if (!r.ok) return errorPage('Image unavailable', `Google Drive returned HTTP ${r.status}.`, 503);

  const headers = new Headers(r.headers);
  headers.set('Content-Type', file.mimeType);
  headers.set('Content-Disposition', contentDisposition(file.name, true));
  headers.set('Cache-Control', `public, max-age=${CONFIG.MEDIA_CACHE_SECONDS}`);
  headers.delete('set-cookie');
  return new Response(r.body, { status: 200, headers });
}

async function downloadFile(index, fileId) {
  let file;
  try {
    file = await getFile(index, fileId);
  } catch (e) {
    return errorPage('File unavailable', e.message, 404);
  }

  if (file.capabilities && file.capabilities.canDownload === false) {
    return errorPage('Download unavailable', 'Google Drive does not permit this file to be downloaded.', 403);
  }

  try {
    const r = await getMedia(index, file);
    if (r instanceof Response) return r;

    const headers = new Headers(r.headers);
    headers.set('Content-Type', file.mimeType || 'application/octet-stream');
    headers.set('Content-Disposition', contentDisposition(file.name, false));
    headers.set('Cache-Control', `public, max-age=${CONFIG.MEDIA_CACHE_SECONDS}`);
    headers.delete('set-cookie');
    return new Response(r.body, { status: 200, headers });
  } catch (e) {
    return errorPage('Download failed', e.message, 503);
  }
}.

function rootAuth(index) {
  const root = rootByIndex(index);
  if (!root) return { password: '', scope: String(index) };

  const drivePassword = String(root.password || '');
  if (drivePassword) return { password: drivePassword, scope: String(index), isDrivePassword: true };

  const masterPassword = CONFIG.ENABLE_SITE_PASSWORD ? String(CONFIG.SITE_PASSWORD || '') : '';
  return { password: masterPassword, scope: 'master', isDrivePassword: false };
}

function rootPassword(index) {
  return rootAuth(index).password;
}

function authRequiredForRoot(index) {
  return !!rootPassword(index);
}

function cookieValue(cookieHeader, name) {
  const parts = String(cookieHeader || '').split(';');
  for (const part of parts) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key === name) return decodeURIComponent(part.slice(i + 1));
  }
  return '';
}

async function authCookieValue(scope, password) {
  const data = new TextEncoder().encode(`drive-mirror|${scope}|${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function isAuthenticated(request, scope, password) {
  if (!password) return true;
  const cookie = request.headers.get('Cookie') || '';
  const expected = await authCookieValue(scope, password);
  return cookieValue(cookie, `drive_mirror_auth_${scope}`) === expected;
}

function safeLoginNext(value, fallback = '/') {
  const next = String(value || '');
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/login')) return fallback;
  return next;
}

async function unauthorized(scope = 'master', next = '/') {
  const title = scope === 'master' ? 'Authentication required' : `Password required for ${rootByIndex(Number(scope))?.name || `Drive ${scope}`}`;
  const placeholder = scope === 'master' ? 'Master password' : 'Drive password';
  return responseHtml(`
    <style>${BASE_CSS}</style>
    <main class="container"><div class="error-card">
      <h1>${htmlEscape(title)}</h1>
      <p class="muted">Enter the password to continue.</p>
      <form method="post" action="/login">
        <input type="hidden" name="scope" value="${htmlEscape(scope)}">
        <input type="hidden" name="next" value="${htmlEscape(next)}">
        <input type="password" name="password" placeholder="${htmlEscape(placeholder)}" autocomplete="current-password" autofocus>
        <button type="submit">Enter</button>
      </form>
    </div></main>`, 401, { 'WWW-Authenticate': 'Basic realm="Drive Mirror"' });
}

async function checkSitePassword(request, index = null) {
  const auth = index === null
    ? { password: CONFIG.ENABLE_SITE_PASSWORD ? String(CONFIG.SITE_PASSWORD || '') : '', scope: 'master' }
    : rootAuth(index);
  if (!auth.password) return true;
  return isAuthenticated(request, auth.scope, auth.password);
}

async function login(request) {
  const form = await request.formData();
  const scope = String(form.get('scope') || 'master');
  const next = safeLoginNext(form.get('next'), '/');
  let password = '';
  let expectedPassword = '';

  let authScope = scope;
  if (scope === 'master') {
    expectedPassword = CONFIG.ENABLE_SITE_PASSWORD ? String(CONFIG.SITE_PASSWORD || '') : '';
    password = String(form.get('password') || '');
  } else if (/^\d+$/.test(scope) && rootByIndex(Number(scope))) {
    const index = Number(scope);
    const auth = rootAuth(index);
    expectedPassword = auth.password;
    authScope = auth.scope;
    password = String(form.get('password') || '');
  } else {
    return errorPage('Invalid authentication scope', 'That login scope does not exist.', 400);
  }

  if (!expectedPassword || password !== expectedPassword) {
    return unauthorized(scope, next);
  }

  const token = await authCookieValue(authScope, expectedPassword);
  const cookieName = `drive_mirror_auth_${authScope}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: next,
      'Set-Cookie': `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/login' && request.method === 'POST') return login(request);
    if (path === '/') {
      if (!(await checkSitePassword(request, null))) return unauthorized('master', '/');

      const links = CONFIG.ROOTS.map((r, i) => `<div class="status"><a href="${htmlEscape(rootPrefix(i))}">${htmlEscape(r.name || `Drive ${i}`)}</a><div class="meta">${htmlEscape(r.accountLabel || '')}</div></div>`).join('');
      return responseHtml(`<style>${BASE_CSS}</style><main class="container"><div class="top"><h1>Google Drive Mirror</h1></div>${links}</main>`);
    }

    // OAuth helper routes for initial setup only
    if (path === '/auth' || path === '/oauth2callback') {
      if (!(await checkSitePassword(request, null))) return unauthorized('master', path + (url.search || ''));
    }
    if (path === '/auth') {
      const index = Number(url.searchParams.get('account'));
      const link = authUrl(index, request.url);
      if (!link) return errorPage('Invalid account', 'Use /auth?account=0, /auth?account=1, etc.', 400);
      return Response.redirect(link, 302);
    }

    if (path === '/oauth2callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error) return errorPage('Google authorization failed', error, 400);
      if (!code) return errorPage('Missing authorization code', 'Google did not return an authorization code.', 400);

      try {
        const token = await exchangeCode(code, request.url);
        return responseHtml(`
          <style>${BASE_CSS}</style>
          <main class="container">
            <div class="error-card" style="border-color:#315d3d;background:#151e18">
              <h1>Authorization successful</h1>
              <p>Copy the <strong>refresh_token</strong> below into the matching ROOTS entry at the top of worker.js.</p>
              <textarea style="width:100%;min-height:100px;background:#0b0d10;color:#fff;border:1px solid #363b44;border-radius:8px;padding:10px">${htmlEscape(token.refresh_token || 'NO_REFRESH_TOKEN_RETURNED')}</textarea>
              <p class="muted">Do not share this token. After copying it, remove this authorization endpoint or protect it before public deployment.</p>
            </div>
          </main>`);
      } catch (e) {
        return errorPage('Authorization failed', e.message, 400);
      }
    }
    // Delete above routes after setup
    
    const index = rootIndexFromPath(path);
    if (index === null) return errorPage('Not found', 'Unknown route.', 404);
    if (!rootByIndex(index)) return errorPage('Drive not found', 'That drive root does not exist.', 404);

    const driveNext = path + url.search;
    if (!(await checkSitePassword(request, index))) {
      const auth = rootAuth(index);
      return unauthorized(auth.scope, driveNext);
    }

    const remainder = path.replace(/^\/\d+:/, '') || '/';

    if (remainder === '/' || remainder === '') {
      return renderIndex(index, request.url);
    }

    const imageMatch = remainder.match(/^\/image\/([^/]+)$/);
    if (imageMatch) return renderImage(index, decodeURIComponent(imageMatch[1]), request);

    const downloadMatch = remainder.match(/^\/download\/([^/]+)$/);
    if (downloadMatch) return downloadFile(index, decodeURIComponent(downloadMatch[1]));

    return errorPage('Not found', 'Unknown Drive route.', 404);
  },
};
