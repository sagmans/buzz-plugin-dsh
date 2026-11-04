// The DSH agent type's parts of the app's screens: the New agent dialog and
// the Settings tab. They are built from the app's own components
// (ModelPicker, AgentInstructions, the design system), bundled unchanged from
// the pinned buzz-app clone, and laid out as buzz-app's Goose type lays out
// its own (src/bundled/goose/tabs.tsx), so a DSH agent looks like the app's
// own agents. `src/react-host.js` makes them render with Buzz's React.
// Written with `createElement`, not JSX, so the repository checks (node
// --check, lizard, semgrep) read this file as they read src/plugin.js.
import { createElement as h, Fragment, useEffect, useId, useRef, useState } from "react";
import { AgentInstructions } from "@buzz/features/agents/AgentInstructions";
import { AgentSaveButton } from "@buzz/features/agents/AgentSaveButton";
import { ModelPicker } from "@buzz/features/agents/ModelPicker";
import { DeepSeekLogoIcon } from "@buzz/shared/design-system/icons";
import { Field } from "@buzz/shared/design-system/ui/Field";
import { Input } from "@buzz/shared/design-system/ui/Input";
import { Select } from "@buzz/shared/design-system/ui/Select";
import { SettingsGroup } from "@buzz/shared/design-system/ui/SettingsGroup";
import { config as readConfig, DEFAULT_CONFIG, EFFORTS, modelLabel, PROFILE_RE, validWorkspace } from "./config.js";
import { PanelSaveFooter } from "./save-footer.js";

// The type's icon: the DeepSeek mark that Buzz itself ships for DeepSeek.
export { DeepSeekLogoIcon };

/** The empty model choice: the dsh profile picks the model. */
const DEFAULT_MODEL_LABEL = "DSH default";
const RESET_LABEL = "Use DSH default";
const CREATE_MODEL_LABEL = "DSH model";
/** The empty thinking level: the dsh profile picks it. */
const DEFAULT_EFFORT_LABEL = "Automatic";
/** The harness mark beside the model on a library card, as Goose sizes it. */
const CARD_ICON_SIZE = 18;
const WORKSPACE_HELP =
  "The folder DSH works in. Use ~/ for your home folder. DSH reads, writes and runs commands there as you, with no approval step.";
const WORKSPACE_ERROR = "Enter an absolute or ~/… workspace path.";
const PROFILE_HELP = "The dsh profile the agent runs: its provider, models and tools.";
const PROFILE_ERROR = "Enter a profile name: lowercase letters, digits, - or _.";
/** dsh's levels, named as the app names a goose level. */
const LEVELS = EFFORTS.filter(Boolean);

const message = (error) => (error instanceof Error ? error.message : String(error));
const named = (level) => level.charAt(0).toUpperCase() + level.slice(1);

/** The levels a model offers in the picker's menu: dsh's, for every model. */
const loadEfforts = async () => [
  { id: "", label: DEFAULT_EFFORT_LABEL },
  ...LEVELS.map((id) => ({ id, label: named(id) })),
];

/** A draft to save, or an error for a value dsh cannot start with. */
function checked(draft) {
  const profile = draft.profile.trim();
  const workspace = draft.workspace.trim() || DEFAULT_CONFIG.workspace;
  if (!PROFILE_RE.test(profile)) throw new Error(PROFILE_ERROR);
  if (!validWorkspace(workspace)) throw new Error(WORKSPACE_ERROR);
  return { ...draft, profile, workspace, model: draft.model.trim() };
}

export function createViews(runtime) {
  /** dsh's models as the picker lists them. dsh lists them when a session
   * opens, so the list is empty until the first one; a model can still be
   * typed. A saved model that dsh does not list stays shown, by its name. */
  function useChoices(value) {
    const [catalog, setCatalog] = useState(runtime.catalog);
    useEffect(() => runtime.subscribe(() => setCatalog(runtime.catalog)), []);
    const choices = catalog.map((item) => ({ id: item.value, label: item.name || modelLabel(item.value), loadEfforts }));
    if (value && !catalog.some((item) => item.value === value))
      choices.unshift({ id: value, label: modelLabel(value), loadEfforts });
    return choices;
  }

  /** The instructions a new agent starts with. */
  function Create({ config, onChange, disabled }) {
    const current = readConfig(config);
    return h(AgentInstructions, {
      creation: true,
      value: current.instructions,
      disabled,
      onChange: (instructions) => onChange({ ...current, instructions }),
    });
  }

  /** The model row of the New agent dialog and of a library card. A card's
   * chip keeps its room for the model name; its menu still sets the level. */
  function CreateModel({ config, onChange, disabled, modelAppearance }) {
    const current = readConfig(config);
    const choices = useChoices(current.model);
    return h(ModelPicker, {
      compact: true,
      groupByFamily: true,
      includeDefault: false,
      resetLabel: RESET_LABEL,
      allowCustomModel: true,
      label: CREATE_MODEL_LABEL,
      appearance: modelAppearance ?? "outlined",
      // A card names its harness before the model, as Goose's does.
      ...(modelAppearance && { leading: h(DeepSeekLogoIcon, { size: CARD_ICON_SIZE }) }),
      models: choices,
      value: current.model,
      defaultLabel: DEFAULT_MODEL_LABEL,
      effort: current.effort,
      // Only where a model row can change it, as Goose shows it only where
      // the model offers levels.
      effortLabel: modelAppearance || !choices.length ? undefined : named(current.effort || DEFAULT_EFFORT_LABEL),
      disabled,
      onChange: (model) => onChange({ ...current, model }),
      onEffortChange: (model, effort) => onChange({ ...current, model, effort }),
    });
  }

  /** The model row of the Settings tab. */
  function ModelField({ value, onChange }) {
    const choices = useChoices(value);
    return h(ModelPicker, {
      groupByFamily: true,
      label: "Model",
      allowCustomModel: true,
      models: choices,
      value,
      defaultLabel: DEFAULT_MODEL_LABEL,
      onChange,
    });
  }

  /** The thinking level turns run on, as the Goose type's Thinking row. */
  function ThinkingField({ value, onChange }) {
    const options = [
      { value: "", label: `${DEFAULT_EFFORT_LABEL} · Default` },
      ...LEVELS.map((level) => ({ value: level, label: named(level) })),
    ];
    return h(Select, {
      label: "Thinking",
      variant: "preference",
      value,
      ...(!value && { valueLabel: DEFAULT_EFFORT_LABEL }),
      groups: [{ label: "", options }],
      onValueChange: onChange,
    });
  }

  /** Who the agent is: the type, model, thinking level and instructions. */
  function IdentityFields({ draft, setDraft, typeControl }) {
    return h(
      Fragment,
      null,
      h(
        SettingsGroup,
        null,
        typeControl,
        h(ModelField, { value: draft.model, onChange: (model) => setDraft({ ...draft, model }) }),
        h(ThinkingField, { value: draft.effort, onChange: (effort) => setDraft({ ...draft, effort }) }),
      ),
      h(AgentInstructions, {
        value: draft.instructions,
        disabled: false,
        onChange: (instructions) => setDraft({ ...draft, instructions }),
      }),
    );
  }

  /** Where and how the agent runs: its workspace and dsh profile. Every
   * conversation thread is one session, so there is no Sessions choice. */
  function RuntimeFields({ draft, setDraft }) {
    const text = (key) => ({ value: draft[key], onValueChange: (next) => setDraft({ ...draft, [key]: next }) });
    return h(
      Fragment,
      null,
      h(Field, { label: "Workspace", description: WORKSPACE_HELP }, h(Input, text("workspace"))),
      h(Field, { label: "Profile", description: PROFILE_HELP }, h(Input, text("profile"))),
    );
  }

  /** A save that reports its error in the form, focused for screen readers. */
  function useSave(save, saved) {
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const errorRef = useRef(null);
    useEffect(() => {
      if (error) errorRef.current?.focus();
    }, [error]);
    const submit = async (draft) => {
      setSaving(true);
      setError("");
      try {
        // The whole config, so fields other views keep are not erased.
        await save({ ...saved, ...checked(draft) });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    const alert = error ? h("p", { ref: errorRef, tabIndex: -1, role: "alert", className: "buzz-field-error" }, error) : null;
    return { saving, alert, submit };
  }

  /** Every setting of a DSH agent, saved together. Model and thinking level
   * reach open sessions on their next turn; the rest, new sessions. */
  function SettingsTab({ agent, save, settingsHost, settingsSection, settingsContent }) {
    const form = useId();
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const { saving, alert, submit } = useSave(save, agent.config);
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const onSubmit = (event) => {
      event.preventDefault();
      void submit(draft);
    };
    return h(
      PanelSaveFooter,
      { form },
      h(
        "form",
        { id: form, className: "grid gap-4 [container-type:inline-size]", onSubmit },
        alert,
        settingsSection !== "runtime" &&
          h(IdentityFields, { draft, setDraft, typeControl: settingsHost?.typeControl?.(configChanged) }),
        settingsSection !== "identity" && h(RuntimeFields, { draft, setDraft }),
        h(AgentSaveButton, { form, saving, disabled: !changed }),
        settingsSection !== "identity" && settingsContent,
      ),
    );
  }

  return { Create, CreateModel, SettingsTab };
}
