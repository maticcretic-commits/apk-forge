#!/usr/bin/env node
/**
 * APK Forge Studio — cloud scaffolder.
 *
 * Reads builds/<buildId>/ and turns it into a signed-ready Capacitor Android
 * project under android/. Designed to run on GitHub Actions (ubuntu-latest).
 *
 * Usage: node scripts/forge.mjs "builds/<buildId>"
 *
 * Input layout (builds/<buildId>/):
 *   config.json  { appName, packageId, versionName, versionCode,
 *                  orientation: "portrait"|"landscape"|"unspecified",
 *                  splashColor, themeColor,
 *                  sourceType: "zip"|"url"|"template", templateName?,
 *                  includeAab: true|false }
 *   icon.png     (optional) custom launcher icon
 *   source.zip   (when sourceType == "zip")
 *   url.txt      (when sourceType == "url")
 *
 * Output:
 *   android/            Capacitor android project, patched & branded
 *   forge.jks           release keystore (uploaded as a run artifact only)
 *   keystore-info.txt   alias + passwords (run artifact only — never released)
 *   build-info.json     paths + signing details for the workflow to consume
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

const ROOT = process.cwd();
const fail = (msg) => { console.error(`\n[forge] FATAL: ${msg}\n`); process.exit(1); };
const log = (msg) => console.log(`[forge] ${msg}`);
const run = (cmd, opts = {}) => { console.log(`[forge] $ ${cmd}`); execSync(cmd, { stdio: 'inherit', ...opts }); };

/* ------------------------------ 1. config ------------------------------ */
const buildDir = process.argv[2];
if (!buildDir) fail('usage: node scripts/forge.mjs "builds/<buildId>"');
const buildPath = path.join(ROOT, buildDir);
if (!existsSync(path.join(buildPath, 'config.json'))) fail(`config.json not found in ${buildDir}`);

const config = JSON.parse(readFileSync(path.join(buildPath, 'config.json'), 'utf8'));
const {
  appName, packageId, versionName, versionCode,
  orientation = 'portrait', splashColor = '#1a1033', themeColor = '#6c3df4',
  sourceType, templateName, includeAab = true,
} = config;

if (!appName || typeof appName !== 'string') fail('config.appName is required');
const PKG_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
if (!PKG_RE.test(packageId || '')) {
  fail(`config.packageId "${packageId}" is invalid — use lowercase letters/digits, at least two dot-separated segments, each starting with a letter (e.g. com.example.myapp)`);
}
if (!Number.isInteger(versionCode) || versionCode < 1) fail('config.versionCode must be a positive integer');
if (!versionName || typeof versionName !== 'string') fail('config.versionName is required');
if (!['portrait', 'landscape', 'unspecified'].includes(orientation)) fail(`config.orientation "${orientation}" must be portrait|landscape|unspecified`);
if (!['zip', 'url', 'template'].includes(sourceType)) fail(`config.sourceType "${sourceType}" must be zip|url|template`);

const normColor = (c, fallback) => {
  let v = String(c || fallback).trim();
  if (!v.startsWith('#')) v = '#' + v;
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) fail(`color "${c}" must be a 6-digit hex like #6c3df4`);
  return v.toLowerCase();
};
const splashHex = normColor(splashColor, '#1a1033');
const themeHex = normColor(themeColor, '#6c3df4');

let siteUrl = null;
if (sourceType === 'url') {
  const urlFile = path.join(buildPath, 'url.txt');
  if (!existsSync(urlFile)) fail('sourceType is "url" but url.txt is missing');
  siteUrl = readFileSync(urlFile, 'utf8').trim();
  if (!/^https?:\/\/.+/i.test(siteUrl)) fail(`url.txt must contain an http(s) URL, got "${siteUrl}"`);
}
log(`Building "${appName}" (${packageId}) v${versionName} (${versionCode}) from ${sourceType}`);

/* ------------------------------ 2. www/ -------------------------------- */
const wwwDir = path.join(ROOT, 'www');
if (existsSync(wwwDir)) rmSync(wwwDir, { recursive: true, force: true });
mkdirSync(wwwDir, { recursive: true });

if (sourceType === 'zip') {
  const zipFile = path.join(buildPath, 'source.zip');
  if (!existsSync(zipFile)) fail('sourceType is "zip" but source.zip is missing');
  run(`unzip -q "${zipFile}" -d "${wwwDir}"`);
  // drop macOS metadata folders
  for (const e of readdirSync(wwwDir)) {
    if (e === '__MACOSX') rmSync(path.join(wwwDir, e), { recursive: true, force: true });
  }
  const findIndex = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase() === 'index.html') return path.join(dir, e.name);
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX') {
        const f = findIndex(path.join(dir, e.name));
        if (f) return f;
      }
    }
    return null;
  };
  const found = findIndex(wwwDir);
  if (!found) fail('source.zip does not contain an index.html file');
  const foundDir = path.dirname(found);
  if (foundDir !== wwwDir) {
    log(`index.html was nested in ${path.relative(wwwDir, foundDir)} — lifting contents up`);
    cpSync(foundDir, wwwDir, { recursive: true });
    rmSync(foundDir, { recursive: true, force: true });
  }
} else if (sourceType === 'template') {
  const tpl = path.join(ROOT, 'templates', templateName || 'starter');
  if (!existsSync(path.join(tpl, 'index.html'))) fail(`template "${templateName}" not found`);
  cpSync(tpl, wwwDir, { recursive: true });
  log(`copied template "${templateName}"`);
} else {
  // URL mode: the WebView first loads this local page, which checks
  // connectivity and then navigates to the site (or shows an offline screen).
  const loader = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="${themeHex}">
<title>${appName.replace(/</g, '&lt;')}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px 24px;color:#fff;background:${splashHex}}
  .spin{width:52px;height:52px;border-radius:50%;border:4px solid rgba(255,255,255,.2);border-top-color:#fff;animation:sp 1s linear infinite;margin-bottom:24px}
  @keyframes sp{to{transform:rotate(360deg)}}
  h1{font-size:22px;margin-bottom:8px} p{opacity:.7;font-size:15px;line-height:1.6;max-width:320px}
  #offline{display:none}
  button{margin-top:24px;border:0;cursor:pointer;font-size:16px;font-weight:700;color:${splashHex};background:#fff;padding:14px 36px;border-radius:999px}
  .emoji{font-size:52px;margin-bottom:18px}
</style>
</head>
<body>
  <div id="loading"><div class="spin"></div><h1>${appName.replace(/</g, '&lt;')}</h1><p>Connecting…</p></div>
  <div id="offline"><div class="emoji">📡</div><h1>You're offline</h1><p>Couldn't reach the website. Check your connection and try again.</p><button onclick="go()">Retry</button></div>
<script>
  const TARGET = ${JSON.stringify(siteUrl)};
  const loading = document.getElementById('loading');
  const offline = document.getElementById('offline');
  function showOffline(){ loading.style.display='none'; offline.style.display='block'; }
  function go(){
    offline.style.display='none'; loading.style.display='block';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    fetch(TARGET, { mode: 'no-cors', signal: ctrl.signal })
      .then(() => { clearTimeout(t); location.href = TARGET; })
      .catch(() => { clearTimeout(t); showOffline(); });
  }
  window.addEventListener('online', go);
  go();
<\/script>
</body>
</html>
`;
  writeFileSync(path.join(wwwDir, 'index.html'), loader);
  log(`wrote URL loader for ${siteUrl}`);
}

if (!existsSync(path.join(wwwDir, 'index.html'))) fail('www/index.html is missing after preparing sources');
log('www/ ready');

/* --------------------------- 3. npm + capacitor ------------------------ */
if (!existsSync(path.join(ROOT, 'package.json'))) run('npm init -y');
run('npm install --no-audit --no-fund @capacitor/core@7 @capacitor/cli@7 @capacitor/android@7 sharp');

writeFileSync(path.join(ROOT, 'capacitor.config.json'), JSON.stringify({
  appId: packageId,
  appName,
  webDir: 'www',
  android: { backgroundColor: themeHex },
}, null, 2));

if (existsSync(path.join(ROOT, 'android'))) rmSync(path.join(ROOT, 'android'), { recursive: true, force: true });
run('npx cap add android');
run('npx cap sync android');

const ANDROID = path.join(ROOT, 'android', 'app', 'src', 'main');
const read = (p) => readFileSync(p, 'utf8');
const write = (p, s) => writeFileSync(p, s);

/* --------------------- 4. package id / versions ---------------------- */
const gradlePath = path.join(ROOT, 'android', 'app', 'build.gradle');
let gradle = read(gradlePath);
gradle = gradle.replace(/applicationId\s+"[^"]*"/, `applicationId "${packageId}"`);
gradle = gradle.replace(/namespace\s+"[^"]*"/, `namespace "${packageId}"`);
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`);
write(gradlePath, gradle);

// MainActivity: make sure its package matches (move the file if needed)
const findMain = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findMain(p); if (f) return f; }
    else if (e.name === 'MainActivity.java') return p;
  }
  return null;
};
let mainPath = findMain(path.join(ROOT, 'android', 'app', 'src', 'main', 'java'));
if (!mainPath) fail('MainActivity.java not found in the android project');
let mainSrc = read(mainPath);
const pkgMatch = mainSrc.match(/^\s*package\s+([\w.]+)\s*;/m);
if (!pkgMatch || pkgMatch[1] !== packageId) {
  const destDir = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', ...packageId.split('.'));
  mkdirSync(destDir, { recursive: true });
  mainSrc = mainSrc.replace(/^\s*package\s+[\w.]+\s*;/m, `package ${packageId};`);
  const dest = path.join(destDir, 'MainActivity.java');
  write(dest, mainSrc);
  if (dest !== mainPath) rmSync(mainPath);
  mainPath = dest;
  log(`moved MainActivity to package ${packageId}`);
}

// strings.xml app name
const stringsPath = path.join(ANDROID, 'res', 'values', 'strings.xml');
if (existsSync(stringsPath)) {
  let s = read(stringsPath);
  if (s.includes('app_name')) {
    s = s.replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${appName.replace(/[<>&]/g, '')}$2`);
    write(stringsPath, s);
  }
}

/* ------------------------------ 5. icons ----------------------------- */
log('generating launcher icons…');
const sharp = (await import('sharp')).default;
const customIcon = path.join(buildPath, 'icon.png');
let iconSrc = customIcon;
if (!existsSync(customIcon)) {
  // default icon: gradient rounded square + first letter of the app name
  const letter = (appName.trim()[0] || 'A').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${themeHex}"/><stop offset="1" stop-color="${splashHex}"/>
    </linearGradient></defs>
    <rect width="512" height="512" rx="112" fill="url(#g)"/>
    <text x="256" y="336" font-family="sans-serif" font-size="240" font-weight="bold" fill="#ffffff" text-anchor="middle">${letter}</text>
  </svg>`;
  iconSrc = path.join(ROOT, 'icon-generated.png');
  await sharp(Buffer.from(svg)).png().toFile(iconSrc);
  log('no icon uploaded — generated a default icon');
}
const densities = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];
for (const [name, size] of densities) {
  const dir = path.join(ANDROID, 'res', `mipmap-${name}`);
  mkdirSync(dir, { recursive: true });
  const buf = await sharp(iconSrc).resize(size, size).png().toBuffer();
  writeFileSync(path.join(dir, 'ic_launcher.png'), buf);
  writeFileSync(path.join(dir, 'ic_launcher_round.png'), buf);
}
// adaptive-icon foreground: icon centered on transparent canvas (432dp)
const fg = await sharp({
  create: { width: 432, height: 432, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
}).composite([{ input: await sharp(iconSrc).resize(288, 288).png().toBuffer(), gravity: 'center' }]).png().toBuffer();
writeFileSync(path.join(ANDROID, 'res', 'mipmap-xxxhdpi', 'ic_launcher_foreground.png'), fg);

// colors: update wherever the name is already defined (the Capacitor template
// ships ic_launcher_background in its own file), else append to colors.xml
const valuesDir = path.join(ANDROID, 'res', 'values');
const upsertColor = (name, value) => {
  const tag = `<color name="${name}">${value}</color>`;
  const re = new RegExp(`<color name="${name}">[^<]*</color>`);
  for (const f of readdirSync(valuesDir)) {
    if (!f.endsWith('.xml')) continue;
    const p = path.join(valuesDir, f);
    const xml = read(p);
    if (re.test(xml)) { write(p, xml.replace(re, tag)); log(`updated color ${name} in ${f}`); return; }
  }
  const cp = path.join(valuesDir, 'colors.xml');
  let cxml = existsSync(cp) ? read(cp) : '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n';
  cxml = cxml.replace('</resources>', `    ${tag}\n</resources>`);
  write(cp, cxml);
  log(`added color ${name} to colors.xml`);
};
upsertColor('ic_launcher_background', themeHex);
upsertColor('forge_splash_background', splashHex);

const anydpi = path.join(ANDROID, 'res', 'mipmap-anydpi-v26');
mkdirSync(anydpi, { recursive: true });
const adaptive = (round) => `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    ${round ? '<!-- round -->' : ''}
</adaptive-icon>
`;
write(path.join(anydpi, 'ic_launcher.xml'), adaptive(false));
write(path.join(anydpi, 'ic_launcher_round.xml'), adaptive(true));
log('icons done (legacy PNGs + adaptive icon)');

/* ------------------------------ 6. splash ---------------------------- */
const drawableDir = path.join(ANDROID, 'res', 'drawable');
mkdirSync(drawableDir, { recursive: true });
write(path.join(drawableDir, 'forge_splash.xml'), `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/forge_splash_background" />
    <item>
        <bitmap android:src="@mipmap/ic_launcher" android:gravity="center" />
    </item>
</layer-list>
`);

const stylesPath = path.join(ANDROID, 'res', 'values', 'styles.xml');
const manifestPath = path.join(ANDROID, 'AndroidManifest.xml');
let manifest = read(manifestPath);
// find the theme used by MainActivity
let themeName = 'AppTheme';
const actTheme = manifest.match(/<activity[^>]*android:name="\.MainActivity"[^>]*android:theme="@style\/([^"]+)"/)
  || manifest.match(/android:theme="@style\/([^"]+)"/);
if (actTheme) themeName = actTheme[1];

let styles = read(stylesPath);
const upsertStyleItem = (xml, style, item, value) => {
  const blockRe = new RegExp(`(<style\\s+name="${style}"[^>]*>)([\\s\\S]*?)(</style>)`);
  const m = xml.match(blockRe);
  if (!m) fail(`style "${style}" not found in styles.xml`);
  let body = m[2];
  const itemRe = new RegExp(`<item\\s+name="${item.replace(/:/g, ':')}">[^<]*</item>`);
  const tag = `<item name="${item}">${value}</item>`;
  body = itemRe.test(body) ? body.replace(itemRe, tag) : body + `\n        ${tag}`;
  return xml.replace(blockRe, `$1${body}$3`);
};
styles = upsertStyleItem(styles, themeName, 'android:windowBackground', '@drawable/forge_splash');
if (styles.includes('windowSplashScreenBackground')) {
  styles = upsertStyleItem(styles, themeName, 'android:windowSplashScreenBackground', '@color/forge_splash_background');
  log('patched core-splashscreen background for API 31+');
}
write(stylesPath, styles);
log(`splash screen set on theme "${themeName}"`);

/* --------------------- 7. MainActivity: back button ------------------- */
mainSrc = read(mainPath);
if (!mainSrc.includes('onBackPressed')) {
  mainSrc = mainSrc.replace(
    /(\bpublic\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{)/,
    `$1\n    @Override\n    public void onBackPressed() {\n` +
    `        android.webkit.WebView wv = getBridge() != null ? getBridge().getWebView() : null;\n` +
    `        if (wv != null && wv.canGoBack()) { wv.goBack(); } else { super.onBackPressed(); }\n    }\n`
  );
  write(mainPath, mainSrc);
  log('patched MainActivity: back button now navigates WebView history');
} else {
  log('MainActivity already handles back press — skipping');
}

/* --------------------- 8. AndroidManifest tweaks ---------------------- */
const orientMap = { portrait: 'portrait', landscape: 'landscape', unspecified: 'unspecified' };
manifest = manifest.replace(
  /<activity([^>]*android:name="\.MainActivity"[^>]*)>/,
  (m, attrs) => {
    attrs = attrs.replace(/\s*android:screenOrientation="[^"]*"/, '');
    return `<activity${attrs} android:screenOrientation="${orientMap[orientation]}">`;
  }
);
if (siteUrl && /^http:\/\//i.test(siteUrl)) {
  if (!manifest.includes('usesCleartextTraffic')) {
    manifest = manifest.replace(/<application(\s)/, '<application android:usesCleartextTraffic="true"$1');
    log('enabled cleartext traffic for http:// URL');
  }
}
write(manifestPath, manifest);
if (!manifest.includes('android.permission.INTERNET')) {
  log('WARNING: INTERNET permission not found in manifest');
}

/* --------------------------- 9. keystore ----------------------------- */
const rand = (n) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = crypto.randomBytes(n);
  let s = '';
  for (const x of b) s += chars[x % chars.length];
  return s;
};
const storePass = rand(24), keyAlias = 'forge';
// NOTE: PKCS12 keystores (keytool's default) do not support a key password
// different from the store password — keytool silently ignores -keypass.
// So we use ONE password for both and record it as such.
const keyPass = storePass;
const ksPath = path.join(ROOT, 'forge.jks');
if (existsSync(ksPath)) rmSync(ksPath);
run(`keytool -genkeypair -keystore "${ksPath}" -alias ${keyAlias} -keyalg RSA -keysize 2048 -validity 10000 -storepass "${storePass}" -keypass "${keyPass}" -dname "CN=APK Forge Studio"`);

write(path.join(ROOT, 'keystore-info.txt'),
  `APK Forge Studio — release keystore\n` +
  `App: ${appName} (${packageId})  v${versionName} (${versionCode})\n` +
  `Keystore file: forge.jks\n` +
  `Key alias: ${keyAlias}\n` +
  `Store password: ${storePass}\n` +
  `Key password: ${keyPass}\n\n` +
  `KEEP THIS FILE SAFE. You need this exact keystore to sign updates —\n` +
  `lose it and the Play Store will reject every future version of this app.\n`);

const buildInfo = {
  appName, packageId, versionName, versionCode,
  apkPath: 'android/app/build/outputs/apk/release/app-release.apk',
  aabPath: 'android/app/build/outputs/bundle/release/app-release.aab',
  keystorePath: 'forge.jks',
  storePass, keyPass, keyAlias,
  includeAab: includeAab !== false,
};
write(path.join(ROOT, 'build-info.json'), JSON.stringify(buildInfo, null, 2));

console.log('\n[forge] ================= SUMMARY ================');
console.log(`[forge] app:        ${appName} ${versionName} (${versionCode})`);
console.log(`[forge] package:    ${packageId}`);
console.log(`[forge] orientation:${orientation}  splash:${splashHex}  theme:${themeHex}`);
console.log(`[forge] source:     ${sourceType}${siteUrl ? ' -> ' + siteUrl : ''}`);
console.log(`[forge] keystore:   forge.jks (alias ${keyAlias})`);
console.log('[forge] scaffold complete — ready for gradle build\n');
