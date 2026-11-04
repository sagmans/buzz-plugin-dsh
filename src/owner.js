// Who may start a DSH turn with a mention: the same rule as Buzz's own agents.
//
// Why: dsh runs shell and file tools with the user's own access, so a mention
// must carry the owner's authority. Buzz's bundled harnesses (Pi, Goose,
// Claude) admit a mention through `fromOwner` in buzz-app
// (src/features/agents/owner-attestation.ts): the owner's own event, or an
// event from another agent whose NIP-OA `auth` tag the owner signed. An
// installed plugin cannot import that module, so this file carries a copy of
// its owner and sibling checks, with the same tag shape, clause rules and
// signature input.
//
// Not copied: Buzz's relay-workflow path. It needs the app's own proof that
// the relay admitted the event (`hasEventProof`), which an installed plugin
// cannot read, so a workflow mention fails closed here.
//
// Adapted from buzz-app (Apache-2.0), src/features/agents/owner-attestation.ts
// at revision 8ad1132677ead08d346e4f381522c7297baf0dd7. See NOTICE.

import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/curves/utils.js";

const KEY = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;
const CLAUSE = /^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/;
const AUTH_TAG = "auth";
const AUTH_TAG_LENGTH = 4;
// NIP-OA binds the owner's signature to this agent key and these conditions.
const AUTH_PREFIX = "nostr:agent-auth:";
const MAX_KIND = 65535;
const MAX_TIME = 4294967295;

/** True when the event carries the owner's authority: the owner wrote it, or
 * an agent the owner attested for it (NIP-OA) did. */
export async function fromOwner(event, owner) {
  if (!owner || !KEY.test(owner)) return false;
  if (event.pubkey === owner) return true;
  return (await attestedOwner(event)) === owner;
}

/** NIP-OA owner of an event, or undefined. Provenance only: the event stays
 * authored by `event.pubkey`; the owner is never an author. */
export async function attestedOwner(event) {
  const [tag, ...extra] = (event.tags ?? []).filter((entry) => entry[0] === AUTH_TAG);
  if (!tag || extra.length || !satisfied(tag[2] ?? "", event)) return undefined;
  return authTagOwner(event.pubkey, tag);
}

/** Exact tag shape, clause syntax, target binding and signature. */
async function authTagOwner(target, tag) {
  const [name, owner, conditions, sig] = tag;
  if (
    name !== AUTH_TAG ||
    tag.length !== AUTH_TAG_LENGTH ||
    !owner ||
    conditions === undefined ||
    !sig ||
    !KEY.test(owner) ||
    !SIG.test(sig) ||
    owner === target ||
    !validConditions(conditions)
  )
    return undefined;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${AUTH_PREFIX}${target}:${conditions}`));
    return schnorr.verify(hexToBytes(sig), new Uint8Array(digest), hexToBytes(owner)) ? owner : undefined;
  } catch {
    // A malformed key or signature is no attestation, never an error.
    return undefined;
  }
}

function validConditions(conditions) {
  return (
    conditions === "" ||
    conditions.split("&").every((clause) => {
      const [, name, digits] = CLAUSE.exec(clause) ?? [];
      if (!name || !digits) return false;
      return Number(digits) <= (name === "kind=" ? MAX_KIND : MAX_TIME);
    })
  );
}

function satisfied(conditions, event) {
  if (!validConditions(conditions)) return false;
  if (conditions === "") return true;
  return conditions.split("&").every((clause) => {
    const [, name, digits] = CLAUSE.exec(clause) ?? [];
    const value = Number(digits);
    if (name === "kind=") return event.kind === value;
    return name === "created_at<" ? event.created_at < value : event.created_at > value;
  });
}
