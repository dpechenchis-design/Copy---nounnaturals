#!/usr/bin/env bash
# =====================================================================
# Noun ART: set up the Gemini reader (the Cloud Run Job "art-reader").
#
# For the owner. Paste this whole file into Google Cloud Shell
# (console.cloud.google.com, project noun-art, the >_ button at the top),
# press Enter, and answer what it asks. It is safe to run again: it keeps
# what is already there and only rebuilds the reader.
#
# What it does, in plain words:
#   1. Turns on five Google Cloud services (Cloud Run, Cloud Build,
#      Artifact Registry, Secret Manager, Cloud Scheduler).
#   2. Gets the reader's code from GitHub (khalednoun/noun-art). The first
#      time, GitHub shows a short code to confirm in your browser.
#   3. Asks you to paste four values and locks them in Secret Manager:
#      the Supabase address, the Supabase service key, the Gemini key and
#      the shared drive's id. The two keys are hidden while you paste and
#      are never shown, printed or saved anywhere else.
#   4. Builds the reader and installs it as the job "art-reader", running
#      as the same service account the app already uses for Drive
#      (noun-art-drive). No key file is made.
#   5. Starts it every 5 minutes (Cloud Scheduler) and lets that service
#      account start it, so the app can run it right after an upload.
#   6. Prints the two lines to add in Replit Secrets.
#
# The whole script is one function that is called on the last line, so
# pasting it runs nothing until all of it has arrived.
# =====================================================================

art_reader_setup() {
  set -uo pipefail

  local PROJECT="${ART_PROJECT:-noun-art}"
  local REGION="${ART_READER_REGION:-us-east1}"
  local JOB="${ART_READER_JOB:-art-reader}"
  local SA="${ART_READER_SERVICE_ACCOUNT:-noun-art-drive@${PROJECT}.iam.gserviceaccount.com}"
  local REPO="${ART_GITHUB_REPO:-khalednoun/noun-art}"
  local SRC="${ART_SRC_DIR:-$HOME/noun-art}"
  local AR_REPO="art"
  local SCHEDULE_NAME="${JOB}-every-5-min"
  local IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${JOB}:latest"
  local S_URL="art-supabase-url" S_KEY="art-supabase-service-key" S_GEMINI="art-gemini-key" S_DRIVE="art-shared-drive-id"

  say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
  note() { printf '   %s\n' "$*"; }
  stop() { printf '\n\033[1mStopped: %s\033[0m\n' "$*" >&2; return 1; }

  command -v gcloud >/dev/null 2>&1 || { stop "gcloud is not here. Run this in Google Cloud Shell."; return 1; }

  # ---------- 0. the project ----------
  say "Project: ${PROJECT}   Region: ${REGION}   Job: ${JOB}"
  gcloud config set project "${PROJECT}" --quiet >/dev/null 2>&1 || { stop "Could not open the project ${PROJECT}. Are you signed in with the account that owns it?"; return 1; }
  local PROJECT_NUMBER
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)' 2>/dev/null)"
  [ -n "${PROJECT_NUMBER}" ] || { stop "Could not read the project ${PROJECT}."; return 1; }
  local BILLING
  BILLING="$(gcloud billing projects describe "${PROJECT}" --format='value(billingEnabled)' 2>/dev/null || true)"
  if [ "${BILLING}" != "True" ] && [ "${BILLING}" != "true" ]; then
    stop "Billing is not on for ${PROJECT}. Turn it on first: console.cloud.google.com/billing (plan step 1). Then run this again."
    return 1
  fi

  # ---------- 1. services ----------
  say "1 of 6  Turning on the Google Cloud services (a minute the first time)"
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    secretmanager.googleapis.com cloudscheduler.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
    --project "${PROJECT}" --quiet || { stop "Could not turn the services on."; return 1; }

  gcloud iam service-accounts describe "${SA}" --project "${PROJECT}" >/dev/null 2>&1 \
    || { stop "The service account ${SA} is not in this project. It is the one made for Google Drive (docs/SETUP.md, section 5)."; return 1; }

  # ---------- 2. the code ----------
  say "2 of 6  Getting the reader's code"
  if [ -f "${SRC}/worker/Dockerfile" ] && [ ! -d "${SRC}/.git" ]; then
    note "Using the code in ${SRC}."
  elif [ -d "${SRC}/.git" ]; then
    note "Updating ${SRC} from GitHub."
    git -C "${SRC}" pull --ff-only --quiet || note "Could not update it (using the copy that is there)."
  else
    command -v gh >/dev/null 2>&1 || { stop "The GitHub tool (gh) is not here. Run this in Google Cloud Shell."; return 1; }
    if ! gh auth status >/dev/null 2>&1; then
      note "GitHub will show a short code. Open the link it prints, sign in as the owner of ${REPO}, and type the code."
      gh auth login --hostname github.com --git-protocol https --web </dev/tty || { stop "GitHub sign in did not finish."; return 1; }
    fi
    gh repo clone "${REPO}" "${SRC}" -- --depth 1 --quiet || { stop "Could not get ${REPO} from GitHub."; return 1; }
  fi
  [ -f "${SRC}/worker/Dockerfile" ] && [ -d "${SRC}/src/lib/ai/reader" ] \
    || { stop "The reader's code is not in ${SRC} yet. It arrives with the code push on GitHub; run this again after it."; return 1; }

  # ---------- 3. the four values ----------
  say "3 of 6  The four values (kept in Secret Manager, never shown)"

  secret_has_value() { gcloud secrets versions list "$1" --project "${PROJECT}" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null | grep -q .; }

  # ensure_secret NAME hidden|shown "question" "pattern the value must match" "what a good value looks like"
  ensure_secret() {
    local name="$1" mode="$2" question="$3" pattern="$4" looks="$5" value="" answer=""
    if ! gcloud secrets describe "${name}" --project "${PROJECT}" >/dev/null 2>&1; then
      gcloud secrets create "${name}" --project "${PROJECT}" --replication-policy=automatic --quiet >/dev/null || { stop "Could not make the secret ${name}."; return 1; }
    fi
    if secret_has_value "${name}"; then
      printf '   %s is already saved. Keep it? [Y/n] ' "${name}"
      read -r answer </dev/tty || answer=""
      case "${answer}" in n|N|no|No|NO) ;; *) note "Kept."; value=""; _grant_secret "${name}" || return 1; return 0 ;; esac
    fi
    while :; do
      printf '   %s\n   > ' "${question}"
      if [ "${mode}" = "hidden" ]; then
        read -rs value </dev/tty || value=""
        printf '(hidden)\n'
      else
        read -r value </dev/tty || value=""
      fi
      # no spaces, no quotes, no line ends around a pasted value
      value="$(printf '%s' "${value}" | tr -d '\r\n' | sed -e 's/^[[:space:]"'"'"']*//' -e 's/[[:space:]"'"'"']*$//')"
      if printf '%s' "${value}" | grep -Eq "${pattern}"; then break; fi
      note "That does not look right. ${looks}"
    done
    printf '%s' "${value}" | gcloud secrets versions add "${name}" --project "${PROJECT}" --data-file=- --quiet >/dev/null \
      || { value=""; stop "Could not save ${name}."; return 1; }
    value=""
    note "Saved."
    _grant_secret "${name}" || return 1
  }
  _grant_secret() {
    gcloud secrets add-iam-policy-binding "$1" --project "${PROJECT}" --member "serviceAccount:${SA}" \
      --role roles/secretmanager.secretAccessor --condition=None --quiet >/dev/null 2>&1 \
      || { stop "Could not let the reader read the secret $1."; return 1; }
  }

  ensure_secret "${S_URL}" shown \
    "Paste the Supabase project address (Supabase, project noun-art, Settings, API, Project URL):" \
    '^https://[a-z0-9-]+\.supabase\.co$' "It looks like https://abcdefgh.supabase.co" || return 1
  ensure_secret "${S_KEY}" hidden \
    "Paste the Supabase SERVICE key (the same value as SUPABASE_SERVICE_ROLE_KEY in Replit Secrets). It stays hidden:" \
    '^[A-Za-z0-9._-]{30,}$' "It is one long line of letters, numbers, dots and dashes." || return 1
  ensure_secret "${S_GEMINI}" hidden \
    "Paste the Gemini API key (aistudio.google.com, Get API key, on the paid tier). It stays hidden:" \
    '^[A-Za-z0-9._-]{20,}$' "It is one line of letters and numbers, usually starting with AIza or AQ." || return 1
  ensure_secret "${S_DRIVE}" shown \
    "Paste the shared drive's id (the same value as GOOGLE_DRIVE_SHARED_DRIVE_ID in Replit Secrets):" \
    '^[A-Za-z0-9_-]{6,120}$' "It is the long code at the end of the shared drive's address." || return 1

  # ---------- 4. build ----------
  say "4 of 6  Building the reader (about 3 minutes)"
  if ! gcloud artifacts repositories describe "${AR_REPO}" --location "${REGION}" --project "${PROJECT}" >/dev/null 2>&1; then
    gcloud artifacts repositories create "${AR_REPO}" --repository-format=docker --location "${REGION}" --project "${PROJECT}" \
      --description "Noun ART images" --quiet >/dev/null || { stop "Could not make the image store."; return 1; }
  fi
  # the accounts Cloud Build may run as need to run a build, save the image and write their log (new projects use
  # the second one, which has none of this by default)
  local builder
  for builder in "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"; do
    if gcloud iam service-accounts describe "${builder}" --project "${PROJECT}" >/dev/null 2>&1 || [ "${builder#*@}" = "cloudbuild.gserviceaccount.com" ]; then
      gcloud artifacts repositories add-iam-policy-binding "${AR_REPO}" --location "${REGION}" --project "${PROJECT}" \
        --member "serviceAccount:${builder}" --role roles/artifactregistry.writer --quiet >/dev/null 2>&1 || true
      gcloud projects add-iam-policy-binding "${PROJECT}" --member "serviceAccount:${builder}" \
        --role roles/logging.logWriter --condition=None --quiet >/dev/null 2>&1 || true
      gcloud projects add-iam-policy-binding "${PROJECT}" --member "serviceAccount:${builder}" \
        --role roles/cloudbuild.builds.builder --condition=None --quiet >/dev/null 2>&1 || true
    fi
  done
  # only what the reader is built from goes up: worker/ and src/lib/ (no keys live there)
  local STAGE
  STAGE="$(mktemp -d)" || { stop "Could not make a temporary folder."; return 1; }
  mkdir -p "${STAGE}/src" && cp -R "${SRC}/worker" "${STAGE}/worker" && cp -R "${SRC}/src/lib" "${STAGE}/src/lib" \
    || { rm -rf "${STAGE}"; stop "Could not copy the reader's code."; return 1; }
  rm -rf "${STAGE}/worker/node_modules" "${STAGE}/worker/dist"
  if ! gcloud builds submit "${STAGE}" --project "${PROJECT}" --config "${STAGE}/worker/cloudbuild.yaml" \
        --substitutions "_IMAGE=${IMAGE}" --quiet; then
    rm -rf "${STAGE}"
    stop "The build did not finish. The lines above say why. Nothing was changed; run this again after the fix."
    return 1
  fi
  rm -rf "${STAGE}"

  # ---------- 5. the job ----------
  say "5 of 6  Installing the job ${JOB}"
  gcloud run jobs deploy "${JOB}" --project "${PROJECT}" --region "${REGION}" --image "${IMAGE}" \
    --service-account "${SA}" \
    --set-secrets "SUPABASE_URL=${S_URL}:latest,SUPABASE_SERVICE_ROLE_KEY=${S_KEY}:latest,GEMINI_API_KEY=${S_GEMINI}:latest,GOOGLE_DRIVE_SHARED_DRIVE_ID=${S_DRIVE}:latest" \
    --set-env-vars "READER_CONCURRENCY=4,READER_MAX_MINUTES=50,READER_LEASE_MINUTES=30" \
    --tasks 1 --parallelism 1 --max-retries 0 --task-timeout 3600s --cpu 2 --memory 2Gi --quiet \
    || { stop "Could not install the job."; return 1; }

  # the service account may start the job and see its runs: that is how the app starts it after an upload
  local role
  for role in roles/run.invoker roles/run.viewer; do
    gcloud run jobs add-iam-policy-binding "${JOB}" --project "${PROJECT}" --region "${REGION}" \
      --member "serviceAccount:${SA}" --role "${role}" --quiet >/dev/null \
      || { stop "Could not let ${SA} start the job (${role})."; return 1; }
  done
  # Cloud Scheduler signs in as that same account to start the job
  gcloud iam service-accounts add-iam-policy-binding "${SA}" --project "${PROJECT}" \
    --member "serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
    --role roles/iam.serviceAccountTokenCreator --condition=None --quiet >/dev/null 2>&1 || true

  # ---------- 6. every 5 minutes ----------
  say "6 of 6  Starting it every 5 minutes"
  local RUN_URI="https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}:run"
  local verb="create"
  gcloud scheduler jobs describe "${SCHEDULE_NAME}" --project "${PROJECT}" --location "${REGION}" >/dev/null 2>&1 && verb="update"
  gcloud scheduler jobs "${verb}" http "${SCHEDULE_NAME}" --project "${PROJECT}" --location "${REGION}" \
    --schedule "*/5 * * * *" --time-zone "America/New_York" --uri "${RUN_URI}" --http-method POST \
    --oauth-service-account-email "${SA}" --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
    --attempt-deadline 60s --quiet >/dev/null \
    || { stop "Could not set the 5 minute schedule."; return 1; }

  say "Done. The reader is installed."
  note "It runs every 5 minutes and stops by itself when there is nothing to read."
  note "Until the database change is approved and live, it starts, finds nothing to do and stops."
  printf '\n   Add these two in Replit Secrets (Tools, Secrets), then Republish:\n\n'
  printf '      ART_READER_JOB=%s\n' "${JOB}"
  printf '      ART_READER_REGION=%s\n\n' "${REGION}"
  note "To see what it did: console.cloud.google.com/run/jobs  (project ${PROJECT}, job ${JOB}, Logs)."
  note "To change a key later: run this again and answer n to Keep it."
}

# in a subshell, so nothing of it stays behind in your Cloud Shell
( art_reader_setup )
