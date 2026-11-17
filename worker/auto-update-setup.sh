#!/usr/bin/env bash
# =====================================================================
# Noun ART: let the Gemini reader update itself from GitHub (run once).
#
# After this, every push to main that changes worker/ or src/lib/ rebuilds
# the reader and moves the job art-reader to the new code by itself
# (worker/cloudbuild-deploy.yaml). Nobody opens Cloud Shell for an update.
# Branches never deploy: only main, so work on a branch or a fork changes
# nothing until it is reviewed and merged.
#
# Run in Google Cloud Shell, project noun-art, AFTER worker/setup.sh:
#   bash noun-art/worker/auto-update-setup.sh
# It is safe to run again: it keeps what is there.
#
# What it does:
#   1. Makes the account the updates run as, "art-reader-deployer", with
#      only what an update needs: save the image, write its log, update
#      Cloud Run jobs in noun-art (only the reader lives there), and keep
#      art-reader running as noun-art-drive.
#   2. Connects Cloud Build to GitHub. The first time it prints a link: the
#      owner opens it, signs in to GitHub, and installs the Google Cloud
#      Build app on khalednoun/noun-art only. This is the owner's click.
#   3. Links the repo and makes the trigger "art-reader-update" (main only,
#      worker/ and src/lib/ only).
# =====================================================================

art_reader_auto_update() {
  set -uo pipefail

  local PROJECT="${ART_PROJECT:-noun-art}"
  local REGION="${ART_READER_REGION:-us-east1}"
  local JOB="${ART_READER_JOB:-art-reader}"
  local RUN_AS="${ART_READER_SERVICE_ACCOUNT:-noun-art-drive@${PROJECT}.iam.gserviceaccount.com}"
  local DEPLOYER_NAME="art-reader-deployer"
  local DEPLOYER="${DEPLOYER_NAME}@${PROJECT}.iam.gserviceaccount.com"
  local CONNECTION="noun-art-github"
  local REPO_NAME="noun-art"
  local REMOTE="https://github.com/${ART_GITHUB_REPO:-khalednoun/noun-art}.git"
  local TRIGGER="art-reader-update"
  local AR_REPO="art"

  say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
  note() { printf '   %s\n' "$*"; }
  stop() { printf '\n\033[1mStopped: %s\033[0m\n' "$*" >&2; return 1; }

  command -v gcloud >/dev/null 2>&1 || { stop "gcloud is not here. Run this in Google Cloud Shell."; return 1; }
  gcloud config set project "${PROJECT}" --quiet >/dev/null 2>&1 || { stop "Could not open the project ${PROJECT}."; return 1; }
  local PROJECT_NUMBER
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)' 2>/dev/null)"
  [ -n "${PROJECT_NUMBER}" ] || { stop "Could not read the project ${PROJECT}."; return 1; }
  gcloud run jobs describe "${JOB}" --region "${REGION}" --project "${PROJECT}" >/dev/null 2>&1 \
    || { stop "The job ${JOB} is not installed yet. Run worker/setup.sh first."; return 1; }

  # ---------- 1. the account updates run as ----------
  say "1 of 3  The update account (${DEPLOYER_NAME})"
  if ! gcloud iam service-accounts describe "${DEPLOYER}" --project "${PROJECT}" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${DEPLOYER_NAME}" --project "${PROJECT}" \
      --display-name "Noun ART reader updates (Cloud Build)" --quiet >/dev/null \
      || { stop "Could not make ${DEPLOYER_NAME}."; return 1; }
    sleep 5
  fi
  gcloud projects add-iam-policy-binding "${PROJECT}" --member "serviceAccount:${DEPLOYER}" \
    --role roles/logging.logWriter --condition=None --quiet >/dev/null || { stop "Could not let it write logs."; return 1; }
  gcloud artifacts repositories add-iam-policy-binding "${AR_REPO}" --location "${REGION}" --project "${PROJECT}" \
    --member "serviceAccount:${DEPLOYER}" --role roles/artifactregistry.writer --quiet >/dev/null \
    || { stop "Could not let it save images."; return 1; }
  # on the project, not only the job: an update waits on a Cloud Run operation, which is read at project level.
  # The reader is the only Cloud Run piece in noun-art.
  gcloud projects add-iam-policy-binding "${PROJECT}" --member "serviceAccount:${DEPLOYER}" \
    --role roles/run.developer --condition=None --quiet >/dev/null \
    || { stop "Could not let it update ${JOB}."; return 1; }
  gcloud iam service-accounts add-iam-policy-binding "${RUN_AS}" --project "${PROJECT}" \
    --member "serviceAccount:${DEPLOYER}" --role roles/iam.serviceAccountUser --condition=None --quiet >/dev/null \
    || { stop "Could not let it keep ${JOB} running as ${RUN_AS}."; return 1; }
  note "Ready, with only what an update needs."

  # ---------- 2. GitHub ----------
  say "2 of 3  Connecting Cloud Build to GitHub"
  gcloud services enable cloudbuild.googleapis.com secretmanager.googleapis.com run.googleapis.com artifactregistry.googleapis.com \
    --project "${PROJECT}" --quiet >/dev/null || { stop "Could not turn on Cloud Build."; return 1; }
  # Cloud Build keeps the GitHub app's token in Secret Manager, so its own agent may manage those secrets
  # (the agent is made on first use: make it now and try the grant a few times while it appears)
  gcloud beta services identity create --service=cloudbuild.googleapis.com --project "${PROJECT}" --quiet >/dev/null 2>&1 || true
  local granted=0 attempt
  for attempt in 1 2 3 4 5; do
    if gcloud projects add-iam-policy-binding "${PROJECT}" \
        --member "serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com" \
        --role roles/secretmanager.admin --condition=None --quiet >/dev/null 2>&1; then granted=1; break; fi
    sleep 10
  done
  [ "${granted}" -eq 1 ] || { stop "Could not let Cloud Build keep the GitHub token."; return 1; }
  if ! gcloud builds connections describe "${CONNECTION}" --region "${REGION}" --project "${PROJECT}" >/dev/null 2>&1; then
    gcloud builds connections create github "${CONNECTION}" --region "${REGION}" --project "${PROJECT}" --quiet >/dev/null 2>&1 \
      || { stop "Could not start the GitHub connection."; return 1; }
  fi
  local stage uri shown="" tries=0
  while :; do
    stage="$(gcloud builds connections describe "${CONNECTION}" --region "${REGION}" --project "${PROJECT}" --format='value(installationState.stage)' 2>/dev/null)"
    [ "${stage}" = "COMPLETE" ] && break
    # GitHub asks in two steps (sign in, then install the app): a new link is printed for each step
    if [ "${stage}" != "${shown}" ]; then
      shown="${stage}"
      uri="$(gcloud builds connections describe "${CONNECTION}" --region "${REGION}" --project "${PROJECT}" --format='value(installationState.actionUri)' 2>/dev/null)"
      note "Owner (${stage:-starting}): open this link, sign in to GitHub as khalednoun, and install Google Cloud Build on khalednoun/noun-art only:"
      printf '\n   %s\n\n' "${uri}"
      note "Waiting for it (up to 15 minutes)..."
    fi
    tries=$((tries + 1))
    [ "${tries}" -gt 90 ] && { stop "GitHub was not connected in 15 minutes. Run this again to get a new link."; return 1; }
    sleep 10
  done
  note "GitHub is connected."

  # ---------- 3. the repo and the trigger ----------
  say "3 of 3  The trigger ${TRIGGER} (main only, worker/ and src/lib/ only)"
  local REPO_PATH="projects/${PROJECT}/locations/${REGION}/connections/${CONNECTION}/repositories/${REPO_NAME}"
  if ! gcloud builds repositories describe "${REPO_NAME}" --connection "${CONNECTION}" --region "${REGION}" --project "${PROJECT}" >/dev/null 2>&1; then
    gcloud builds repositories create "${REPO_NAME}" --remote-uri "${REMOTE}" --connection "${CONNECTION}" \
      --region "${REGION}" --project "${PROJECT}" --quiet >/dev/null \
      || { stop "Could not link ${REMOTE}. Is the Google Cloud Build app installed on that repo?"; return 1; }
  fi
  if gcloud builds triggers describe "${TRIGGER}" --region "${REGION}" --project "${PROJECT}" >/dev/null 2>&1; then
    note "The trigger is already there."
  else
    gcloud builds triggers create github --name "${TRIGGER}" --region "${REGION}" --project "${PROJECT}" \
      --repository "${REPO_PATH}" --branch-pattern '^main$' \
      --included-files 'worker/**,src/lib/**' \
      --build-config worker/cloudbuild-deploy.yaml \
      --service-account "projects/${PROJECT}/serviceAccounts/${DEPLOYER}" \
      --description "Rebuild the Gemini reader and update the job ${JOB} on each push to main" --quiet >/dev/null \
      || { stop "Could not make the trigger."; return 1; }
    note "Made."
  fi

  say "Done. The reader now updates itself."
  note "Every push to main that changes worker/ or src/lib/ rebuilds it (about 3 minutes)."
  note "Branches and forks never deploy. A failed build leaves the reader as it was."
  note "To see the updates: console.cloud.google.com/cloud-build/builds (region ${REGION})."
  note "To run one now: gcloud builds triggers run ${TRIGGER} --region ${REGION} --branch main"
}

( art_reader_auto_update )
