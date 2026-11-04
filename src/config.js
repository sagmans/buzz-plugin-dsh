// A DSH agent's saved settings: the one place that defines their fields,
// defaults and valid values. The agent runtime (src/plugin.js) reads a saved
// config through `config()` before it starts a process, and the Settings
// views (src/views.js) check a draft against the same rules before they save,
// so the two can never disagree on what a valid config is.

// A profile name becomes a process argument: never let it look like a flag.
export const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** dsh's reasoning levels; "" lets the profile pick. */
export const EFFORTS = ["", "off", "low", "high", "max"];
/** The longest model value kept: an ACP select value, never free text. */
const MODEL_MAX = 512;
export const DEFAULT_CONFIG = Object.freeze({
  profile: "acp",
  model: "",
  effort: "",
  instructions: "",
  workspace: "~/dsh-agents",
});

/** A workspace dsh can start in: absolute, or in the home folder. */
export const validWorkspace = (value) => value.startsWith("/") || value.startsWith("~/");

/** A saved config with every field present and each field valid. */
export function config(value) {
  const raw = value && typeof value === "object" ? value : {};
  const pick = (key, ok) => (typeof raw[key] === "string" && ok(raw[key]) ? raw[key] : DEFAULT_CONFIG[key]);
  return {
    profile: pick("profile", (v) => PROFILE_RE.test(v)),
    model: pick("model", (v) => v.length <= MODEL_MAX),
    effort: pick("effort", (v) => EFFORTS.includes(v)),
    instructions: pick("instructions", () => true),
    workspace: pick("workspace", validWorkspace),
  };
}

/** The model's display name inside an ACP select value such as `["provider","model"]`. */
export function modelLabel(value) {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((part) => typeof part === "string").join(" · ");
  } catch {
    // Not JSON: the value is shown as the user wrote it.
  }
  return value;
}
