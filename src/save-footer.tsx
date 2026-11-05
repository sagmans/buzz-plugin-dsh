// Puts the Settings tab's Save action in the agent panel's sticky footer, as
// the app's own agents have it. The app gives its footer slot to its own
// views through a React context that a plugin cannot reach: this bundle has
// its own copy of that context. So the plugin finds the same slot in the page
// and gives it to the bundled `AgentSaveButton` through the bundled context.
// The slot's class name is a content hash, the same in the app's build of the
// pinned buzz-app revision. Where no slot is found (another host screen, a
// changed app), the Save action stays inline below the form, as buzz-app's
// own `AgentSaveButton` does without a footer.
import { type ReactNode, useLayoutEffect, useMemo, useState } from "react";
import pageStyles from "@app/bundled/agents/AgentsPage.module.css";
import { AgentSaveFooter } from "@app/features/agents/AgentSaveButton";

/** The footer slot that buzz-app's agent panel (AgentDetails) renders. */
const SLOT_CLASS = pageStyles.saveFooter;

/** The panel's footer slot nearest to the form, or null. */
function findSlot(form: string): HTMLElement | null {
  if (!SLOT_CLASS) return null;
  const slot = `.${CSS.escape(SLOT_CLASS)}`;
  let node = document.getElementById(form)?.parentElement ?? null;
  while (node && !node.querySelector(slot)) node = node.parentElement;
  return node?.querySelector<HTMLElement>(slot) ?? null;
}

/** Gives the panel's footer slot to the `AgentSaveButton` of `form`. */
export function PanelSaveFooter({
  form,
  children,
}: {
  /** The id of the settings form, which sits inside the panel. */
  form: string;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  // Before paint, so a visible Save action never shows inline first.
  useLayoutEffect(() => setTarget(findSlot(form)), [form]);
  const footer = useMemo(() => (target ? { target } : null), [target]);
  return <AgentSaveFooter value={footer}>{children}</AgentSaveFooter>;
}
