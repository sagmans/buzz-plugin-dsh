// The DSH row of the app's agent settings, and its dialog: whether dsh is
// installed and answers, its version, its default model and its models, and
// whether each profile in use has dsh-acp-buzz/. Laid out as buzz-app's Goose type
// lays out its own (src/bundled/goose/tabs.tsx, Apache-2.0, see NOTICE), but
// read-only: dsh keeps its keys and default model in its own profile, and this
// plugin neither holds nor writes them. Adding the bundle changes a profile, so
// the dialog gives the exact command and leaves running it to the owner.
import { useEffect, useSyncExternalStore } from "react";
import { ProviderDialogActions } from "@app/features/agents/ProviderDialogActions";
import type { AgentProvider } from "@app/features/agents/service";
import { Button } from "@app/shared/design-system/ui/Button";
import { bundleCommand } from "./dsh";
import type { DshSetup } from "./setup";

/** What the row shows when the profile names no default model. */
const DEFAULT_MODEL_LABEL = "Profile default";
/** A catalog can list hundreds of models: the dialog scrolls them. As an inline
 * style, as the app's stylesheet has only the classes the app itself uses. */
const MODEL_LIST_STYLE = {
  maxHeight: 240,
  overflow: "auto",
  margin: 0,
} as const;

export function createProvider(setup: DshSetup): AgentProvider {
  /** Follows the check's state, so a new finding shows at once. */
  const useCheck = () =>
    useSyncExternalStore(setup.subscribe, setup.snapshot, setup.snapshot);

  /** Read-only: a button, as the app returns focus to the row's button. */
  function DefaultControl({ onConfigure }: { onConfigure(): void }) {
    useCheck();
    return (
      <Button size="sm" onClick={onConfigure}>
        {setup.status()?.defaultModel || DEFAULT_MODEL_LABEL}
      </Button>
    );
  }

  function DialogBody({ onClose }: { onClose(): void }) {
    const { readiness } = useCheck();
    const status = setup.status();
    const checking = readiness === "checking";
    // The app checks when its settings open; a dialog routed to directly may
    // open with no check started.
    useEffect(() => {
      if (!setup.status()) void setup.check();
    }, []);
    return (
      <div className="grid gap-4">
        {status ? (
          <>
            <p className="m-0 text-body-sm">
              Installed:{" "}
              {status.installed
                ? `Yes${status.version ? `, version ${status.version}` : ""}`
                : "No"}
            </p>
            <p className="m-0 text-body-sm">
              Reachable: {status.reachable ? "Yes" : "No"}
            </p>
            {status.defaultModel && (
              <p className="m-0 text-body-sm">
                Default model: {status.defaultModel}
              </p>
            )}
            {status.problem && <p role="alert">{status.problem}</p>}
            {status.profiles.map(({ profile, bundle }) => (
              <div className="grid gap-2" key={profile}>
                <p className="m-0 text-body-sm">
                  Profile {profile}: dsh-acp-buzz{" "}
                  {bundle ? "is present." : "is not added."}
                </p>
                {!bundle && (
                  <p className="m-0 text-body-sm text-subtle">
                    Without it, a message mid-turn waits for the next turn,
                    Compact does not work and no token use is recorded. Add it
                    with <code>{bundleCommand(profile)}</code>
                  </p>
                )}
              </div>
            ))}
            {status.models.length > 0 && (
              <div className="grid gap-2">
                <p className="m-0 text-body-sm">
                  Models: {status.models.length}
                </p>
                <ul className="text-body-sm" style={MODEL_LIST_STYLE}>
                  {status.models.map(({ id, label }) => (
                    <li key={id}>{label}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p role="status">Checking dsh…</p>
        )}
        <p className="m-0 text-body-sm text-subtle">
          dsh keeps its own keys and default model in each profile. Change them
          in the profile, with dsh itself.
        </p>
        <ProviderDialogActions>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            disabled={checking}
            loading={checking}
            onClick={() => void setup.check()}
          >
            Check again
          </Button>
        </ProviderDialogActions>
      </div>
    );
  }

  return {
    snapshot: setup.snapshot,
    subscribe: setup.subscribe,
    check: setup.check,
    DialogBody,
    DefaultControl,
  };
}
