# B11 — Give Grok its own GitHub identity (GitHub App setup)

**What this does.** Today, every pull request opened by the cloud dispatch workflow
(`.github/workflows/dispatch-agent-cloud.yml`) shows as written by **your own GitHub
account**, because it uses your personal token (`LOOP_GH_PAT`). After these steps, those
PRs show as written by a bot named **`<your-app-name>[bot]`** instead. That gives Grok a
separate identity, so one agent can review and merge another agent's PR without both
looking like you.

**Nothing breaks if you never do this.** Until both secrets in step 4 exist, the workflow
keeps using `LOOP_GH_PAT` exactly as before. A missing App is not an error.

**No RepID or score event is written by this change.** It changes only which identity
pushes the branch and opens the PR.

Everything below is clicks in a web browser on github.com. There is nothing to paste
into PowerShell.

---

## 1. Create the GitHub App

1. Go to **github.com** and sign in.
2. Click your profile picture (top right) → **Settings**.
3. In the left sidebar, scroll to the bottom → **Developer settings**.
4. Click **GitHub Apps** → **New GitHub App**.
5. Fill in the form:
   - **GitHub App name:** `grok-agent-dealappseo`
     App names are unique across all of GitHub. If it says the name is taken, add a
     suffix, for example `grok-agent-dealappseo-2`. Remember the name you used.
   - **Homepage URL:** `https://github.com/DealAppSeo/repid-engine`
   - **Webhook:** **UNCHECK** the box labelled **Active**. (We do not need webhooks.)
6. Scroll to **Permissions** → **Repository permissions**, and set exactly these:
   - **Contents:** `Read and write`
   - **Pull requests:** `Read and write`
   - **Metadata:** `Read-only` (this one is set automatically — leave it)
   - **Everything else:** leave as `No access`.
   - Leave **Organization permissions** and **Account permissions** all at `No access`.
7. Under **Where can this GitHub App be installed?** choose **Only on this account**.
8. Click **Create GitHub App**.

## 2. Note the App ID and generate a private key

You are now on the App's settings page.

1. Near the top, find **App ID** — a number. Write it down; you need it in step 4.
2. Scroll down to **Private keys** → click **Generate a private key**.
   Your browser downloads a file ending in `.pem`. That file is the App's password.

## 3. Install the App on the repository

1. On the same App settings page, click **Install App** in the left sidebar.
2. Click **Install** next to your account (DealAppSeo).
3. Choose **Only select repositories**, and select **`DealAppSeo/repid-engine`** only.
4. Click **Install**.

## 4. Store the two secrets in the repository

1. Go to **https://github.com/DealAppSeo/repid-engine**.
2. Click **Settings** (repo tab) → left sidebar **Secrets and variables** → **Actions**.
3. Make sure you are on the **Secrets** tab — **NOT the Variables tab.**
   A value put under *Variables* is invisible to `secrets.…` and silently reads as empty;
   the workflow would then quietly keep using your personal token, with no error.
4. Click **New repository secret**:
   - **Name:** `GROK_APP_ID`
   - **Secret:** the App ID number from step 2.
   - Click **Add secret**.
5. Click **New repository secret** again:
   - **Name:** `GROK_APP_PRIVATE_KEY`
   - **Secret:** open the downloaded `.pem` file in Notepad, select all (Ctrl+A), copy
     (Ctrl+C), and paste the **whole** contents — including the
     `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` lines.
   - Click **Add secret**.

## 5. Clean up the downloaded key

- Either **delete** the downloaded `.pem` file now (GitHub keeps the stored copy; you can
  always generate a new key later), or move it into your **password manager**.
- **Never** paste the `.pem` contents into a chat (including with Claude or Grok), a
  GitHub issue, a PR, a comment, or any file in a repository. This repository is
  **public** — anything committed is world-readable forever, even after deletion.
- If you think the key was exposed: App settings page → **Private keys** → **Delete** the
  key, then generate a new one and repeat step 4.5.

## 6. Verify it worked

1. Go to the repo → **Actions** tab → **dispatch-agent-cloud** → **Run workflow**.
   Leave the branch as **main**, pick agent **xc**, click **Run workflow**.
2. Open the run. In the step **Detect Grok GitHub App secrets (B11)** the log should say
   *"Grok GitHub App configured"*. If it says *"NOT configured"*, one of the two secrets
   is missing or was put under the Variables tab (step 4.3).
3. When the run finishes, open the draft PR it created. The author should read
   **`<your-app-name>[bot]`** (e.g. `grok-agent-dealappseo[bot]`), not your username.

**What a correct result looks like:** a draft PR titled `dispatch(xc): cloud beat
transcript (...)` whose author is the bot.

---

## Known limitations (honest)

- **Commit author is unchanged.** The PR is authored by the bot, but the commit inside it
  still carries the existing `dispatch-xc-cloud[bot]` author name. Setting the bot's real
  commit email needs its numeric GitHub user id, which does not exist until the App is
  created. This can be added later; it does not affect who opened the PR.
- **Dispatch from `main`, or from a branch with no workflow-file changes.** If you run the
  dispatch from a branch whose commits change files under `.github/workflows/` that are
  not yet on `main`, GitHub may refuse the App's push unless the App also has the
  **Workflows** permission. The recommendation is **not** to grant that permission (it
  would let the bot rewrite CI itself) — just dispatch from `main` instead.
- **Scope.** The workflow asks for a token limited to this one repository with only
  contents + pull-requests write, even if the App is later installed more widely.
