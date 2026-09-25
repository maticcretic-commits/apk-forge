# ⚒️ APK Forge Studio

**Turn any web app or website into a real, signed Android APK — free, right from your browser.**

No Android Studio. No build machine. No terminal. Design your app in the studio, hit **Forge**, and GitHub Actions builds a signed release APK in the cloud and hands you the download link.

🌐 **Live studio:** https://maticcretic-commits.github.io/apk-forge/

## How it works

```
📱 This page  →  📦 Your repo (builds/<id>/)  →  ☁️ GitHub Actions (Gradle build + sign)  →  🎉 Public release (APK download)
```

1. **Design** — pick a source (upload a ZIP of your HTML/CSS/JS app, paste a website URL, or start from a template), brand it (name, package ID, icon, colors, orientation) and preview it live in a phone mockup.
2. **Connect** — paste a GitHub personal access token (classic, `repo` + `workflow` scopes). It's stored only in your browser and sent only to `api.github.com`.
3. **Forge** — the studio commits your build recipe to `builds/<id>/` and triggers the `forge.yml` workflow.
4. **Download** — the workflow scaffolds a real Capacitor Android project, compiles it with Gradle, signs the release, and publishes a public GitHub Release with the APK (+ optional AAB). Confetti included.

## What's in the repo

| Path | What it does |
|---|---|
| `docs/` | The GitHub Pages studio (single-page app) |
| `.github/workflows/forge.yml` | The cloud build: scaffold → Gradle → sign → release |
| `scripts/forge.mjs` | Scaffolder: web content → branded Capacitor Android project, icons, splash, keystore |
| `templates/starter/` | A clean starter web app template |
| `templates/current-affairs/` | BPSC Current Affairs study-app template |
| `builds/` | One folder per forge — your build history as code |

## Signing & updates

Every build generates a fresh release keystore. The keystore + passwords are uploaded to the workflow run's **Artifacts** (90-day retention, login required) — **download it and keep it safe**. The APK/AAB in the public release are signed with it, and any future update of the same app must be signed with the *same* keystore, or Android and the Play Store will reject it.

## Notes

- **Website-URL apps** load your site full-screen in the app. If the phone is offline, users see a friendly retry screen instead of a blank page.
- The Android back button navigates web history inside the app (no accidental exits).
- Builds take roughly 5–15 minutes depending on the runner.

## Run it yourself

Everything is static + GitHub Actions. Fork this repo, enable Pages from `/docs`, and forge away.
