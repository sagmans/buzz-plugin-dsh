#!/usr/bin/env node
// Copies the model catalog of the desktop dsh profile into the Buzz profile.
//
// Why: Buzz agents run on a separate dsh profile. Without this sync, a model
// added to the desktop profile is absent from Buzz, and the app's picker shows
// a stale catalog. The script copies only the `llm-pi-ai` provider row: the
// Buzz bundle, upload switches, compaction budget and ACP default stay local.
//
// Usage:
//   scripts/sync-buzz-catalog.mjs [--dsh-home DIR] [--profile NAME]
//     [--desktop-profile NAME] [--check] [--quiet]
//
// Exit codes: 0 synced/skipped, 1 invalid input or a different catalog with
// --check, 2 usage error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { parseDocument } from "yaml";

const EX_FAILED = 1;
const EX_USAGE = 2;
const ROW_ID = "llm-pi-ai";
const ACP_ROW_ID = "acp-buzz";
const DEFAULT_PROFILE = "buzz";
const DEFAULT_DESKTOP_PROFILE = "desktop";
const PROFILE_PATCH = "cordis.patch.yml";
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Provider config must name environment variables, never carry a key itself.
const INLINE_SECRET_KEYS = new Set([
  "apikey",
  "api_key",
  "key",
  "password",
  "secret",
  "token",
]);

function fail(message, code = EX_FAILED) {
  process.stderr.write(`sync-buzz-catalog: ${message}\n`);
  process.exit(code);
}

function usage() {
  process.stdout.write(`Usage: sync-buzz-catalog.mjs [options]

Options:
  --dsh-home DIR          dsh home folder (default: $DSH_HOME or ~/.dsh)
  --profile NAME          profile to update (default: ${DEFAULT_PROFILE})
  --desktop-profile NAME  profile that holds the catalog (default: ${DEFAULT_DESKTOP_PROFILE})
  --check                 report a difference and exit 1; write nothing
  --quiet                 print nothing when the profile is in sync
  -h, --help              show this help
`);
}

function parse() {
  const { values } = parseArgs({
    options: {
      "dsh-home": { type: "string" },
      profile: { type: "string", default: DEFAULT_PROFILE },
      "desktop-profile": {
        type: "string",
        default: DEFAULT_DESKTOP_PROFILE,
      },
      check: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  return values;
}

function profileName(value, flag) {
  if (!PROFILE_NAME_RE.test(value) || value === "." || value === "..") {
    fail(`${flag} is not a profile name: ${value}`, EX_USAGE);
  }
  return value;
}

function readDocument(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    fail(`cannot read ${label} ${file}: ${error.message}`);
  }
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    fail(`${label} ${file} is not valid YAML: ${doc.errors[0].message}`);
  }
  if (doc.contents === null) return null;
  if (doc.contents.constructor.name !== "YAMLSeq") {
    fail(`${label} ${file} must hold a YAML list of rows`);
  }
  return doc;
}

function rows(doc) {
  return doc.toJS();
}

function rowById(list, id) {
  return list.find((row) => row && typeof row === "object" && row.id === id);
}

function assertNoInlineSecrets(value, where) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoInlineSecrets(item, `${where}[${index}]`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (INLINE_SECRET_KEYS.has(key.toLowerCase())) {
      fail(`${where}.${key} holds a secret inline; use apiKeyEnv`);
    }
    assertNoInlineSecrets(item, `${where}.${key}`);
  }
}

function assertProvider(name, provider) {
  if (!PROFILE_NAME_RE.test(name)) {
    fail(`provider name is not valid: ${name}`);
  }
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    fail(`provider ${name} is not a map`);
  }
  if (typeof provider.apiKeyEnv !== "string" || !provider.apiKeyEnv) {
    fail(`provider ${name} has no apiKeyEnv`);
  }
}

function providersFrom(row) {
  const providers = row.config?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    fail(`the desktop '${ROW_ID}' row has no providers map`);
  }
  if (Object.keys(providers).length === 0) {
    fail(`the desktop '${ROW_ID}' row has no providers`);
  }
  assertNoInlineSecrets(providers, "providers");
  for (const [name, provider] of Object.entries(providers)) {
    assertProvider(name, provider);
  }
  return providers;
}

function catalogFrom(file) {
  const doc = readDocument(file, "desktop profile patch");
  if (!doc) {
    return null;
  }
  const list = rows(doc);
  const row = rowById(list, ROW_ID);
  if (!row) {
    fail(`desktop profile patch ${file} has no '${ROW_ID}' row`);
  }
  if (!row.name || typeof row.name !== "string") {
    fail(`the desktop '${ROW_ID}' row has no plugin name`);
  }
  return { name: row.name, providers: providersFrom(row) };
}

function assertAcpTarget(list, providers) {
  const row = rowById(list, ACP_ROW_ID);
  // A fresh profile gets its ACP row from the bundle. That bundle default is
  // not this profile's choice, so a catalog sync must not reject it.
  if (!row) return;
  const providerName = row.config?.provider;
  const modelName = row.config?.model;
  if (typeof providerName !== "string" || !providerName) {
    fail(`the '${ACP_ROW_ID}' row has no provider`);
  }
  if (!Object.hasOwn(providers, providerName)) {
    fail(
      `'${ACP_ROW_ID}' uses provider '${providerName}', which is absent from the desktop catalog`,
    );
  }
  if (typeof modelName !== "string" || !modelName) {
    fail(`the '${ACP_ROW_ID}' row has no model`);
  }
  const models = providers[providerName].models;
  if (
    Array.isArray(models) &&
    !models.some((model) => model?.id === modelName)
  ) {
    fail(
      `'${ACP_ROW_ID}' uses model '${modelName}', which provider '${providerName}' does not list`,
    );
  }
}

function pathsOf(options) {
  const dshHome =
    options["dsh-home"] ??
    process.env.DSH_HOME ??
    path.join(os.homedir(), ".dsh");
  const profile = profileName(options.profile, "--profile");
  const desktopProfile = profileName(
    options["desktop-profile"],
    "--desktop-profile",
  );
  return {
    desktopProfile,
    desktopFile: path.join(dshHome, "profiles", desktopProfile, PROFILE_PATCH),
    profileFile: path.join(dshHome, "profiles", profile, PROFILE_PATCH),
  };
}

function replaceRow(doc, index, row) {
  const previous = doc.contents.items[index];
  const replacement = doc.createNode(row);
  // Keep the owner's comment above the row: the catalog changes, the
  // reason written next to it does not.
  if (previous?.commentBefore) {
    replacement.commentBefore = previous.commentBefore;
  }
  if (previous?.comment) replacement.comment = previous.comment;
  if (previous?.spaceBefore) replacement.spaceBefore = previous.spaceBefore;
  doc.contents.items[index] = replacement;
}

function syncedDocument(profileFile, catalog) {
  const doc = readDocument(profileFile, "profile patch");
  if (!doc) {
    fail(`profile patch is empty: ${profileFile}`);
  }
  const before = doc.toString();
  const list = rows(doc);
  const current = rowById(list, ROW_ID);
  const nextRow = {
    ...current,
    id: ROW_ID,
    name: catalog.name,
    config: { providers: catalog.providers },
  };
  const index = list.findIndex((row) => row?.id === ROW_ID);
  if (index === -1) {
    doc.contents.add(doc.createNode(nextRow));
  } else {
    replaceRow(doc, index, nextRow);
  }
  assertAcpTarget(rows(doc), catalog.providers);
  return { before, after: doc.toString() };
}

function writeProfile(profileFile, after) {
  const tmp = `${profileFile}.tmp-${process.pid}`;
  const mode = fs.statSync(profileFile).mode;
  try {
    fs.writeFileSync(tmp, after, { mode });
    fs.renameSync(tmp, profileFile);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    fail(`cannot write ${profileFile}: ${error.message}`);
  }
}

function main() {
  const options = parse();
  if (options.help) {
    usage();
    return;
  }
  const { profileFile, desktopFile, desktopProfile } = pathsOf(options);
  if (!fs.existsSync(profileFile)) {
    fail(`profile patch does not exist: ${profileFile}`);
  }
  const catalog = catalogFrom(desktopFile);
  if (!catalog) {
    if (!options.quiet) {
      process.stdout.write(
        `no ${desktopProfile} profile at ${desktopFile}; catalog unchanged\n`,
      );
    }
    return;
  }
  const { before, after } = syncedDocument(profileFile, catalog);
  if (options.check && before !== after) {
    process.stdout.write(`${profileFile} is out of sync\n`);
    process.exit(EX_FAILED);
  }
  if (before === after) {
    if (!options.quiet) {
      process.stdout.write(`${profileFile} is in sync\n`);
    }
    return;
  }
  writeProfile(profileFile, after);
  if (!options.quiet) {
    process.stdout.write(
      `synced ${Object.keys(catalog.providers).length} provider(s) into ${profileFile}\n`,
    );
  }
}

main();
