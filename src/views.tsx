// The DSH agent type's parts of the app's screens: the New agent dialog and
// the Settings tab. They are built from the app's own components (ModelPicker,
// AgentInstructions, the design system), bundled unchanged from the pinned
// buzz-app clone, and laid out as buzz-app's Goose type lays out its own
// (src/bundled/goose/tabs.tsx, Apache-2.0, see NOTICE), so a DSH agent looks
// like the app's own agents. `src/react-host.ts` makes them render with Buzz's
// React.
import { useEffect, useId, useRef, useState } from "react";
import { AgentInstructions } from "@app/features/agents/AgentInstructions";
import { AgentSaveButton } from "@app/features/agents/AgentSaveButton";
import { ModelDiscoveryRecovery } from "@app/features/agents/ModelDiscoveryRecovery";
import {
  type ModelChoice,
  ModelPicker,
} from "@app/features/agents/ModelPicker";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "@app/features/agents/service";
import { DeepSeekLogoIcon } from "@app/shared/design-system/icons";
import { Field } from "@app/shared/design-system/ui/Field";
import { Input } from "@app/shared/design-system/ui/Input";
import { Select } from "@app/shared/design-system/ui/Select";
import { SettingsGroup } from "@app/shared/design-system/ui/SettingsGroup";
import {
  DEFAULT_CONFIG,
  type DshConfig,
  dshConfig,
  EFFORTS,
  PROFILE_RE,
  WORKSPACE_RE,
} from "./profiles";
import { PanelSaveFooter } from "./save-footer";
import type { Discovery, DshSetup } from "./setup";

/** The empty model choice: the profile's own config picks the model. */
const DEFAULT_MODEL_LABEL = "Profile default";
const RESET_LABEL = "Use the profile's default";
const CREATE_MODEL_LABEL = "dsh model";
/** The harness mark beside the model on a library card, as Goose sizes it. */
const CARD_ICON_SIZE = 18;
const SCOPES = [
  {
    label: "",
    options: [
      { value: "thread", label: "One session per thread" },
      { value: "channel", label: "One session per channel" },
    ],
  },
];
const WORKSPACE_HELP = "The folder dsh works in. Use ~/ for your home folder.";
const WORKSPACE_ERROR = "Enter an absolute or ~/… workspace path.";
const PROFILE_HELP =
  "The dsh profile this agent runs on: its models, keys and tools.";
const PROFILE_ERROR =
  "A profile name has lowercase letters, digits, - and _, and starts with a letter or digit.";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** A workspace to save, or an error for one dsh cannot work in. */
export function workspaceOf(value: string): string {
  const workspace = value.trim() || DEFAULT_CONFIG.workspace;
  if (!WORKSPACE_RE.test(workspace)) throw new Error(WORKSPACE_ERROR);
  return workspace;
}

/** A profile to save, or an error for one that is not a valid name. It becomes
 * a process argument, so a value is never saved past this check. */
export function profileOf(value: string): string {
  const profile = value.trim() || DEFAULT_CONFIG.profile;
  if (!PROFILE_RE.test(profile)) throw new Error(PROFILE_ERROR);
  return profile;
}

/** The model the profile's config picks, so the default choice shows that
 * model's name, as the app's Goose type shows its provider's. */
const defaultModel = (discovery: Discovery | undefined) =>
  discovery?.current ? { defaultModel: discovery.current } : {};

const named = (level: string) =>
  level ? level.charAt(0).toUpperCase() + level.slice(1) : "";

type Read =
  | { status: "loading"; value?: Discovery }
  | { status: "ready"; value: Discovery }
  | { status: "error"; error: string; value?: Discovery };

export function createViews(setup: DshSetup) {
  /** The models of `profile` as the picker lists them, read on first use;
   * `retry` reads them anew, after a dsh setup change. A shown list stays
   * while it is read again. (As buzz-app's Goose tabs read goose's lists.) */
  function useChoices(profile: string) {
    const [list, setList] = useState<Read>({ status: "loading" });
    const [round, setRound] = useState(0);
    useEffect(() => {
      let live = true;
      const kept = (prior: Read) =>
        prior.value === undefined ? {} : { value: prior.value };
      setList((prior) => ({ status: "loading", ...kept(prior) }));
      setup.models(profile, round > 0).then(
        (value) => live && setList({ status: "ready", value }),
        (reason: unknown) =>
          live &&
          setList((prior) => ({
            status: "error",
            error: message(reason),
            ...kept(prior),
          })),
      );
      return () => {
        live = false;
      };
    }, [profile, round]);
    const choices: ModelChoice[] = (list.value?.models ?? []).map(
      ({ id, label }) => ({ id, label }),
    );
    return { list, retry: () => setRound((value) => value + 1), choices };
  }

  /** The instructions a new agent starts with. */
  function Create({ config, onChange, disabled }: AgentCreateProps<DshConfig>) {
    const current = dshConfig(config);
    return (
      <AgentInstructions
        creation
        value={current.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...current, instructions })}
      />
    );
  }

  /** The model row of the New agent dialog and of a library card. */
  function CreateModel({
    config,
    onChange,
    disabled,
    modelAppearance,
  }: AgentCreateProps<DshConfig>) {
    const current = dshConfig(config);
    const { list, retry, choices } = useChoices(current.profile);
    return (
      <ModelDiscoveryRecovery
        error={list.status === "error" ? list.error : undefined}
        loading={list.status === "loading"}
        retry={retry}
        disabled={disabled}
      >
        <ModelPicker
          compact
          includeDefault={false}
          resetLabel={RESET_LABEL}
          label={CREATE_MODEL_LABEL}
          appearance={modelAppearance ?? "outlined"}
          // A card names its harness before the model, as Goose's does.
          {...(modelAppearance && {
            leading: <DeepSeekLogoIcon size={CARD_ICON_SIZE} />,
          })}
          models={choices}
          value={current.model}
          defaultLabel={DEFAULT_MODEL_LABEL}
          {...defaultModel(list.value)}
          disabled={disabled}
          loading={list.status === "loading"}
          onChange={(model) => onChange({ ...current, model })}
        />
      </ModelDiscoveryRecovery>
    );
  }

  /** The model and effort rows of the Settings tab. A saved model that dsh no
   * longer lists stays shown, to keep or change. The list is the saved
   * profile's: reading one per keystroke would start a process for each. */
  function ModelFields({
    profile,
    draft,
    setDraft,
  }: Readonly<{
    profile: string;
    draft: DshConfig;
    setDraft(config: DshConfig): void;
  }>) {
    const { list, choices } = useChoices(profile);
    const shown = draft.model || list.value?.current;
    const offered = list.value?.models.find(({ id }) => id === shown)?.efforts;
    // Before a read, or for a model not listed, dsh's own names still save.
    const levels = offered?.length ? offered : EFFORTS.filter(Boolean);
    const fallback = named(list.value?.currentEffort ?? "") || "Automatic";
    return (
      <>
        <ModelPicker
          label="Model"
          models={choices}
          loading={list.status === "loading"}
          value={draft.model}
          defaultLabel={DEFAULT_MODEL_LABEL}
          {...defaultModel(list.value)}
          {...(list.status === "error"
            ? { description: `Could not list models: ${list.error}` }
            : {})}
          onChange={(model) => setDraft({ ...draft, model })}
        />
        <Select
          label="Reasoning effort"
          variant="preference"
          value={draft.effort}
          {...(!draft.effort ? { valueLabel: fallback } : {})}
          groups={[
            {
              label: "",
              options: [
                { value: "", label: `${fallback} · Default` },
                ...(draft.effort && !levels.includes(draft.effort)
                  ? [
                      {
                        value: draft.effort,
                        label: `${named(draft.effort)} (unavailable)`,
                      },
                    ]
                  : []),
                ...levels.map((value) => ({ value, label: named(value) })),
              ],
            },
          ]}
          onValueChange={(effort) => setDraft({ ...draft, effort })}
        />
      </>
    );
  }

  /** Where and how a DSH agent works: the Settings tab's runtime part. */
  function RuntimeFields({
    draft,
    setDraft,
  }: Readonly<{ draft: DshConfig; setDraft(config: DshConfig): void }>) {
    return (
      <>
        <Field label="dsh profile" description={PROFILE_HELP}>
          <Input
            value={draft.profile}
            onValueChange={(profile) => setDraft({ ...draft, profile })}
          />
        </Field>
        <Field label="Workspace" description={WORKSPACE_HELP}>
          <Input
            value={draft.workspace}
            onValueChange={(workspace) => setDraft({ ...draft, workspace })}
          />
        </Field>
        <Select
          label="Sessions"
          variant="preference"
          value={draft.scope}
          groups={SCOPES}
          onValueChange={(value) =>
            setDraft({
              ...draft,
              scope: value === "channel" ? "channel" : "thread",
            })
          }
        />
      </>
    );
  }

  /** Every setting of a DSH agent, saved together. */
  function SettingsTab({
    agent,
    save,
    settingsHost,
    settingsSection,
    settingsContent,
  }: AgentViewProps<DshConfig>) {
    const form = useId();
    const saved = dshConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const saveErrorRef = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
      if (error) saveErrorRef.current?.focus();
    }, [error]);
    const configChanged = JSON.stringify(draft) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const submit = async () => {
      setSaving(true);
      setError("");
      try {
        await save({
          ...draft,
          // dsh's model values carry their provider.
          provider: "",
          model: draft.model.trim(),
          profile: profileOf(draft.profile),
          workspace: workspaceOf(draft.workspace),
        });
      } catch (reason) {
        setError(message(reason));
      } finally {
        setSaving(false);
      }
    };
    return (
      <PanelSaveFooter form={form}>
        <form
          id={form}
          className="grid gap-4 [container-type:inline-size]"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error && (
            <p
              ref={saveErrorRef}
              tabIndex={-1}
              role="alert"
              className="buzz-field-error"
            >
              {error}
            </p>
          )}
          {settingsSection !== "runtime" && (
            <>
              <SettingsGroup>
                {settingsHost?.typeControl?.(configChanged)}
                <ModelFields
                  profile={saved.profile}
                  draft={draft}
                  setDraft={setDraft}
                />
              </SettingsGroup>
              <AgentInstructions
                value={draft.instructions}
                disabled={false}
                onChange={(instructions) =>
                  setDraft({ ...draft, instructions })
                }
              />
            </>
          )}
          {settingsSection !== "identity" && (
            <RuntimeFields draft={draft} setDraft={setDraft} />
          )}
          <AgentSaveButton form={form} saving={saving} disabled={!changed} />
          {settingsSection !== "identity" && settingsContent}
        </form>
      </PanelSaveFooter>
    );
  }

  return { Create, CreateModel, SettingsTab };
}
